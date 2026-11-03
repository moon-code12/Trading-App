import { Router } from 'express';
import { z } from 'zod';
import { computeAnalytics, buildStatement } from './analytics.js';
import { INDICATORS, WARMUP, computeIndicators } from './indicators.js';
import { requireAuth } from './auth.js';
import { adminRouter } from './admin.js';
import { describeProfile } from './simulation.js';
import { challengesRouter } from './challenges.js';
import { evaluateAchievements } from './achievements.js';
import { notify } from './db.js';
import { listedAssets, COMPARE_RANGES, TIMEFRAMES, getAsset, quote, history, candles, priceAt, snapshot, searchAssets, categories, compareSeries, discover, candleCloses } from './market.js';
import { ORDER_TYPES, OrderError, placeOrder, previewOrder, cancelOrder, getOrderDetail, matchPending, checkAlerts, riskSettings, updateRiskSettings } from './trading.js';

const r2 = (n) => Math.round(n * 100) / 100;
const bad = (res, msg = 'Invalid input') => res.status(400).json({ error: msg });

export function apiRouter(db, { secret, now = Date.now, waitUntil }) {
  const r = Router();
  r.use(requireAuth(db, secret, now));
  // After anything is changed successfully (an order, an alert, a favourite, a limit...), award any achievement it unlocked.
  r.use((req, res, next) => {
    if (req.method !== 'GET') {
      res.on('finish', async () => {
        if (res.statusCode >= 400 || !req.user) return;
        // On serverless the function can be frozen once the response ends, so hand the work to waitUntil when there is one.
        const work = evaluateAchievements(db, req.user.id, now()).catch(() => { /* achievements must never break a request */ });
        waitUntil?.(work);
      });
    }
    next();
  });

  // ---- Markets (public to any logged-in user)
  // Favourites are the user's watchlist.
  const favouriteSet = async (userId) => new Set((await db.prepare('SELECT symbol FROM watchlist WHERE user_id = ?').all(userId)).map((x) => x.symbol));
  const MAX_RECENT = 8;
  const SORTS = {
    symbol: (x) => x.symbol, name: (x) => x.name.toLowerCase(), price: (x) => x.price,
    change: (x) => x.change24h, volume: (x) => x.volumeUsd24h,
  };

  // Search, filter and sort the catalogue; every row carries 24h stats, market status and the favourite flag.
  r.get('/markets', async (req, res) => {
    const { q = '', category, sort, order } = req.query;
    if (sort !== undefined && !SORTS[sort]) return bad(res, 'Unknown sort');
    if (order !== undefined && !['asc', 'desc'].includes(order)) return bad(res, 'Unknown order');
    const favs = await favouriteSet(req.user.id);
    let rows = searchAssets({ q: String(q).slice(0, 60), category }).map((a) => ({ ...snapshot(a), favourite: favs.has(a.symbol) }));
    if (sort) {
      const dir = (order ?? (['symbol', 'name'].includes(sort) ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
      const key = SORTS[sort];
      rows = rows.sort((x, y) => (key(x) < key(y) ? -dir : key(x) > key(y) ? dir : 0));
    }
    res.json({ assets: rows, categories: categories() });
  });

  // How the simulation behaves (spreads, fees, slippage, delays, hours) and why results differ from real trading.
  r.get('/simulation', (_req, res) => res.json(describeProfile()));

  r.get('/markets/meta', (_req, res) => {
    res.json({ categories: categories().map((id) => ({ id, count: listedAssets().filter((a) => a.category === id).length })), total: listedAssets().length });
  });

  // Top gainers and losers by 24h change, and the most active assets by traded value.
  r.get('/markets/discovery', (req, res) => {
    const limit = req.query.limit === undefined ? 3 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) return bad(res, 'Limit must be between 1 and 10');
    const rows = searchAssets({ category: req.query.category }).map((a) => snapshot(a));
    res.json({ ...discover(rows, limit), asOf: new Date().toISOString() });
  });

  r.get('/markets/compare', async (req, res) => {
    const { a, b, range = '1D' } = req.query;
    if (!a || !b) return bad(res, 'Choose two assets to compare');
    if (!COMPARE_RANGES[range]) return bad(res, 'Unknown range');
    const x = getAsset(String(a).toUpperCase());
    const y = getAsset(String(b).toUpperCase());
    if (!x || !y) return res.status(404).json({ error: 'Unknown asset' });
    if (x.symbol === y.symbol) return bad(res, 'Choose two different assets');
    const favs = await favouriteSet(req.user.id);
    res.json({ assets: [x, y].map((s) => ({ ...snapshot(s), favourite: favs.has(s.symbol) })), ...compareSeries(x, y, range) });
  });

  r.get('/markets/:symbol', (req, res) => {
    const a = getAsset(req.params.symbol.toUpperCase());
    if (!a) return res.status(404).json({ error: 'Unknown asset' });
    const h = history(a);
    const prices = h.map((p) => p.price);
    res.json({
      asset: snapshot(a), history: h,
      stats: { high: Math.max(...prices), low: Math.min(...prices), open: prices[0] },
    });
  });

  // Recently viewed assets, newest first, capped per user.
  r.get('/recent', async (req, res) => {
    const favs = await favouriteSet(req.user.id);
    const rows = await db.prepare('SELECT symbol FROM recent_views WHERE user_id = ? ORDER BY viewed_at DESC, rowid DESC').all(req.user.id);
    res.json({ assets: rows.filter((x) => getAsset(x.symbol)).map((x) => ({ ...snapshot(getAsset(x.symbol)), favourite: favs.has(x.symbol) })) });
  });
  r.put('/recent/:symbol', async (req, res) => {
    const s = req.params.symbol.toUpperCase();
    if (!getAsset(s)) return res.status(404).json({ error: 'Unknown asset' });
    await db.prepare('DELETE FROM recent_views WHERE user_id = ? AND symbol = ?').run(req.user.id, s);
    await db.prepare('INSERT INTO recent_views (user_id, symbol, viewed_at) VALUES (?, ?, ?)').run(req.user.id, s, Date.now());
    await db.prepare(`DELETE FROM recent_views WHERE user_id = ? AND symbol NOT IN
      (SELECT symbol FROM recent_views WHERE user_id = ? ORDER BY viewed_at DESC, rowid DESC LIMIT ?)`).run(req.user.id, req.user.id, MAX_RECENT);
    res.json({ ok: true });
  });
  r.delete('/recent', async (req, res) => {
    await db.prepare('DELETE FROM recent_views WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
  });

  // Candles (with simulated volume). `indicators` is a comma list of sma, ema, rsi, macd, bb and volume; the
  // indicator values are calculated from the real closing prices, using earlier history so none start empty.
  r.get('/markets/:symbol/candles', (req, res) => {
    const a = getAsset(req.params.symbol.toUpperCase());
    if (!a) return res.status(404).json({ error: 'Unknown asset' });
    const tf = String(req.query.tf || '1D');
    if (!TIMEFRAMES[tf]) return bad(res, 'Unknown timeframe');
    const wanted = req.query.indicators === undefined || req.query.indicators === '' ? [] : String(req.query.indicators).split(',');
    if (wanted.some((w) => !INDICATORS.includes(w)) || new Set(wanted).size !== wanted.length) return bad(res, `Indicators must be a list of: ${INDICATORS.join(', ')}`);
    const options = {};
    for (const key of ['smaPeriod', 'emaPeriod']) {
      if (req.query[key] === undefined) continue;
      const v = Number(req.query[key]);
      if (!Number.isInteger(v) || v < 2 || v > 200) return bad(res, `${key} must be a whole number from 2 to 200`);
      options[key] = v;
    }
    const now = Date.now();
    const body = { symbol: a.symbol, tf, price: priceAt(a, now), candles: candles(a, tf, now) };
    if (wanted.some((w) => w !== 'volume')) {
      body.indicators = computeIndicators(candleCloses(a, tf, now, WARMUP), TIMEFRAMES[tf].count, wanted, options);
    }
    res.json(body);
  });

  // ---- Watchlist
  r.get('/watchlist', async (req, res) => {
    const rows = await db.prepare('SELECT symbol FROM watchlist WHERE user_id = ?').all(req.user.id);
    res.json({ assets: rows.map((x) => quote(getAsset(x.symbol))) });
  });
  r.put('/watchlist/:symbol', async (req, res) => {
    const s = req.params.symbol.toUpperCase();
    if (!getAsset(s)) return res.status(404).json({ error: 'Unknown asset' });
    await db.prepare('INSERT OR IGNORE INTO watchlist VALUES (?, ?)').run(req.user.id, s);
    res.json({ ok: true });
  });
  r.delete('/watchlist/:symbol', async (req, res) => {
    await db.prepare('DELETE FROM watchlist WHERE user_id = ? AND symbol = ?').run(req.user.id, req.params.symbol.toUpperCase());
    res.json({ ok: true });
  });

  // ---- Orders
  const money = z.number().positive().finite();
  const orderFields = {
    symbol: z.string().transform((s) => s.toUpperCase()),
    side: z.enum(['buy', 'sell']),
    quantity: z.number().positive().finite(),
    timeInForce: z.enum(['day', 'gtc']).optional(),
    confirmLarge: z.boolean().optional(),
  };
  const orderSchema = z.object({
    ...orderFields,
    type: z.enum(ORDER_TYPES),
    price: money.optional(),
    limitPrice: money.optional(),
    trailAmount: money.optional(),
    trailPercent: money.optional(),
  }).refine((o) => getAsset(o.symbol), { message: 'Unknown asset' });
  const ocoSchema = z.object({
    ...orderFields,
    legs: z.array(z.object({ type: z.enum(ORDER_TYPES), price: money.optional(), limitPrice: money.optional() })).length(2),
  }).refine((o) => getAsset(o.symbol), { message: 'Unknown asset' });

  // Runs an order action that returns [status, body]; validation failures keep their HTTP status and code.
  const orderAction = (schema, fn) => async (req, res) => {
    const p = schema.safeParse(req.body);
    if (!p.success) return bad(res, p.error.issues[0].message);
    try {
      const [status, body] = await fn(p.data, req);
      res.status(status).json(body);
    } catch (e) {
      if (!(e instanceof OrderError)) throw e;
      res.status(e.status).json({ error: e.message, code: e.code, ...e.details });
    }
  };
  const place = async (db2, req, { confirmLarge, ...spec }) => await placeOrder(db2, req.user, spec, Date.now(), { confirmLarge });

  r.post('/orders/preview', orderAction(z.union([ocoSchema, orderSchema]), async ({ confirmLarge, ...spec }, req) =>
    [200, await previewOrder(db, req.user, spec)]));
  r.post('/orders', orderAction(orderSchema, async (d, req) => {
    const done = await place(db, req, d);
    return [201, { order: done.order, warnings: done.warnings, estimate: done.estimate }];
  }));
  r.post('/orders/oco', orderAction(ocoSchema, async (d, req) => {
    const done = await place(db, req, d);
    return [201, { orders: done.orders, warnings: done.warnings, estimate: done.estimate }];
  }));

  r.get('/orders', async (req, res) => {
    await matchPending(db);
    const { status } = req.query;
    const rows = status
      ? await db.prepare('SELECT * FROM orders WHERE user_id = ? AND status = ? ORDER BY id DESC').all(req.user.id, status)
      : await db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
    res.json({ orders: rows });
  });

  r.get('/orders/:id', async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return bad(res, 'Invalid order id');
    await matchPending(db);
    const detail = await getOrderDetail(db, req.user.id, Number(req.params.id));
    if (!detail) return res.status(404).json({ error: 'Order not found' });
    res.json(detail);
  });

  r.delete('/orders/:id', async (req, res) => {
    const ids = await cancelOrder(db, req.user.id, req.params.id);
    if (!ids) return res.status(404).json({ error: 'No pending order found' });
    res.json({ ok: true, cancelled: ids });
  });

  // ---- Risk controls
  const riskSchema = z.object({
    dailyLossLimit: z.number().positive().max(1e9).nullable().optional(),
    maxOrderPct: z.number().min(1).max(100).optional(),
    largeOrderPct: z.number().min(1).max(100).optional(),
  });
  r.get('/risk', async (req, res) => res.json(await riskSettings(db, req.user.id)));
  r.put('/risk', async (req, res) => {
    const p = riskSchema.safeParse(req.body);
    if (!p.success) return bad(res, 'Invalid risk settings');
    res.json(await updateRiskSettings(db, req.user.id, p.data));
  });

  // ---- Portfolio & dashboard
  async function portfolio(user) {
    await matchPending(db);
    const fresh = await db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id);
    const holdings = (await db.prepare('SELECT * FROM holdings WHERE user_id = ?').all(user.id)).map((h) => {
      const price = priceAt(getAsset(h.symbol));
      const value = r2(price * h.quantity);
      const pnl = r2((price - h.avg_cost) * h.quantity);
      return { symbol: h.symbol, name: getAsset(h.symbol).name, quantity: h.quantity, avgCost: h.avg_cost, price, value, pnl };
    });
    const invested = r2(holdings.reduce((s, h) => s + h.value, 0));
    const pnl = r2(holdings.reduce((s, h) => s + h.pnl, 0));
    return { balance: r2(fresh.balance), invested, totalValue: r2(fresh.balance + invested), pnl, holdings };
  }
  r.get('/portfolio', async (req, res) => res.json(await portfolio(req.user)));
  r.get('/portfolio/analytics', async (req, res) => {
    await matchPending(db);
    res.json(await computeAnalytics(db, req.user));
  });
  r.get('/dashboard', async (req, res) => {
    const wl = await db.prepare('SELECT symbol FROM watchlist WHERE user_id = ?').all(req.user.id);
    res.json({ ...await portfolio(req.user), watchlist: wl.map((x) => quote(getAsset(x.symbol))) });
  });

  // ---- Wallet & transactions
  r.get('/wallet', async (req, res) => {
    const u = await db.prepare('SELECT balance, currency FROM users WHERE id = ?').get(req.user.id);
    res.json({ balance: r2(u.balance), currency: u.currency, mode: 'demo' });
  });

  const amountSchema = z.object({ amount: z.number().positive().max(1e7) });
  // Suspended accounts cannot move money in or out.
  const notSuspended = (req, res, next) => (req.user.suspended_at
    ? res.status(403).json({ error: 'Your account is suspended. Contact support for help.', code: 'ACCOUNT_SUSPENDED' })
    : next());
  r.post('/wallet/deposit', notSuspended, async (req, res) => {
    const p = amountSchema.safeParse(req.body);
    if (!p.success) return bad(res);
    await db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(p.data.amount, req.user.id);
    await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'deposit', ?, 'Demo deposit')").run(req.user.id, p.data.amount);
    res.json({ ok: true });
  });
  // A withdrawal is a request: the money is set aside now, and an administrator approves it or sends it back.
  r.post('/wallet/withdraw', notSuspended, async (req, res) => {
    const p = amountSchema.safeParse(req.body);
    if (!p.success) return bad(res);
    if (req.user.kyc_status !== 'approved') return res.status(403).json({ error: 'KYC approval required to withdraw' });
    const held = (await db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?').run(p.data.amount, req.user.id, p.data.amount)).changes;
    if (!held) return bad(res, 'Insufficient funds');
    const id = Number((await db.prepare("INSERT INTO withdrawal_requests (user_id, amount, created_at) VALUES (?, ?, ?)").run(req.user.id, p.data.amount, now())).lastInsertRowid);
    await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'withdrawal', ?, ?)").run(req.user.id, -p.data.amount, `Withdrawal request #${id}`);
    res.status(202).json({ ok: true, id, status: 'pending' });
  });
  r.get('/wallet/withdrawals', async (req, res) => {
    res.json({ withdrawals: await db.prepare('SELECT id, amount, status, created_at AS createdAt, decided_at AS decidedAt, decision_note AS note FROM withdrawal_requests WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id) });
  });
  // Active announcements from the administrators.
  r.get('/announcements', async (_req, res) => {
    res.json({ announcements: await db.prepare('SELECT id, title, message, level, created_at AS createdAt FROM announcements WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT 10').all(now()) });
  });
  r.get('/transactions/export', async (req, res) => {
    res.set({
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="demo-statement-${new Date().toISOString().slice(0, 10)}.csv"`,
    }).send(await buildStatement(db, req.user));
  });
  r.get('/transactions', async (req, res) => {
    res.json({ transactions: await db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC').all(req.user.id) });
  });

  // ---- KYC
  const kycSchema = z.object({
    fullName: z.string().trim().min(2).max(120),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    country: z.string().trim().min(2).max(60),
    documentType: z.enum(['passport', 'national_id', 'drivers_license']),
    documentNumber: z.string().trim().min(4).max(40),
  });
  r.post('/kyc', async (req, res) => {
    if (['pending', 'approved'].includes(req.user.kyc_status))
      return res.status(409).json({ error: `KYC already ${req.user.kyc_status}` });
    const p = kycSchema.safeParse(req.body);
    if (!p.success) return bad(res);
    const d = p.data;
    await db.prepare('INSERT INTO kyc_submissions (user_id, full_name, date_of_birth, country, document_type, document_number) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, d.fullName, d.dateOfBirth, d.country, d.documentType, d.documentNumber);
    await db.prepare("UPDATE users SET kyc_status = 'pending' WHERE id = ?").run(req.user.id);
    await notify(db, req.user.id, 'security', 'Your identity documents were submitted for review.');
    res.status(201).json({ status: 'pending' });
  });
  r.get('/kyc', async (req, res) => {
    const s = await db.prepare('SELECT id, status, created_at FROM kyc_submissions WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(req.user.id);
    res.json({ status: req.user.kyc_status, submission: s ?? null });
  });

  // ---- Price alerts
  const alertSchema = z.object({
    symbol: z.string().transform((s) => s.toUpperCase()),
    direction: z.enum(['above', 'below']),
    target: z.number().positive().finite(),
  }).refine((a) => getAsset(a.symbol), { message: 'Unknown asset' });

  r.post('/alerts', async (req, res) => {
    const p = alertSchema.safeParse(req.body);
    if (!p.success) return bad(res, p.error.issues[0].message);
    const count = (await db.prepare("SELECT COUNT(*) n FROM price_alerts WHERE user_id = ? AND status = 'active'").get(req.user.id)).n;
    if (count >= 20) return bad(res, 'You can have at most 20 active alerts');
    const { symbol, direction, target } = p.data;
    const { lastInsertRowid: id } = await db.prepare('INSERT INTO price_alerts (user_id, symbol, direction, target) VALUES (?, ?, ?, ?)')
      .run(req.user.id, symbol, direction, target);
    res.status(201).json({ alert: await db.prepare('SELECT * FROM price_alerts WHERE id = ?').get(id) });
  });
  r.get('/alerts', async (req, res) => {
    await checkAlerts(db);
    res.json({ alerts: await db.prepare('SELECT * FROM price_alerts WHERE user_id = ? ORDER BY id DESC').all(req.user.id) });
  });
  r.delete('/alerts/:id', async (req, res) => {
    const out = await db.prepare("DELETE FROM price_alerts WHERE id = ? AND user_id = ? AND status = 'active'").run(req.params.id, req.user.id);
    if (!out.changes) return res.status(404).json({ error: 'No active alert found' });
    res.json({ ok: true });
  });

  // ---- Notifications
  r.get('/notifications', async (req, res) => {
    await checkAlerts(db);
    res.json({ notifications: await db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id) });
  });
  r.post('/notifications/read', async (req, res) => {
    await db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
  });

  // ---- Admin (every route inside requires an administrator and is audited)
  const admin = adminRouter(db, { now, portfolio });
  r.use('/admin', admin);

  r.use(challengesRouter(db, { now }));

  return r;
}
