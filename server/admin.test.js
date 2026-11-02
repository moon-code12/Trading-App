import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { matchPending } from './src/trading.js';
import { sanitizeDetails } from './src/audit.js';
import { toCsv } from './src/admin.js';
import { ASSETS } from './src/market.js';

const MIN = 60e3;

// An app with a controllable clock, one administrator and any number of ordinary users.
async function setup() {
  const db = openDb(':memory:');
  const clock = { t: Date.UTC(2026, 5, 1, 12, 0, 0) };
  const mails = [];
  const server = createApp(db, { secret: 's', now: () => clock.t, mailer: { send: (m) => mails.push(m) } }).listen(0);
  const base = `http://localhost:${server.address().port}/api`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };
  const signUp = async (name, email) => {
    const r = await call('POST', '/auth/register', { name, email, password: 'password1' });
    return { token: r.body.token, id: r.body.user.id, email };
  };
  const admin = await signUp('Ada Admin', 'ada@x.com');
  db.prepare("UPDATE users SET role = 'admin', email_verified = 1 WHERE id = ?").run(admin.id);
  return { db, server, clock, mails, call, signUp, admin, close: () => server.close() };
}
const audit = (ctx, query = '') => ctx.call('GET', `/admin/audit${query}`, null, ctx.admin.token).then((r) => r.body);
const pend = (ctx, user) => ctx.call('POST', '/orders', { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: 1 }, user.token);

// ------------------------------------------------------------------ authorization

test('every admin endpoint refuses anonymous callers and ordinary users', async () => {
  const ctx = await setup();
  try {
    const user = await ctx.signUp('Bob', 'bob@x.com');
    const routes = [
      ['GET', '/admin/stats'], ['GET', '/admin/users'], ['GET', `/admin/users/${user.id}`], ['GET', `/admin/users/${user.id}/portfolio`],
      ['GET', `/admin/users/${user.id}/orders`], ['POST', `/admin/users/${user.id}/suspend`, { reason: 'because' }],
      ['POST', `/admin/users/${user.id}/restore`], ['POST', `/admin/users/${user.id}/reset-balance`, { reason: 'because' }],
      ['GET', '/admin/orders'], ['GET', '/admin/kyc'], ['POST', '/admin/kyc/1/approve'], ['GET', '/admin/withdrawals'],
      ['POST', '/admin/withdrawals/1/approve'], ['POST', '/admin/withdrawals/1/reject', { note: 'no' }], ['GET', '/admin/failed-logins'],
      ['GET', '/admin/announcements'], ['POST', '/admin/announcements', { title: 't', message: 'm' }], ['PATCH', '/admin/announcements/1', { active: false }],
      ['GET', '/admin/assets'], ['POST', '/admin/assets', {}], ['PATCH', '/admin/assets/BTC', { status: 'paused' }],
      ['GET', '/admin/audit'], ['GET', '/admin/reports/users'],
    ];
    for (const [method, path, body] of routes) {
      assert.equal((await ctx.call(method, path, body)).status, 401, `anonymous ${method} ${path}`);
      assert.equal((await ctx.call(method, path, body, user.token)).status, 403, `user ${method} ${path}`);
    }
    assert.equal((await audit(ctx)).total, 0, 'refused calls change nothing');
    assert.equal((await ctx.call('GET', '/admin/stats', null, ctx.admin.token)).status, 200);
  } finally { ctx.close(); }
});

test('a signed-in user who is demoted loses admin access immediately', async () => {
  const ctx = await setup();
  try {
    assert.equal((await ctx.call('GET', '/admin/stats', null, ctx.admin.token)).status, 200);
    ctx.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(ctx.admin.id);
    assert.equal((await ctx.call('GET', '/admin/stats', null, ctx.admin.token)).status, 403);
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ users

test('user search: by name, email or id, with filters, sorting and paging', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob Builder', 'bob@x.com');
    const cat = await ctx.signUp('Cat 100%', 'cat@y.org');
    await ctx.signUp('Dan', 'dan@y.org');
    ctx.db.prepare("UPDATE users SET kyc_status = 'approved', balance = 50 WHERE id = ?").run(bob.id);
    ctx.db.prepare('UPDATE users SET suspended_at = 1 WHERE id = ?').run(cat.id);
    const list = async (q) => (await ctx.call('GET', `/admin/users${q}`, null, ctx.admin.token)).body;

    assert.equal((await list('')).total, 4);
    assert.deepEqual((await list('?q=builder')).users.map((u) => u.email), ['bob@x.com']);
    assert.deepEqual((await list('?q=Y.ORG&sort=email&order=asc')).users.map((u) => u.email), ['cat@y.org', 'dan@y.org']);
    assert.deepEqual((await list(`?q=${bob.id}`)).users.map((u) => u.email), ['bob@x.com'], 'by id');
    assert.equal((await list('?q=100%25')).total, 1, 'a percent sign is searched for, not treated as a wildcard');
    assert.equal((await list('?q=%25')).total, 1);
    assert.deepEqual((await list('?kyc=approved')).users.map((u) => u.email), ['bob@x.com']);
    assert.deepEqual((await list('?status=suspended')).users.map((u) => u.email), ['cat@y.org']);
    assert.equal((await list('?status=active')).total, 3);
    assert.deepEqual((await list('?role=admin')).users.map((u) => u.email), ['ada@x.com']);
    assert.equal((await list('?verified=true')).total, 1);
    assert.deepEqual((await list('?sort=balance&order=asc&limit=1')).users.map((u) => u.email), ['bob@x.com']);
    const paged = await list('?limit=2&offset=3');
    assert.equal(paged.users.length, 1);
    assert.equal(paged.total, 4);
    for (const bad of ['?role=root', '?kyc=maybe', '?status=gone', '?verified=1', '?sort=password_hash', '?order=sideways']) {
      assert.equal((await ctx.call('GET', `/admin/users${bad}`, null, ctx.admin.token)).status, 400, bad);
    }
    ctx.db.prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(ctx.clock.t + MIN, bob.id);
    assert.deepEqual((await list('?status=locked')).users.map((u) => u.email), ['bob@x.com']);
  } finally { ctx.close(); }
});

test('user details: summary, counts and history, with no secrets, and the view is audited', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob', 'bob@x.com');
    ctx.db.prepare("UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled = 1 WHERE id = ?").run(bob.id);
    await pend(ctx, bob);
    await ctx.call('POST', '/auth/login', { email: 'bob@x.com', password: 'wrong' });
    const res = await ctx.call('GET', `/admin/users/${bob.id}`, null, ctx.admin.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, 'bob@x.com');
    assert.equal(res.body.counts.orders, 1);
    assert.equal(res.body.counts.openOrders, 1);
    assert.equal(res.body.counts.activeSessions, 1);
    assert.equal(res.body.recentLogins.length >= 2, true);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('JBSWY3DPEHPK3PXP') && !/password_hash|totp_secret/.test(text), 'no secrets');
    assert.equal((await ctx.call('GET', '/admin/users/99999', null, ctx.admin.token)).status, 404);
    assert.equal((await ctx.call('GET', '/admin/users/abc', null, ctx.admin.token)).status, 404);
    const log = await audit(ctx, '?action=user.view');
    assert.equal(log.total, 1);
    assert.equal(log.entries[0].targetId, String(bob.id));
  } finally { ctx.close(); }
});

test('an administrator can see any user\'s portfolio and orders', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob', 'bob@x.com');
    assert.equal((await ctx.call('POST', '/orders', { symbol: 'ETH', side: 'buy', type: 'market', quantity: 1 }, bob.token)).status, 201);
    await pend(ctx, bob);
    const portfolio = await ctx.call('GET', `/admin/users/${bob.id}/portfolio`, null, ctx.admin.token);
    assert.equal(portfolio.status, 200);
    assert.equal(portfolio.body.holdings[0].symbol, 'ETH');
    const orders = (await ctx.call('GET', `/admin/users/${bob.id}/orders`, null, ctx.admin.token)).body.orders;
    assert.equal(orders.length, 2);
    assert.equal((await ctx.call('GET', `/admin/users/${bob.id}/orders?status=pending`, null, ctx.admin.token)).body.orders.length, 1);
    const all = (await ctx.call('GET', '/admin/orders?symbol=eth', null, ctx.admin.token)).body.orders;
    assert.equal(all.length, 2);
    assert.deepEqual(new Set((await audit(ctx)).entries.map((e) => e.action)), new Set(['user.portfolio.view', 'user.orders.view', 'user.orders.view']));
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ suspension

test('suspended users cannot trade, withdraw or deposit, and pending orders stay put until they are restored', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob', 'bob@x.com');
    ctx.db.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").run(bob.id);
    const resting = (await pend(ctx, bob)).body.order;
    assert.equal(resting.status, 'pending');

    const suspend = await ctx.call('POST', `/admin/users/${bob.id}/suspend`, { reason: 'Suspicious activity' }, ctx.admin.token);
    assert.equal(suspend.status, 200);
    assert.equal(suspend.body.user.suspended, true);
    assert.equal((await ctx.call('GET', '/auth/me', null, bob.token)).body.user.suspended, true, 'they can still sign in and see why');

    const market = { symbol: 'ETH', side: 'buy', type: 'market', quantity: 1 };
    const blocked = await ctx.call('POST', '/orders', market, bob.token);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'ACCOUNT_SUSPENDED');
    assert.equal((await ctx.call('POST', '/orders/preview', market, bob.token)).status, 403);
    assert.equal((await ctx.call('POST', '/orders/oco', { symbol: 'ETH', side: 'sell', quantity: 1, legs: [{ type: 'take_profit', price: 1e6 }, { type: 'stop_loss', price: 1 }] }, bob.token)).status, 403);
    assert.equal((await ctx.call('POST', '/wallet/withdraw', { amount: 10 }, bob.token)).status, 403);
    assert.equal((await ctx.call('POST', '/wallet/deposit', { amount: 10 }, bob.token)).status, 403);
    assert.equal((await ctx.call('GET', '/wallet', null, bob.token)).body.balance, 10000, 'balance untouched');

    // The resting order would fill if its price were reached, but nothing is processed while suspended.
    ctx.db.prepare('UPDATE orders SET price = 1000000 WHERE id = ?').run(resting.id);
    matchPending(ctx.db);
    assert.equal(ctx.db.prepare('SELECT status FROM orders WHERE id = ?').get(resting.id).status, 'pending');
    assert.equal((await ctx.call('DELETE', `/orders/${resting.id}`, null, bob.token)).status, 200, 'they can still cancel');

    assert.equal((await ctx.call('POST', `/admin/users/${bob.id}/restore`, null, ctx.admin.token)).status, 200);
    assert.equal((await ctx.call('POST', '/orders', market, bob.token)).status, 201);
    assert.equal((await ctx.call('POST', '/wallet/withdraw', { amount: 10 }, bob.token)).status, 202);
    assert.equal((await ctx.call('POST', '/wallet/deposit', { amount: 10 }, bob.token)).status, 200);
  } finally { ctx.close(); }
});

test('suspended: a resting order fills after restore', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob', 'bob@x.com');
    const resting = (await pend(ctx, bob)).body.order;
    await ctx.call('POST', `/admin/users/${bob.id}/suspend`, { reason: 'Review' }, ctx.admin.token);
    ctx.db.prepare('UPDATE orders SET price = 1000000 WHERE id = ?').run(resting.id);
    matchPending(ctx.db);
    assert.equal(ctx.db.prepare('SELECT status FROM orders WHERE id = ?').get(resting.id).status, 'pending');
    await ctx.call('POST', `/admin/users/${bob.id}/restore`, null, ctx.admin.token);
    matchPending(ctx.db);
    assert.notEqual(ctx.db.prepare('SELECT status FROM orders WHERE id = ?').get(resting.id).status, 'pending');
  } finally { ctx.close(); }
});

test('suspend and restore: rules, notifications and audit entries', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob', 'bob@x.com');
    const suspend = (id, reason) => ctx.call('POST', `/admin/users/${id}/suspend`, reason === undefined ? {} : { reason }, ctx.admin.token);
    assert.equal((await suspend(bob.id)).status, 400, 'a reason is required');
    assert.equal((await suspend(bob.id, 'x')).status, 400);
    assert.equal((await suspend(ctx.admin.id, 'oops')).status, 409, 'administrators cannot be suspended');
    assert.equal((await suspend(99999, 'reason')).status, 404);
    assert.equal((await ctx.call('POST', `/admin/users/${bob.id}/restore`, null, ctx.admin.token)).status, 409, 'not suspended yet');
    assert.equal((await suspend(bob.id, 'Chargeback fraud')).status, 200);
    assert.equal((await suspend(bob.id, 'again')).status, 409);
    assert.ok(ctx.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND message LIKE '%suspended%'").get(bob.id));
    ctx.clock.t += 5 * MIN;
    await ctx.call('POST', `/admin/users/${bob.id}/restore`, null, ctx.admin.token);

    const entries = (await audit(ctx)).entries;
    assert.deepEqual(entries.map((e) => e.action), ['user.restore', 'user.suspend']);
    const s = entries[1];
    assert.equal(s.admin.id, ctx.admin.id);
    assert.equal(s.admin.email, 'ada@x.com');
    assert.equal(s.targetType, 'user');
    assert.equal(s.targetId, String(bob.id));
    assert.equal(s.at, Date.UTC(2026, 5, 1, 12, 0, 0));
    assert.deepEqual(s.details, { reason: 'Chargeback fraud' });
    assert.equal(entries[0].at, s.at + 5 * MIN);
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ balance reset

test('reset balance: sets the amount, records the difference, and needs a reason', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob', 'bob@x.com');
    await ctx.call('POST', '/orders', { symbol: 'ETH', side: 'buy', type: 'market', quantity: 1 }, bob.token);
    const reset = (body) => ctx.call('POST', `/admin/users/${bob.id}/reset-balance`, body, ctx.admin.token);
    assert.equal((await reset({})).status, 400);
    assert.equal((await reset({ amount: -5, reason: 'bad' })).status, 400);
    assert.equal((await reset({ amount: 'lots', reason: 'bad' })).status, 400);
    const before = ctx.db.prepare('SELECT balance FROM users WHERE id = ?').get(bob.id).balance;
    assert.ok(before < 10000);
    const res = await reset({ reason: 'Back to the starting balance' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.balance, 10000, 'defaults to the standard demo balance');
    const tx = ctx.db.prepare("SELECT * FROM transactions WHERE note LIKE '%reset by an administrator%'").get();
    assert.equal(tx.type, 'deposit');
    assert.equal(tx.amount, Math.round((10000 - before) * 100) / 100);
    assert.equal((await reset({ amount: 250.5, reason: 'Lower it' })).body.user.balance, 250.5);
    const down = ctx.db.prepare("SELECT * FROM transactions WHERE type = 'withdrawal' ORDER BY id DESC").get();
    assert.equal(down.amount, -9749.5);
    const entry = (await audit(ctx, '?action=user.reset_balance')).entries[0];
    assert.deepEqual(entry.details, { from: 10000, to: 250.5, reason: 'Lower it' });
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ withdrawals

async function withdrawalSetup() {
  const ctx = await setup();
  const bob = await ctx.signUp('Bob', 'bob@x.com');
  ctx.db.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").run(bob.id);
  return { ctx, bob };
}

test('withdrawal requests: held when asked for, listed for review, and approved', async () => {
  const { ctx, bob } = await withdrawalSetup();
  try {
    const req = await ctx.call('POST', '/wallet/withdraw', { amount: 400 }, bob.token);
    assert.equal(req.status, 202);
    assert.equal((await ctx.call('GET', '/wallet', null, bob.token)).body.balance, 9600, 'set aside straight away');
    assert.equal((await ctx.call('POST', '/wallet/withdraw', { amount: 99999 }, bob.token)).status, 400, 'cannot hold more than the balance');
    assert.equal((await ctx.call('GET', '/wallet/withdrawals', null, bob.token)).body.withdrawals[0].status, 'pending');

    const queue = (await ctx.call('GET', '/admin/withdrawals?status=pending', null, ctx.admin.token)).body.withdrawals;
    assert.equal(queue.length, 1);
    assert.equal(queue[0].email, 'bob@x.com');
    assert.equal(queue[0].amount, 400);
    assert.equal(queue[0].kycStatus, 'approved');
    assert.equal((await ctx.call('GET', '/admin/stats', null, ctx.admin.token)).body.pendingWithdrawals, 1);

    assert.equal((await ctx.call('POST', `/admin/withdrawals/${req.body.id}/approve`, { note: 'Checked' }, ctx.admin.token)).status, 200);
    assert.equal((await ctx.call('GET', '/wallet', null, bob.token)).body.balance, 9600, 'stays withdrawn');
    assert.equal((await ctx.call('POST', `/admin/withdrawals/${req.body.id}/approve`, {}, ctx.admin.token)).status, 409, 'decided once');
    assert.equal((await ctx.call('POST', `/admin/withdrawals/${req.body.id}/reject`, { note: 'x' }, ctx.admin.token)).status, 409);
    assert.ok(ctx.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND message LIKE '%approved%'").get(bob.id));
    const entry = (await audit(ctx, '?action=withdrawal.approve')).entries[0];
    assert.deepEqual(entry.details, { withdrawalId: req.body.id, amount: 400, note: 'Checked' });
    assert.equal(entry.targetId, String(bob.id));
  } finally { ctx.close(); }
});

test('withdrawal requests: rejecting returns the money, and needs a reason', async () => {
  const { ctx, bob } = await withdrawalSetup();
  try {
    const { body: { id } } = await ctx.call('POST', '/wallet/withdraw', { amount: 400 }, bob.token);
    assert.equal((await ctx.call('POST', `/admin/withdrawals/${id}/reject`, {}, ctx.admin.token)).status, 400);
    assert.equal((await ctx.call('POST', `/admin/withdrawals/${id}/reject`, { note: 'Name does not match' }, ctx.admin.token)).status, 200);
    assert.equal((await ctx.call('GET', '/wallet', null, bob.token)).body.balance, 10000);
    const note = (await ctx.call('GET', '/wallet/withdrawals', null, bob.token)).body.withdrawals[0];
    assert.deepEqual([note.status, note.note], ['rejected', 'Name does not match']);
    assert.ok(ctx.db.prepare("SELECT 1 FROM transactions WHERE user_id = ? AND note LIKE '%rejected, funds returned%'").get(bob.id));
    assert.equal((await ctx.call('POST', '/admin/withdrawals/999/approve', {}, ctx.admin.token)).status, 404);
    assert.equal((await ctx.call('GET', '/admin/withdrawals?status=bogus', null, ctx.admin.token)).status, 400);
  } finally { ctx.close(); }
});

test('withdrawal requests: a suspended user\'s request cannot be approved, only rejected', async () => {
  const { ctx, bob } = await withdrawalSetup();
  try {
    const { body: { id } } = await ctx.call('POST', '/wallet/withdraw', { amount: 100 }, bob.token);
    await ctx.call('POST', `/admin/users/${bob.id}/suspend`, { reason: 'Investigation' }, ctx.admin.token);
    const approve = await ctx.call('POST', `/admin/withdrawals/${id}/approve`, {}, ctx.admin.token);
    assert.equal(approve.status, 409);
    assert.match(approve.body.error, /suspended/);
    assert.equal((await ctx.call('GET', '/admin/withdrawals', null, ctx.admin.token)).body.withdrawals[0].userSuspended, true);
    assert.equal((await ctx.call('POST', `/admin/withdrawals/${id}/reject`, { note: 'Account suspended' }, ctx.admin.token)).status, 200);
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ failed logins

test('failed logins: listed with filters, including emails that have no account', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob', 'bob@x.com');
    const login = (email, password) => ctx.call('POST', '/auth/login', { email, password });
    await login('bob@x.com', 'nope');
    await login('ghost@x.com', 'nope');
    await login('bob@x.com', 'password1');
    ctx.clock.t += 10 * MIN;
    await login('bob@x.com', 'nope2');
    const get = (q = '') => ctx.call('GET', `/admin/failed-logins${q}`, null, ctx.admin.token).then((r) => r.body);
    const all = await get();
    assert.equal(all.total, 3, 'successful logins are not included');
    assert.deepEqual(all.attempts.map((a) => [a.email, a.accountExists]), [['bob@x.com', true], ['ghost@x.com', false], ['bob@x.com', true]]);
    assert.equal((await get('?email=GHOST')).total, 1);
    assert.equal((await get('?reason=bad_password')).total, 3);
    assert.equal((await get('?reason=locked')).total, 0);
    assert.equal((await get(`?since=${Date.UTC(2026, 5, 1, 12, 5)}`)).total, 1);
    assert.equal((await get('?limit=1')).attempts.length, 1);
    assert.equal((await ctx.call('GET', '/admin/failed-logins?since=yesterday-ish', null, ctx.admin.token)).status, 400);
    const text = JSON.stringify(all);
    assert.ok(!/password|token|secret/i.test(text.replace(/bad_password/g, '')), 'no credentials in the list');
    assert.equal((await audit(ctx, '?action=failed_logins.view')).total >= 1, true);
    assert.ok(bob);
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ announcements

test('announcements: created by admins, shown to users until switched off or expired', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob', 'bob@x.com');
    const post = (body) => ctx.call('POST', '/admin/announcements', body, ctx.admin.token);
    assert.equal((await post({ title: '', message: 'x' })).status, 400);
    assert.equal((await post({ title: 'x', message: 'y', level: 'loud' })).status, 400);
    assert.equal((await post({ title: 'x', message: 'y', expiresAt: '2020-01-01T00:00:00Z' })).status, 400, 'expiry in the past');
    const a = await post({ title: 'Maintenance', message: 'Trading pauses at 22:00 UTC.', level: 'warning' });
    assert.equal(a.status, 201);
    const b = await post({ title: 'Short lived', message: 'Soon gone', expiresAt: new Date(ctx.clock.t + 30 * MIN).toISOString() });
    const visible = async () => (await ctx.call('GET', '/announcements', null, bob.token)).body.announcements.map((x) => x.title);
    assert.deepEqual(await visible(), ['Short lived', 'Maintenance']);
    ctx.clock.t += 31 * MIN;
    assert.deepEqual(await visible(), ['Maintenance'], 'expired');
    assert.equal((await ctx.call('PATCH', `/admin/announcements/${a.body.announcement.id}`, { active: false }, ctx.admin.token)).status, 200);
    assert.deepEqual(await visible(), []);
    assert.equal((await ctx.call('GET', '/announcements')).status, 401);
    assert.equal((await ctx.call('PATCH', '/admin/announcements/999', { active: true }, ctx.admin.token)).status, 404);
    assert.equal((await ctx.call('GET', '/admin/announcements', null, ctx.admin.token)).body.announcements.length, 2);
    assert.deepEqual((await audit(ctx)).entries.map((e) => e.action), ['announcement.deactivate', 'announcement.create', 'announcement.create']);
    assert.ok(b);
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ assets

test('assets: pausing blocks trading in one asset and shows it as paused, resuming restores it', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob', 'bob@x.com');
    const buy = { symbol: 'WTI', side: 'buy', type: 'market', quantity: 1 };
    const patch = (status, reason) => ctx.call('PATCH', '/admin/assets/WTI', { status, reason }, ctx.admin.token);
    assert.equal((await patch('paused', 'Data issue')).status, 200);
    assert.equal((await patch('paused')).status, 409, 'already paused');
    const blocked = await ctx.call('POST', '/orders', buy, bob.token);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'ASSET_UNAVAILABLE');
    assert.equal((await ctx.call('POST', '/orders', { ...buy, symbol: 'XAU' }, bob.token)).status, 201, 'other assets unaffected');
    const listed = (await ctx.call('GET', '/markets?q=wti', null, bob.token)).body.assets;
    assert.equal(listed[0].status, 'paused');
    assert.equal((await patch('active')).status, 200);
    assert.equal((await ctx.call('POST', '/orders', buy, bob.token)).status, 201);
    assert.deepEqual((await audit(ctx, '?action=asset.status')).entries.map((e) => e.details), [
      { from: 'paused', to: 'active', reason: null }, { from: 'active', to: 'paused', reason: 'Data issue' },
    ]);
  } finally { ctx.close(); }
});

test('assets: disabling hides it from the markets, blocks orders, and keeps existing holdings valued', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob', 'bob@x.com');
    await ctx.call('POST', '/orders', { symbol: 'SOL', side: 'buy', type: 'market', quantity: 1 }, bob.token);
    const resting = (await ctx.call('POST', '/orders', { symbol: 'SOL', side: 'buy', type: 'limit', quantity: 1, price: 1 }, bob.token)).body.order;
    await ctx.call('PATCH', '/admin/assets/SOL', { status: 'disabled' }, ctx.admin.token);
    const markets = (await ctx.call('GET', '/markets', null, bob.token)).body;
    assert.ok(!markets.assets.some((a) => a.symbol === 'SOL'));
    assert.equal((await ctx.call('GET', '/markets?q=solana', null, bob.token)).body.assets.length, 0);
    assert.equal((await ctx.call('POST', '/orders', { symbol: 'SOL', side: 'sell', type: 'market', quantity: 1 }, bob.token)).status, 409);
    const holdings = (await ctx.call('GET', '/portfolio', null, bob.token)).body.holdings;
    assert.equal(holdings[0].symbol, 'SOL');
    assert.ok(holdings[0].value > 0, 'still priced');
    ctx.db.prepare('UPDATE orders SET price = 1000000 WHERE id = ?').run(resting.id);
    matchPending(ctx.db);
    assert.equal(ctx.db.prepare('SELECT status FROM orders WHERE id = ?').get(resting.id).status, 'pending', 'no fills while disabled');
    const admin = (await ctx.call('GET', '/admin/assets', null, ctx.admin.token)).body.assets;
    assert.equal(admin.find((a) => a.symbol === 'SOL').status, 'disabled', 'administrators still see it');
    await ctx.call('PATCH', '/admin/assets/SOL', { status: 'active' }, ctx.admin.token);
    assert.ok((await ctx.call('GET', '/markets', null, bob.token)).body.assets.some((a) => a.symbol === 'SOL'));
  } finally { ctx.close(); }
});

test('assets: a new asset can be added, traded, and survives a restart; bad definitions are refused', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob', 'bob@x.com');
    const def = { symbol: 'zzt', name: 'Zed Test Coin', category: 'crypto', base: 12.5, liquidity: 100, volume: 1e6, risk: 'high', session: 'always' };
    const created = await ctx.call('POST', '/admin/assets', def, ctx.admin.token);
    assert.equal(created.status, 201);
    assert.equal(created.body.asset.symbol, 'ZZT');
    assert.equal(created.body.asset.custom, true);
    assert.equal((await ctx.call('POST', '/admin/assets', def, ctx.admin.token)).status, 400, 'duplicate symbol');
    for (const patch of [{ symbol: 'x' }, { name: '  ' }, { base: -1 }, { risk: 'extreme' }, { session: 'moon' }, { category: 'Not A Word' }, { liquidity: 0 }]) {
      assert.equal((await ctx.call('POST', '/admin/assets', { ...def, symbol: 'ZZU', ...patch }, ctx.admin.token)).status, 400, JSON.stringify(patch));
    }
    assert.ok(!ASSETS.some((a) => a.symbol === 'ZZU'));
    assert.equal((await ctx.call('POST', '/orders', { symbol: 'ZZT', side: 'buy', type: 'market', quantity: 1 }, bob.token)).status, 201);
    assert.ok((await ctx.call('GET', '/markets?q=zed', null, bob.token)).body.assets.length === 1);
    assert.equal((await ctx.call('PATCH', '/admin/assets/NOPE', { status: 'paused' }, ctx.admin.token)).status, 404);
    assert.equal((await ctx.call('PATCH', '/admin/assets/ZZT', { status: 'frozen' }, ctx.admin.token)).status, 400);

    // A second app on the same database picks up the stored asset and its status.
    await ctx.call('PATCH', '/admin/assets/ZZT', { status: 'paused' }, ctx.admin.token);
    const index = ASSETS.findIndex((a) => a.symbol === 'ZZT');
    ASSETS.splice(index, 1); // as if the process had just started
    const again = createApp(ctx.db, { secret: 's' }).listen(0);
    try {
      const reloaded = ASSETS.find((a) => a.symbol === 'ZZT');
      assert.equal(reloaded.name, 'Zed Test Coin');
      assert.equal(reloaded.status, 'paused');
    } finally { again.close(); }
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ audit log

test('audit log: filters, paging, newest first, and no secrets from identity checks', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob', 'bob@x.com');
    await ctx.call('POST', '/kyc', { fullName: 'Bob Builder', dateOfBirth: '1990-01-01', country: 'US', documentType: 'passport', documentNumber: 'SECRETDOC123' }, bob.token);
    const sub = (await ctx.call('GET', '/admin/kyc', null, ctx.admin.token)).body.submissions[0];
    await ctx.call('POST', `/admin/kyc/${sub.id}/approve`, null, ctx.admin.token);
    ctx.clock.t += 60 * MIN;
    await ctx.call('POST', `/admin/users/${bob.id}/suspend`, { reason: 'Review' }, ctx.admin.token);
    await ctx.call('POST', `/admin/users/${bob.id}/restore`, null, ctx.admin.token);

    const all = await audit(ctx);
    assert.deepEqual(all.entries.map((e) => e.action), ['user.restore', 'user.suspend', 'kyc.approve']);
    assert.ok(!JSON.stringify(all).includes('SECRETDOC123'), 'document contents are never logged');
    assert.ok(!JSON.stringify(all).includes('1990-01-01'));
    assert.deepEqual(all.entries[2].details, { submissionId: sub.id });
    assert.equal((await audit(ctx, '?action=user.')).total, 2, 'a prefix matches a family of actions');
    assert.equal((await audit(ctx, `?targetId=${bob.id}&targetType=user`)).total, 3);
    assert.equal((await audit(ctx, `?admin=${ctx.admin.id}`)).total, 3);
    assert.equal((await audit(ctx, '?admin=999')).total, 0);
    assert.equal((await audit(ctx, `?from=${Date.UTC(2026, 5, 1, 12, 30)}`)).total, 2);
    assert.equal((await audit(ctx, `?to=${Date.UTC(2026, 5, 1, 12, 30)}`)).total, 1);
    const page = await audit(ctx, '?limit=1&offset=1');
    assert.equal(page.total, 3);
    assert.equal(page.entries[0].action, 'user.suspend');
    assert.equal((await ctx.call('GET', '/admin/audit?from=soon', null, ctx.admin.token)).status, 400);
    assert.equal((await ctx.call('GET', '/admin/audit?admin=me', null, ctx.admin.token)).status, 400);
  } finally { ctx.close(); }
});

test('audit log: cannot be edited or deleted, even directly in the database', async () => {
  const ctx = await setup();
  try {
    await ctx.call('GET', `/admin/users/${ctx.admin.id}`, null, ctx.admin.token);
    assert.throws(() => ctx.db.prepare("UPDATE admin_audit SET action = 'nothing'").run(), /append-only/);
    assert.throws(() => ctx.db.prepare('DELETE FROM admin_audit').run(), /append-only/);
    assert.equal((await audit(ctx)).total, 1);
  } finally { ctx.close(); }
});

test('audit log: anything that looks like a password, token, secret or document is replaced', () => {
  const clean = sanitizeDetails({
    reason: 'fine', password: 'hunter2', newPassword: 'x', token: 't', resetToken: 'r', totpSecret: 'S', totp_secret: 'S', passwordHash: 'h',
    documentNumber: 'D1', recoveryCode: 'C', dateOfBirth: '1990', authorization: 'Bearer x',
    nested: { token: 'inner', amount: 5, list: [{ secret: 's', ok: 1 }] },
    long: 'x'.repeat(500),
  });
  assert.equal(clean.reason, 'fine');
  assert.equal(clean.nested.amount, 5);
  assert.equal(clean.nested.list[0].ok, 1);
  for (const key of ['password', 'newPassword', 'token', 'resetToken', 'totpSecret', 'totp_secret', 'passwordHash', 'documentNumber', 'recoveryCode', 'dateOfBirth', 'authorization']) {
    assert.equal(clean[key], '[redacted]', key);
  }
  assert.equal(clean.nested.token, '[redacted]');
  assert.equal(clean.nested.list[0].secret, '[redacted]');
  assert.ok(clean.long.length < 400);
  assert.equal(sanitizeDetails(null), null);
});

test('audit log: every administrator action leaves an entry (who, what, target, when)', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('Bob', 'bob@x.com');
    ctx.db.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").run(bob.id);
    const { body: { id: wid } } = await ctx.call('POST', '/wallet/withdraw', { amount: 5 }, bob.token);
    const a = ctx.admin.token;
    const actions = [
      () => ctx.call('GET', `/admin/users/${bob.id}`, null, a),
      () => ctx.call('GET', `/admin/users/${bob.id}/portfolio`, null, a),
      () => ctx.call('GET', `/admin/users/${bob.id}/orders`, null, a),
      () => ctx.call('POST', `/admin/users/${bob.id}/suspend`, { reason: 'Review' }, a),
      () => ctx.call('POST', `/admin/users/${bob.id}/restore`, null, a),
      () => ctx.call('POST', `/admin/users/${bob.id}/reset-balance`, { reason: 'Reset' }, a),
      () => ctx.call('POST', `/admin/withdrawals/${wid}/approve`, {}, a),
      () => ctx.call('GET', '/admin/failed-logins', null, a),
      () => ctx.call('POST', '/admin/announcements', { title: 'Hi', message: 'There' }, a),
      () => ctx.call('PATCH', '/admin/announcements/1', { active: false }, a),
      () => ctx.call('PATCH', '/admin/assets/BTC', { status: 'paused' }, a),
      () => ctx.call('POST', '/admin/assets', { symbol: 'AUD1', name: 'Audit Coin', category: 'crypto', base: 1, liquidity: 1, volume: 1, risk: 'low', session: 'always' }, a),
      () => ctx.call('GET', '/admin/reports/users', null, a),
    ];
    let expected = 0;
    for (const act of actions) {
      const r = await act();
      assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
      expected += 1;
      ctx.clock.t += 1000;
      assert.equal((await audit(ctx)).total, expected);
    }
    for (const e of (await audit(ctx)).entries) {
      assert.equal(e.admin.id, ctx.admin.id);
      assert.equal(e.admin.email, 'ada@x.com');
      assert.ok(e.action && e.targetType && e.at > 0);
    }
    await ctx.call('PATCH', '/admin/assets/BTC', { status: 'active' }, a);
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ reports

test('reports: CSV exports with correct content, safe cells, no secrets, and an audit entry', async () => {
  const ctx = await setup();
  try {
    const bob = await ctx.signUp('=HYPERLINK("http://evil")', 'bob@x.com');
    ctx.db.prepare("UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP' WHERE id = ?").run(bob.id);
    await ctx.call('POST', '/auth/login', { email: 'bob@x.com', password: 'wrong' });
    for (const type of ['users', 'orders', 'withdrawals', 'failed-logins', 'audit', 'assets']) {
      const res = await ctx.call('GET', `/admin/reports/${type}`, null, ctx.admin.token);
      assert.equal(res.status, 200, type);
      assert.match(res.headers.get('content-type'), /text\/csv/);
      assert.match(res.headers.get('content-disposition'), new RegExp(`admin-${type}-2026-06-01\\.csv`));
      assert.ok(!/JBSWY3DPEHPK3PXP|\$2[aby]\$/.test(res.body), `${type} leaks nothing sensitive`);
    }
    const users = (await ctx.call('GET', '/admin/reports/users', null, ctx.admin.token)).body.split('\r\n');
    assert.equal(users[0], 'id,name,email,role,email_verified,kyc_status,suspended,balance,currency,created_at');
    assert.equal(users.length, 4, 'header, two users and the trailing newline');
    assert.ok(users[2].includes(`"'=HYPERLINK(""http://evil"")"`), `formula defused: ${users[2]}`);
    assert.match((await ctx.call('GET', '/admin/reports/failed-logins', null, ctx.admin.token)).body, /bob@x\.com,\d+,bad_password/);
    assert.equal((await ctx.call('GET', '/admin/reports/passwords', null, ctx.admin.token)).status, 404);
    const exported = (await audit(ctx, '?action=report.export')).entries;
    assert.equal(exported.length, 8);
    assert.equal(exported.at(-1).details.rows, 2, 'the users report had two rows');
    assert.equal(exported.at(-1).targetId, 'users');
  } finally { ctx.close(); }
});

test('csv helper: quoting and formula protection', () => {
  assert.equal(toCsv(['a', 'b'], [[1, 'x,y'], ['say "hi"', null], ['=1+1', '-5'], [-5, '@a']]),
    'a,b\r\n1,"x,y"\r\n"say ""hi""",\r\n\'=1+1,\'-5\r\n-5,\'@a\r\n');
});
