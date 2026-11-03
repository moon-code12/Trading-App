// Administrator endpoints, mounted at /api/admin. Every route here sits behind requireAdmin, and every action
// (and every look at one user's private data) is written to the audit log with who did it, to what, and when.
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, publicUser } from './auth.js';
import { notify } from './db.js';
import { recordAudit, queryAudit } from './audit.js';
import { ASSETS, getAsset } from './market.js';
import { ASSET_STATUSES, createAsset, setAssetSpread, setAssetStatus } from './assetState.js';
import { defaultSpreadBps, paramsFor } from './simulation.js';
import { RISK_LEVELS } from './catalog.js';
import { SESSIONS } from './sessions.js';

const bad = (res, msg = 'Invalid input', status = 400) => res.status(status).json({ error: msg });
const DEMO_BALANCE = 10000;
const KYC_STATES = ['none', 'pending', 'approved', 'rejected'];
const ROLES = ['user', 'admin'];

// What an administrator sees of a user: never the password hash, TOTP secret or identity-document details.
export const adminUser = (u, now) => ({
  ...publicUser(u),
  suspended: !!u.suspended_at,
  suspendedAt: u.suspended_at ?? null,
  suspendedReason: u.suspended_reason ?? null,
  lockedUntil: u.locked_until && u.locked_until > now ? u.locked_until : null,
  createdAt: u.created_at,
});

// ---- CSV (cells that a spreadsheet could read as a formula are defused)

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v) : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export const toCsv = (head, rows) => `${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
const iso = (ms) => (ms === null || ms === undefined ? '' : new Date(ms).toISOString());

const page = (q, max = 200, dflt = 50) => {
  const limit = Math.min(max, Math.max(1, Number.parseInt(q.limit, 10) || dflt));
  const offset = Math.max(0, Number.parseInt(q.offset, 10) || 0);
  return { limit, offset };
};
const msParam = (v) => {
  if (v === undefined || v === '') return undefined;
  const t = /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const like = (s) => `%${String(s).trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function adminRouter(db, { now = Date.now, portfolio }) {
  const admin = Router();
  admin.use(requireAdmin);
  const audit = async (req, action, targetType, targetId, details) => await recordAudit(db, req, now(), { action, targetType, targetId, details });
  const userById = async (id) => (/^\d+$/.test(String(id)) ? await db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) : undefined);
  // Resolves :id to a user or ends the request with 404.
  admin.param('userId', async (req, res, next, id) => {
    req.target = await userById(id);
    return req.target ? next() : res.status(404).json({ error: 'User not found' });
  });

  // ---- Overview
  admin.get('/stats', async (_req, res) => {
    const n = async (sql, ...a) => (await db.prepare(sql).get(...a)).n;
    res.json({
      users: await n('SELECT COUNT(*) n FROM users'),
      suspendedUsers: await n('SELECT COUNT(*) n FROM users WHERE suspended_at IS NOT NULL'),
      orders: await n('SELECT COUNT(*) n FROM orders'),
      filledOrders: await n("SELECT COUNT(*) n FROM orders WHERE status = 'filled'"),
      pendingKyc: await n("SELECT COUNT(*) n FROM kyc_submissions WHERE status = 'pending'"),
      pendingWithdrawals: await n("SELECT COUNT(*) n FROM withdrawal_requests WHERE status = 'pending'"),
      failedLogins24h: await n('SELECT COUNT(*) n FROM login_events WHERE success = 0 AND created_at >= ?', now() - 24 * 3600e3),
    });
  });

  // ---- Users: search and filters
  admin.get('/users', async (req, res) => {
    const { q, role, kyc, status, verified, sort = 'id', order = 'desc' } = req.query;
    if (role !== undefined && !ROLES.includes(role)) return bad(res, 'Unknown role');
    if (kyc !== undefined && !KYC_STATES.includes(kyc)) return bad(res, 'Unknown KYC status');
    if (status !== undefined && !['active', 'suspended', 'locked'].includes(status)) return bad(res, 'Unknown status');
    if (verified !== undefined && !['true', 'false'].includes(verified)) return bad(res, 'verified must be true or false');
    const SORTS = { id: 'id', name: 'lower(name)', email: 'email', balance: 'balance', created: 'created_at' };
    if (!SORTS[sort] || !['asc', 'desc'].includes(order)) return bad(res, 'Unknown sort');
    const where = [];
    const args = [];
    if (q && String(q).trim()) {
      const term = String(q).trim();
      where.push("(lower(name) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\'" + (/^\d+$/.test(term) ? ' OR id = ?' : '') + ')');
      args.push(like(term.slice(0, 60)), like(term.slice(0, 60)));
      if (/^\d+$/.test(term)) args.push(Number(term));
    }
    if (role) { where.push('role = ?'); args.push(role); }
    if (kyc) { where.push('kyc_status = ?'); args.push(kyc); }
    if (verified) { where.push('email_verified = ?'); args.push(verified === 'true' ? 1 : 0); }
    if (status === 'suspended') where.push('suspended_at IS NOT NULL');
    if (status === 'active') where.push('suspended_at IS NULL');
    if (status === 'locked') { where.push('locked_until > ?'); args.push(now()); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { limit, offset } = page(req.query);
    const total = (await db.prepare(`SELECT COUNT(*) n FROM users ${clause}`).get(...args)).n;
    const rows = await db.prepare(`SELECT * FROM users ${clause} ORDER BY ${SORTS[sort]} ${order}, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json({ total, limit, offset, users: rows.map((u) => adminUser(u, now())) });
  });

  // ---- One user
  admin.get('/users/:userId', async (req, res) => {
    const u = req.target;
    const n = async (sql) => (await db.prepare(sql).get(u.id)).n;
    await audit(req, 'user.view', 'user', u.id, null);
    res.json({
      user: adminUser(u, now()),
      counts: {
        orders: await n('SELECT COUNT(*) n FROM orders WHERE user_id = ?'),
        openOrders: await n("SELECT COUNT(*) n FROM orders WHERE user_id = ? AND status IN ('pending', 'partially_filled')"),
        holdings: await n('SELECT COUNT(*) n FROM holdings WHERE user_id = ?'),
        transactions: await n('SELECT COUNT(*) n FROM transactions WHERE user_id = ?'),
        pendingWithdrawals: await n("SELECT COUNT(*) n FROM withdrawal_requests WHERE user_id = ? AND status = 'pending'"),
        activeSessions: (await db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?').get(u.id, now())).n,
      },
      recentLogins: (await db.prepare('SELECT success, reason, ip, device, created_at AS at FROM login_events WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(u.id)).map((e) => ({ ...e, success: !!e.success })),
      recentAdminActions: (await queryAudit(db, { targetType: 'user', targetId: u.id, limit: 10 })).entries,
    });
  });

  admin.get('/users/:userId/portfolio', async (req, res) => {
    await audit(req, 'user.portfolio.view', 'user', req.target.id, null);
    res.json(await portfolio(req.target));
  });

  admin.get('/users/:userId/orders', async (req, res) => {
    const { status } = req.query;
    const { limit, offset } = page(req.query);
    await audit(req, 'user.orders.view', 'user', req.target.id, status ? { status } : null);
    const rows = status
      ? await db.prepare('SELECT * FROM orders WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(req.target.id, status, limit, offset)
      : await db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(req.target.id, limit, offset);
    res.json({ orders: rows });
  });

  // ---- Suspend and restore
  const reasonSchema = z.object({ reason: z.string().trim().min(3).max(300) });

  admin.post('/users/:userId/suspend', async (req, res) => {
    const u = req.target;
    const p = reasonSchema.safeParse(req.body);
    if (!p.success) return bad(res, 'A reason of at least 3 characters is required');
    if (u.role === 'admin') return bad(res, 'Administrator accounts cannot be suspended', 409);
    if (u.suspended_at) return bad(res, 'This account is already suspended', 409);
    await db.prepare('UPDATE users SET suspended_at = ?, suspended_reason = ? WHERE id = ?').run(now(), p.data.reason, u.id);
    await notify(db, u.id, 'security', 'Your account has been suspended. You cannot trade or withdraw. Contact support for help.');
    await audit(req, 'user.suspend', 'user', u.id, { reason: p.data.reason });
    res.json({ user: adminUser(await userById(u.id), now()) });
  });

  admin.post('/users/:userId/restore', async (req, res) => {
    const u = req.target;
    if (!u.suspended_at) return bad(res, 'This account is not suspended', 409);
    await db.prepare('UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?').run(u.id);
    await notify(db, u.id, 'security', 'Your account has been restored. You can trade and withdraw again.');
    await audit(req, 'user.restore', 'user', u.id, { previousReason: u.suspended_reason });
    res.json({ user: adminUser(await userById(u.id), now()) });
  });

  // ---- Reset the demo balance. The change is recorded as a transaction so statements and analytics still add up.
  admin.post('/users/:userId/reset-balance', async (req, res) => {
    const u = req.target;
    const p = z.object({ amount: z.number().min(0).max(1e9).default(DEMO_BALANCE), reason: reasonSchema.shape.reason }).safeParse(req.body ?? {});
    if (!p.success) return bad(res, 'A reason of at least 3 characters is required, and the amount must be between 0 and 1,000,000,000');
    const target = Math.round(p.data.amount * 100) / 100;
    const delta = Math.round((target - u.balance) * 100) / 100;
    await db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(target, u.id);
    if (delta !== 0) {
      await db.prepare('INSERT INTO transactions (user_id, type, amount, note) VALUES (?, ?, ?, ?)')
        .run(u.id, delta > 0 ? 'deposit' : 'withdrawal', delta, 'Demo balance reset by an administrator');
    }
    await notify(db, u.id, 'wallet', `Your demo balance was reset to ${target.toFixed(2)}.`);
    await audit(req, 'user.reset_balance', 'user', u.id, { from: u.balance, to: target, reason: p.data.reason });
    res.json({ user: adminUser(await userById(u.id), now()) });
  });

  // ---- Orders across the platform
  admin.get('/orders', async (req, res) => {
    const where = [];
    const args = [];
    for (const [key, col] of [['status', 'status'], ['symbol', 'symbol'], ['userId', 'user_id']]) {
      if (req.query[key] !== undefined) { where.push(`${col} = ?`); args.push(key === 'symbol' ? String(req.query[key]).toUpperCase() : req.query[key]); }
    }
    const { limit, offset } = page(req.query, 500, 200);
    res.json({ orders: await db.prepare(`SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) });
  });

  // ---- Identity verification queue (the decision is logged; the submitted document details never are)
  admin.get('/kyc', async (_req, res) => {
    res.json({ submissions: await db.prepare("SELECT * FROM kyc_submissions WHERE status = 'pending' ORDER BY id").all() });
  });
  admin.post('/kyc/:id/:decision', async (req, res) => {
    const { id, decision } = req.params;
    if (!['approve', 'reject'].includes(decision)) return res.status(404).json({ error: 'Not found' });
    const s = await db.prepare("SELECT * FROM kyc_submissions WHERE id = ? AND status = 'pending'").get(id);
    if (!s) return res.status(404).json({ error: 'No pending submission' });
    const status = decision === 'approve' ? 'approved' : 'rejected';
    await db.prepare('UPDATE kyc_submissions SET status = ? WHERE id = ?').run(status, s.id);
    await db.prepare('UPDATE users SET kyc_status = ? WHERE id = ?').run(status, s.user_id);
    await notify(db, s.user_id, 'security', `Your identity verification was ${status}.`);
    await audit(req, `kyc.${decision}`, 'user', s.user_id, { submissionId: s.id });
    res.json({ ok: true });
  });

  // ---- Withdrawal requests. The money was set aside when the user asked; approving makes it final, rejecting returns it.
  const withdrawalRows = async (status, limit, offset) => (await db.prepare(`
    SELECT w.*, u.email, u.name, u.kyc_status, u.balance, u.suspended_at FROM withdrawal_requests w JOIN users u ON u.id = w.user_id
    ${status ? 'WHERE w.status = ?' : ''} ORDER BY w.id DESC LIMIT ? OFFSET ?`).all(...(status ? [status] : []), limit, offset))
    .map((w) => ({
      id: w.id, userId: w.user_id, email: w.email, name: w.name, amount: w.amount, status: w.status, createdAt: w.created_at,
      decidedAt: w.decided_at, decidedBy: w.decided_by, decisionNote: w.decision_note,
      kycStatus: w.kyc_status, balance: w.balance, userSuspended: !!w.suspended_at,
    }));

  admin.get('/withdrawals', async (req, res) => {
    const { status } = req.query;
    if (status !== undefined && !['pending', 'approved', 'rejected'].includes(status)) return bad(res, 'Unknown status');
    const { limit, offset } = page(req.query);
    res.json({ withdrawals: await withdrawalRows(status, limit, offset) });
  });

  const decideSchema = z.object({ note: z.string().trim().max(300).optional() });
  for (const decision of ['approve', 'reject']) {
    admin.post(`/withdrawals/:id/${decision}`, async (req, res) => {
      const p = decideSchema.safeParse(req.body ?? {});
      if (!p.success) return bad(res);
      const w = /^\d+$/.test(req.params.id) ? await db.prepare('SELECT * FROM withdrawal_requests WHERE id = ?').get(Number(req.params.id)) : undefined;
      if (!w) return res.status(404).json({ error: 'Withdrawal request not found' });
      if (w.status !== 'pending') return bad(res, `This request was already ${w.status}`, 409);
      const owner = await userById(w.user_id);
      if (decision === 'approve' && owner.suspended_at) return bad(res, 'This account is suspended, so the withdrawal cannot be approved. Restore the account or reject the request', 409);
      if (decision === 'reject' && !p.data.note) return bad(res, 'Say why the request is being rejected');
      const status = decision === 'approve' ? 'approved' : 'rejected';
      const claimed = (await db.prepare("UPDATE withdrawal_requests SET status = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ? AND status = 'pending'")
        .run(status, now(), req.user.id, p.data.note ?? null, w.id)).changes;
      if (!claimed) return bad(res, 'This request was already decided', 409);
      if (decision === 'reject') {
        await db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(w.amount, w.user_id);
        await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'deposit', ?, ?)").run(w.user_id, w.amount, `Withdrawal #${w.id} rejected, funds returned`);
      }
      await notify(db, w.user_id, 'wallet', decision === 'approve'
        ? `Your withdrawal of ${w.amount.toFixed(2)} was approved.`
        : `Your withdrawal of ${w.amount.toFixed(2)} was rejected and the funds were returned. Reason: ${p.data.note}`);
      await audit(req, `withdrawal.${decision}`, 'user', w.user_id, { withdrawalId: w.id, amount: w.amount, note: p.data.note ?? null });
      res.json({ ok: true, status });
    });
  }

  // ---- Failed sign-ins (including attempts on emails that have no account)
  const failedLogins = async (query) => {
    const { email, reason, since } = query;
    const where = ['e.success = 0'];
    const args = [];
    if (email) { where.push("lower(e.email) LIKE ? ESCAPE '\\'"); args.push(like(String(email).slice(0, 60))); }
    if (reason) { where.push('e.reason = ?'); args.push(String(reason)); }
    const from = msParam(since);
    if (from === null) return null;
    if (from !== undefined) { where.push('e.created_at >= ?'); args.push(from); }
    const { limit, offset } = page(query, 500, 100);
    const clause = where.join(' AND ');
    return {
      total: (await db.prepare(`SELECT COUNT(*) n FROM login_events e WHERE ${clause}`).get(...args)).n,
      attempts: (await db.prepare(`SELECT e.id, e.user_id AS userId, e.email, e.reason, e.ip, e.device, e.created_at AS at, u.locked_until AS lockedUntil
        FROM login_events e LEFT JOIN users u ON u.id = e.user_id WHERE ${clause}
        ORDER BY e.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset))
        .map((a) => ({ ...a, accountExists: a.userId !== null, lockedUntil: a.lockedUntil && a.lockedUntil > now() ? a.lockedUntil : null })),
    };
  };
  admin.get('/failed-logins', async (req, res) => {
    const out = await failedLogins(req.query);
    if (!out) return bad(res, 'since must be a date or a timestamp');
    await audit(req, 'failed_logins.view', 'login_events', null, { email: req.query.email ?? null, reason: req.query.reason ?? null });
    res.json(out);
  });

  // ---- Announcements (shown to every signed-in user)
  const announcementSchema = z.object({
    title: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(500),
    level: z.enum(['info', 'warning', 'critical']).default('info'),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  });
  const announcementRow = (a) => ({ id: a.id, title: a.title, message: a.message, level: a.level, active: !!a.active, createdBy: a.created_by, createdAt: a.created_at, expiresAt: a.expires_at });
  admin.get('/announcements', async (_req, res) => {
    res.json({ announcements: (await db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 100').all()).map(announcementRow) });
  });
  admin.post('/announcements', async (req, res) => {
    const p = announcementSchema.safeParse(req.body);
    if (!p.success) return bad(res, p.error.issues[0].message);
    const expires = p.data.expiresAt ? Date.parse(p.data.expiresAt) : null;
    if (expires !== null && expires <= now()) return bad(res, 'The expiry must be in the future');
    const id = Number((await db.prepare('INSERT INTO announcements (title, message, level, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.data.title, p.data.message, p.data.level, req.user.id, now(), expires)).lastInsertRowid);
    await audit(req, 'announcement.create', 'announcement', id, { title: p.data.title, level: p.data.level, expiresAt: expires ? iso(expires) : null });
    res.status(201).json({ announcement: announcementRow(await db.prepare('SELECT * FROM announcements WHERE id = ?').get(id)) });
  });
  admin.patch('/announcements/:id', async (req, res) => {
    const p = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!p.success) return bad(res);
    const a = /^\d+$/.test(req.params.id) ? await db.prepare('SELECT * FROM announcements WHERE id = ?').get(Number(req.params.id)) : undefined;
    if (!a) return res.status(404).json({ error: 'Announcement not found' });
    await db.prepare('UPDATE announcements SET active = ? WHERE id = ?').run(p.data.active ? 1 : 0, a.id);
    await audit(req, p.data.active ? 'announcement.activate' : 'announcement.deactivate', 'announcement', a.id, { title: a.title });
    res.json({ announcement: announcementRow(await db.prepare('SELECT * FROM announcements WHERE id = ?').get(a.id)) });
  });

  // ---- Simulated assets: add, pause, disable
  const custom = async () => new Set((await db.prepare('SELECT symbol FROM custom_assets').all()).map((r) => r.symbol));
  const assetRow = (a, isCustom) => ({
    symbol: a.symbol, name: a.name, category: a.category, base: a.base, liquidity: a.liquidity, risk: a.risk, volume: a.volume,
    session: a.session, status: a.status ?? 'active', custom: isCustom,
    spreadBps: paramsFor(a).spreadBps, defaultSpreadBps: defaultSpreadBps(a), spreadOverridden: typeof a.spreadBps === 'number',
    quantityRules: paramsFor(a).qty,
  });
  admin.get('/assets', async (_req, res) => {
    const c = await custom();
    res.json({ assets: ASSETS.map((a) => assetRow(a, c.has(a.symbol))), statuses: ASSET_STATUSES, risks: RISK_LEVELS, sessions: Object.keys(SESSIONS) });
  });
  const newAsset = z.object({
    symbol: z.string().trim().toUpperCase(),
    name: z.string().trim().min(1).max(60),
    category: z.string().trim().toLowerCase(),
    base: z.number(), liquidity: z.number(), volume: z.number(),
    risk: z.string(), session: z.string(),
  });
  admin.post('/assets', async (req, res) => {
    const p = newAsset.safeParse(req.body);
    if (!p.success) return bad(res, 'Invalid asset: symbol, name, category, base, liquidity, volume, risk and session are all required');
    let asset;
    try { asset = await createAsset(db, p.data, now(), req.user.id); } catch (e) { return bad(res, e.message.replace(/^Asset [^:]*: /, '')); }
    await audit(req, 'asset.create', 'asset', asset.symbol, { name: asset.name, category: asset.category, base: asset.base, risk: asset.risk, session: asset.session });
    res.status(201).json({ asset: assetRow(asset, true) });
  });
  admin.patch('/assets/:symbol', async (req, res) => {
    const p = z.object({
      status: z.enum(ASSET_STATUSES).optional(),
      spreadBps: z.number().min(0).max(1000).nullable().optional(), // null puts back the profile's default
      reason: z.string().trim().max(300).optional(),
    }).safeParse(req.body);
    if (!p.success || (p.data.status === undefined && p.data.spreadBps === undefined)) {
      return bad(res, `Send a status (${ASSET_STATUSES.join(', ')}) and/or a spreadBps from 0 to 1000 (or null for the default)`);
    }
    const asset = getAsset(req.params.symbol.toUpperCase());
    if (!asset) return res.status(404).json({ error: 'Unknown asset' });
    const from = asset.status ?? 'active';
    if (p.data.status !== undefined && p.data.status === from && p.data.spreadBps === undefined) return bad(res, `${asset.symbol} is already ${from}`, 409);
    if (p.data.status !== undefined && p.data.status !== from) {
      await setAssetStatus(db, asset, p.data.status, now(), req.user.id);
      await audit(req, 'asset.status', 'asset', asset.symbol, { from, to: p.data.status, reason: p.data.reason ?? null });
    }
    if (p.data.spreadBps !== undefined) {
      const before = paramsFor(asset).spreadBps;
      await setAssetSpread(db, asset, p.data.spreadBps, now(), req.user.id);
      await audit(req, 'asset.spread', 'asset', asset.symbol, { fromBps: before, toBps: paramsFor(asset).spreadBps, reason: p.data.reason ?? null });
    }
    res.json({ asset: assetRow(asset, (await custom()).has(asset.symbol)) });
  });

  // ---- Audit log
  admin.get('/audit', async (req, res) => {
    const { admin: adminId, action, targetType, targetId, from, to } = req.query;
    const f = msParam(from);
    const t = msParam(to);
    if (f === null || t === null) return bad(res, 'from and to must be dates or timestamps');
    if (adminId !== undefined && !/^\d+$/.test(adminId)) return bad(res, 'admin must be a user id');
    const { limit, offset } = page(req.query, 500, 100);
    res.json(await queryAudit(db, {
      admin: adminId === undefined ? undefined : Number(adminId), action, targetType, targetId, from: f, to: t, limit, offset,
    }));
  });

  // ---- Reports (CSV). Exporting is itself an audited action.
  const REPORTS = {
    users: async () => ({
      head: ['id', 'name', 'email', 'role', 'email_verified', 'kyc_status', 'suspended', 'balance', 'currency', 'created_at'],
      rows: (await db.prepare('SELECT * FROM users ORDER BY id').all()).map((u) => [u.id, u.name, u.email, u.role, u.email_verified ? 'yes' : 'no', u.kyc_status, u.suspended_at ? 'yes' : 'no', u.balance, u.currency, u.created_at]),
    }),
    orders: async () => ({
      head: ['id', 'user_id', 'symbol', 'side', 'type', 'quantity', 'filled_quantity', 'price', 'fill_price', 'status', 'created_at', 'filled_at'],
      rows: (await db.prepare('SELECT * FROM orders ORDER BY id').all()).map((o) => [o.id, o.user_id, o.symbol, o.side, o.type, o.quantity, o.filled_quantity, o.price, o.fill_price, o.status, o.created_at, o.filled_at]),
    }),
    withdrawals: async () => ({
      head: ['id', 'user_id', 'amount', 'status', 'requested_at', 'decided_at', 'decided_by', 'decision_note'],
      rows: (await db.prepare('SELECT * FROM withdrawal_requests ORDER BY id').all()).map((w) => [w.id, w.user_id, w.amount, w.status, iso(w.created_at), iso(w.decided_at), w.decided_by, w.decision_note]),
    }),
    'failed-logins': async () => ({
      head: ['id', 'time', 'email', 'user_id', 'reason', 'ip', 'device'],
      rows: (await db.prepare('SELECT * FROM login_events WHERE success = 0 ORDER BY id').all()).map((e) => [e.id, iso(e.created_at), e.email, e.user_id, e.reason, e.ip, e.device]),
    }),
    audit: async () => ({
      head: ['id', 'time', 'admin_id', 'admin_email', 'action', 'target_type', 'target_id', 'details', 'ip'],
      rows: (await db.prepare('SELECT * FROM admin_audit ORDER BY id').all()).map((a) => [a.id, iso(a.created_at), a.admin_id, a.admin_email, a.action, a.target_type, a.target_id, a.details, a.ip]),
    }),
    assets: async () => ({
      head: ['symbol', 'name', 'category', 'status', 'risk', 'session', 'base_price', 'custom'],
      rows: await Promise.all(ASSETS.map(async (a) => [a.symbol, a.name, a.category, a.status ?? 'active', a.risk, a.session, a.base, (await custom()).has(a.symbol) ? 'yes' : 'no'])),
    }),
  };
  admin.get('/reports/:type', async (req, res) => {
    const build = REPORTS[req.params.type];
    if (!build) return res.status(404).json({ error: `Unknown report. Available: ${Object.keys(REPORTS).join(', ')}` });
    const { head, rows } = await build();
    await audit(req, 'report.export', 'report', req.params.type, { rows: rows.length });
    res.set({
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="admin-${req.params.type}-${new Date(now()).toISOString().slice(0, 10)}.csv"`,
    }).send(toCsv(head, rows));
  });

  return admin;
}
