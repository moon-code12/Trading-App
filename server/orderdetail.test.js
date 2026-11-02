import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { getAsset, priceAt } from './src/market.js';
import { cancelOrder, dayEnd, explainOrder, getOrderDetail, matchPending, placeOrder } from './src/trading.js';

const DAY = 24 * 3600e3;
const T0 = Date.parse('2026-03-10T08:00:00Z'); // aligned to a 5 s liquidity slot
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const P = (symbol, t) => priceAt(getAsset(symbol), t);
const r6 = (n) => Math.round(n * 1e6) / 1e6;

function mk(email = 't@x.com') {
  const db = openDb(':memory:');
  const id = db.prepare("INSERT INTO users (name, email, password_hash, balance, large_order_pct, created_at) VALUES ('T', ?, 'x', 1000000, 100, ?)")
    .run(email, sqlTime(T0 - 5 * DAY)).lastInsertRowid;
  return { db, user: { id } };
}
const place = (ctx, spec, now = T0) => placeOrder(ctx.db, ctx.user, spec, now);
const detail = (ctx, id, now = T0) => getOrderDetail(ctx.db, ctx.user.id, id, now);

function find(symbol, from, pred, step = 10e3) {
  for (let t = from; t < from + 3 * DAY; t += step) if (pred(P(symbol, t))) return t;
  throw new Error('no matching price');
}

test('detail: a part-filled market order shows its fills, progress and what happens next', () => {
  const ctx = mk();
  const { order } = place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 12 });
  let d = detail(ctx, order.id, T0 + 1000);
  assert.deepEqual(d.fills.map((f) => f.quantity), [5]);
  assert.equal(d.summary.filled, 5);
  assert.equal(d.summary.remaining, 7);
  assert.equal(d.summary.progressPct, r6((5 / 12) * 100));
  assert.equal(d.summary.working, true);
  assert.equal(d.summary.avgFillPrice, P('ETH', T0));
  assert.equal(d.summary.mode, 'demo');
  assert.equal(d.live.slicesRemaining, 2);
  assert.equal(d.live.price, P('ETH', T0 + 1000));
  // This slot already filled, so the next fill can only happen when the next 5 s slot opens.
  assert.equal(d.live.nextFillAt, new Date(T0 + 5000).toISOString());
  assert.match(d.explanation, /liquidity/);
  assert.match(d.explanation, /about 2 more slices/);

  matchPending(ctx.db, T0 + 5000);
  matchPending(ctx.db, T0 + 10000);
  d = detail(ctx, order.id, T0 + 10000);
  assert.deepEqual(d.fills.map((f) => f.quantity), [5, 5, 2]);
  assert.equal(d.summary.progressPct, 100);
  assert.equal(d.summary.remaining, 0);
  assert.equal(d.summary.working, false);
  assert.equal(d.live, null);
  assert.match(d.explanation, /^Filled completely/);

  const vwap = d.fills.reduce((s, f) => s + f.price * f.quantity, 0) / 12;
  assert.ok(Math.abs(d.summary.avgFillPrice - vwap) < 1e-5);
  for (const f of d.fills) assert.equal(f.amount, Math.round(f.price * f.quantity * 100) / 100);
  assert.ok(Math.abs(d.summary.totalValue - d.fills.reduce((s, f) => s + f.amount, 0)) < 0.02);
  assert.deepEqual(d.fills.map((f) => f.filledAt), [T0, T0 + 5000, T0 + 10000].map((t) => new Date(t).toISOString()));
});

test('detail: a part-filled order that has not been touched this slot can fill straight away', () => {
  const ctx = mk();
  const { order } = place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 12 });
  const d = detail(ctx, order.id, T0 + 5000);
  assert.equal(d.live.nextFillAt, new Date(T0 + 5000).toISOString());
});

test('detail: a limit order says what it waits for and how far away the price is', () => {
  const ctx = mk();
  const limit = r6(P('ETH', T0) * 0.97);
  const { order } = place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: limit });
  const d = detail(ctx, order.id);
  assert.equal(d.fills.length, 0);
  assert.equal(d.summary.avgFillPrice, null);
  assert.equal(d.summary.progressPct, 0);
  assert.match(d.explanation, /Waiting for the price to fall to .* or lower/);
  assert.match(d.explanation, /\d+\.\d\d% above your limit/);
  assert.equal(d.live.slicesRemaining, 1);
});

test('detail: stop-loss, take-profit and stop orders explain their trigger', () => {
  const ctx = mk();
  place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 3 });
  const p = P('ETH', T0 + 60e3);
  const t = T0 + 60e3;
  const sl = place(ctx, { symbol: 'ETH', side: 'sell', type: 'stop_loss', quantity: 1, price: p * 0.9 }, t).order;
  const tp = place(ctx, { symbol: 'ETH', side: 'sell', type: 'take_profit', quantity: 1, price: p * 1.1 }, t).order;
  const st = place(ctx, { symbol: 'ETH', side: 'sell', type: 'stop', quantity: 1, price: p * 0.8 }, t).order;
  assert.match(detail(ctx, sl.id, t).explanation, /Will sell at market once the price falls to .*above the stop/);
  assert.match(detail(ctx, tp.id, t).explanation, /Will sell once the price rises to .*below your target/);
  assert.match(detail(ctx, st.id, t).explanation, /Will sell at market once the price falls to/);
});

test('detail: a stop-limit reads differently before and after its stop is reached', () => {
  const ctx = mk();
  place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 1 });
  const tp = T0 + 60e3;
  const stop = r6(P('ETH', tp) * 0.995);
  const limit = r6(stop * 1.01); // above the stop, so after triggering it must wait
  const { order } = place(ctx, { symbol: 'ETH', side: 'sell', type: 'stop_limit', quantity: 1, price: stop, limitPrice: limit }, tp);
  assert.match(detail(ctx, order.id, tp).explanation, /Waiting for the price to fall to the stop at .*then it will sell at/);
  const t = find('ETH', tp + 10e3, (x) => x <= stop);
  matchPending(ctx.db, t);
  const d = detail(ctx, order.id, t);
  assert.equal(d.order.status, 'pending');
  assert.match(d.explanation, /The stop at .* was reached\. Now waiting to sell at/);
});

test('detail: a trailing stop shows the highest price seen and the current stop level', () => {
  const ctx = mk();
  place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 1 });
  const { order } = place(ctx, { symbol: 'ETH', side: 'sell', type: 'trailing_stop', quantity: 1, trailPercent: 5 }, T0 + 60e3);
  const d = detail(ctx, order.id, T0 + 60e3);
  assert.match(d.explanation, /trails 5% below the highest price seen/);
  assert.match(d.explanation, /moves up if the price makes new highs/);
  assert.equal(d.order.peak_price, P('ETH', T0 + 60e3));
});

test('detail: linked OCO legs are listed, and a cancelled order says why', () => {
  const ctx = mk();
  place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 2 });
  const tp = T0 + 60e3;
  const p = P('ETH', tp);
  const { orders: [a, b] } = place(ctx, { symbol: 'ETH', side: 'sell', quantity: 2, legs: [{ type: 'take_profit', price: p * 1.2 }, { type: 'stop_loss', price: p * 0.8 }] }, tp);
  let d = detail(ctx, a.id, tp);
  assert.equal(d.linked.length, 1);
  assert.equal(d.linked[0].id, b.id);
  assert.equal(d.linked[0].type, 'stop_loss');
  assert.equal(detail(ctx, b.id, tp).linked[0].id, a.id);
  assert.deepEqual(detail(ctx, place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 0.1 }, tp).order.id, tp).linked, []);
  cancelOrder(ctx.db, ctx.user.id, a.id);
  d = detail(ctx, b.id, tp);
  assert.equal(d.order.status, 'cancelled');
  assert.match(d.explanation, /Cancelled by you\. Nothing was filled\./);
});

test('detail: cancelled after a partial fill keeps the filled part; expired and rejected explain themselves', () => {
  const ctx = mk();
  const { order } = place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 12 });
  cancelOrder(ctx.db, ctx.user.id, order.id);
  let d = detail(ctx, order.id, T0 + 1000);
  assert.equal(d.summary.working, false);
  assert.match(d.explanation, /5 ETH had already filled and stays in your portfolio/);

  const day = place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: P('ETH', T0) * 0.5, timeInForce: 'day' }).order;
  matchPending(ctx.db, dayEnd(T0));
  d = detail(ctx, day.id, dayEnd(T0));
  assert.equal(d.order.status, 'expired');
  assert.match(d.explanation, /expired at the end of the UTC day with 0 of 1 ETH filled/);

  const ctx2 = mk();
  place(ctx2, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 2 });
  const p = P('ETH', T0 + 60e3);
  const { order: sl } = place(ctx2, { symbol: 'ETH', side: 'sell', type: 'stop_loss', quantity: 2, price: r6(p * 0.996) }, T0 + 60e3);
  ctx2.db.prepare('DELETE FROM holdings').run();
  matchPending(ctx2.db, find('ETH', T0 + 70e3, (x) => x <= p * 0.996));
  d = detail(ctx2, sl.id);
  assert.equal(d.order.status, 'rejected');
  assert.match(d.explanation, /^Rejected: Insufficient holdings\. Nothing was filled\./);
});

test('detail: only your own orders are visible', () => {
  const ctx = mk('a@x.com');
  const { order } = place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 1 });
  const otherId = ctx.db.prepare("INSERT INTO users (name, email, password_hash, balance, created_at) VALUES ('O', 'o@x.com', 'x', 1000, ?)").run(sqlTime(T0 - DAY)).lastInsertRowid;
  assert.equal(getOrderDetail(ctx.db, otherId, order.id, T0), null);
  assert.equal(getOrderDetail(ctx.db, ctx.user.id, 99999, T0), null);
  assert.ok(getOrderDetail(ctx.db, ctx.user.id, order.id, T0));
});

test('explainOrder: terminal and unusual states', () => {
  const base = { symbol: 'ETH', side: 'buy', quantity: 2, filled_quantity: 0, fill_price: null, note: null, triggered: 0 };
  assert.match(explainOrder({ ...base, status: 'filled', filled_quantity: 2, fill_price: 3400.5 }, 3400), /Filled completely: 2 ETH at an average 3,400\.5/);
  assert.match(explainOrder({ ...base, status: 'cancelled', note: 'The other leg filled.', filled_quantity: 0 }, 3400), /The other leg filled\. Nothing was filled/);
  assert.match(explainOrder({ ...base, status: 'rejected', note: null }, 3400), /Rejected: the order could not be completed/);
  assert.match(explainOrder({ ...base, status: 'pending', type: 'stop', triggered: 1, price: 3300 }, 3400), /now working as a market order/);
});

// ------------------------------------------------------------------ HTTP

test('API: GET /orders/:id returns the detail, and refuses other users, bad ids and missing orders', async () => {
  const db = openDb(':memory:');
  const server = createApp(db, { secret: 's', log: () => {} }).listen(0);
  const base = `http://localhost:${server.address().port}/api`;
  try {
    const login = async (email) => {
      const reg = await (await fetch(`${base}/auth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'T', email, password: 'password1' }),
      })).json();
      return async (method, path, body) => {
        const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` }, body: body && JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
      };
    };
    const a = await login('a@x.com');
    const b = await login('b@x.com');
    const placed = await a('POST', '/orders', { symbol: 'AAPL', side: 'buy', type: 'market', quantity: 30, confirmLarge: true });
    assert.equal(placed.status, 201);
    const id = placed.body.order.id;
    const got = await a('GET', `/orders/${id}`);
    assert.equal(got.status, 200);
    for (const k of ['order', 'fills', 'summary', 'linked', 'explanation']) assert.ok(k in got.body, k);
    assert.equal(got.body.summary.quantity, 30);
    assert.ok(got.body.fills.length >= 1 && got.body.fills[0].quantity === 25); // AAPL liquidity is 25 per slot
    assert.equal(got.body.summary.mode, 'demo');
    assert.equal((await b('GET', `/orders/${id}`)).status, 404);
    assert.equal((await a('GET', '/orders/99999')).status, 404);
    for (const bad of ['abc', '1.5', '-1', '1e3']) assert.equal((await a('GET', `/orders/${bad}`)).status, 400, bad);
    assert.equal((await fetch(`${base}/orders/${id}`)).status, 401);
  } finally { server.close(); }
});
