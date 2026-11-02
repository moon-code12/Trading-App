import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { getAsset, priceAt } from './src/market.js';
import {
  OrderError, cancelOrder, dayEnd, matchPending, placeOrder, previewOrder, riskSettings, updateRiskSettings,
} from './src/trading.js';

const DAY = 24 * 3600e3;
const T0 = Date.parse('2026-03-10T08:00:00Z'); // aligned to a 5 s liquidity slot, fixed so prices are reproducible
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const P = (symbol, t) => priceAt(getAsset(symbol), t);
const r6 = (n) => Math.round(n * 1e6) / 1e6;

function mk({ balance = 1e6, largePct = 50 } = {}) {
  const db = openDb(':memory:');
  const id = db.prepare("INSERT INTO users (name, email, password_hash, balance, large_order_pct, created_at) VALUES ('T', 't@x.com', 'x', ?, ?, ?)")
    .run(balance, largePct, sqlTime(T0 - 5 * DAY)).lastInsertRowid;
  return { db, user: { id } };
}
const order = (db, id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const holding = (db, uid, sym) => db.prepare('SELECT * FROM holdings WHERE user_id = ? AND symbol = ?').get(uid, sym);
const balance = (db, uid) => db.prepare('SELECT balance FROM users WHERE id = ?').get(uid).balance;
const fillsOf = (db, id) => db.prepare('SELECT * FROM fills WHERE order_id = ? ORDER BY id').all(id);
const place = (ctx, spec, now = T0, opts) => placeOrder(ctx.db, ctx.user, spec, now, opts);
const marketBuy = (ctx, symbol, quantity, now = T0) => place(ctx, { symbol, side: 'buy', type: 'market', quantity }, now).order;

// First time at or after `from` (10 s steps) where the price satisfies `pred`.
function find(symbol, from, pred, { step = 10e3, max = 3 * DAY } = {}) {
  for (let t = from; t < from + max; t += step) if (pred(P(symbol, t), t)) return t;
  throw new Error(`no matching price for ${symbol} after ${new Date(from).toISOString()}`);
}
const rejects = (fn, re, extra = {}) => assert.throws(fn, (e) => {
  assert.ok(e instanceof OrderError, `expected OrderError, got ${e}`);
  assert.match(e.message, re);
  for (const [k, v] of Object.entries(extra)) assert.equal(e[k], v);
  return true;
});

// ------------------------------------------------------------------ order types

test('market order fills immediately, records a fill and defaults to a day order', () => {
  const ctx = mk();
  const o = marketBuy(ctx, 'ETH', 1);
  assert.equal(o.status, 'filled');
  assert.equal(o.fill_price, P('ETH', T0));
  assert.equal(o.tif, 'day');
  assert.equal(o.expires_at, dayEnd(T0));
  assert.equal(fillsOf(ctx.db, o.id).length, 1);
  assert.equal(holding(ctx.db, ctx.user.id, 'ETH').quantity, 1);
  const tx = ctx.db.prepare('SELECT * FROM transactions WHERE order_id = ?').get(o.id);
  assert.equal(tx.fill_id, fillsOf(ctx.db, o.id)[0].id);
});

test('limit order rests, then fills at the market price once the limit is reachable', () => {
  const ctx = mk();
  const p = P('ETH', T0);
  const limit = r6(p * 0.995);
  const o = place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: limit }).order;
  assert.equal(o.status, 'pending');
  assert.equal(o.tif, 'gtc');
  assert.equal(o.expires_at, null);
  const t = find('ETH', T0 + 10e3, (x) => x <= limit);
  matchPending(ctx.db, t - 10e3);
  assert.equal(order(ctx.db, o.id).status, 'pending');
  matchPending(ctx.db, t);
  const done = order(ctx.db, o.id);
  assert.equal(done.status, 'filled');
  assert.ok(done.fill_price <= limit);
});

test('stop order: a sell stop triggers when the price falls to it and sells at market', () => {
  const ctx = mk();
  marketBuy(ctx, 'ETH', 2);
  const tp = T0 + 60e3;
  const stop = r6(P('ETH', tp) * 0.995);
  const o = place(ctx, { symbol: 'ETH', side: 'sell', type: 'stop', quantity: 2, price: stop }, tp).order;
  assert.equal(o.status, 'pending');
  const t = find('ETH', tp + 10e3, (x) => x <= stop);
  matchPending(ctx.db, t - 10e3);
  assert.equal(order(ctx.db, o.id).status, 'pending');
  matchPending(ctx.db, t);
  assert.equal(order(ctx.db, o.id).status, 'filled');
  assert.equal(holding(ctx.db, ctx.user.id, 'ETH'), undefined);
});

test('stop-loss: sell-only, must sit below the market, and sells when the stop is hit', () => {
  const ctx = mk();
  marketBuy(ctx, 'ETH', 2);
  const tp = T0 + 60e3;
  const p = P('ETH', tp);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'sell', type: 'stop_loss', quantity: 1, price: p * 1.01 }, tp), /below the current price/);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'buy', type: 'stop_loss', quantity: 1, price: p * 0.9 }, tp), /only be used to sell/);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'sell', type: 'stop_loss', quantity: 1 }, tp), /Stop-loss price is required/);
  const stop = r6(p * 0.995);
  const o = place(ctx, { symbol: 'ETH', side: 'sell', type: 'stop_loss', quantity: 2, price: stop }, tp).order;
  const t = find('ETH', tp + 10e3, (x) => x <= stop);
  const cash = balance(ctx.db, ctx.user.id);
  matchPending(ctx.db, t);
  const done = order(ctx.db, o.id);
  assert.equal(done.status, 'filled');
  assert.ok(done.fill_price <= stop);
  assert.equal(r6(balance(ctx.db, ctx.user.id) - cash), r6(Math.round(done.fill_price * 2 * 100) / 100));
});

test('take-profit: sell-only, must sit above the market, and sells when the target is hit', () => {
  const ctx = mk();
  marketBuy(ctx, 'ETH', 2);
  const tp = T0 + 60e3;
  const p = P('ETH', tp);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'sell', type: 'take_profit', quantity: 1, price: p * 0.99 }, tp), /above the current price/);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'buy', type: 'take_profit', quantity: 1, price: p * 1.1 }, tp), /only be used to sell/);
  const target = r6(p * 1.005);
  const o = place(ctx, { symbol: 'ETH', side: 'sell', type: 'take_profit', quantity: 2, price: target }, tp).order;
  const t = find('ETH', tp + 10e3, (x) => x >= target);
  matchPending(ctx.db, t - 10e3);
  assert.equal(order(ctx.db, o.id).status, 'pending');
  matchPending(ctx.db, t);
  const done = order(ctx.db, o.id);
  assert.equal(done.status, 'filled');
  assert.ok(done.fill_price >= target);
});

test('stop-limit: triggers at the stop, then only fills while the limit is satisfied', () => {
  const ctx = mk();
  marketBuy(ctx, 'ETH', 2);
  const tp = T0 + 60e3;
  const p = P('ETH', tp);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'sell', type: 'stop_limit', quantity: 1, price: p * 0.99 }, tp), /Limit price is required/);

  // Limit above the stop: once triggered the price is below the limit, so the order must wait.
  const stop = r6(p * 0.995);
  const limit = r6(stop * 1.01);
  const o = place(ctx, { symbol: 'ETH', side: 'sell', type: 'stop_limit', quantity: 2, price: stop, limitPrice: limit }, tp).order;
  const t1 = find('ETH', tp + 10e3, (x) => x <= stop);
  matchPending(ctx.db, t1);
  let cur = order(ctx.db, o.id);
  assert.equal(cur.status, 'pending');
  assert.equal(cur.triggered, 1); // stop reached, now behaves as a limit order
  assert.equal(holding(ctx.db, ctx.user.id, 'ETH').quantity, 2);
  const t2 = find('ETH', t1 + 10e3, (x) => x >= limit);
  matchPending(ctx.db, t2);
  cur = order(ctx.db, o.id);
  assert.equal(cur.status, 'filled');
  assert.ok(cur.fill_price >= limit);
});

test('stop-limit that is already inside its limit fills as soon as it triggers', () => {
  const ctx = mk();
  marketBuy(ctx, 'ETH', 1);
  const tp = T0 + 60e3;
  const stop = r6(P('ETH', tp) * 0.995);
  const limit = r6(stop * 0.9);
  const o = place(ctx, { symbol: 'ETH', side: 'sell', type: 'stop_limit', quantity: 1, price: stop, limitPrice: limit }, tp).order;
  const t = find('ETH', tp + 10e3, (x) => x <= stop);
  matchPending(ctx.db, t);
  assert.equal(order(ctx.db, o.id).status, 'filled');
});

test('buy stop-limit rests until the price rises to the stop, then buys within the limit', () => {
  const ctx = mk();
  const p = P('ETH', T0);
  const stop = r6(p * 1.005);
  const limit = r6(stop * 1.05);
  const o = place(ctx, { symbol: 'ETH', side: 'buy', type: 'stop_limit', quantity: 1, price: stop, limitPrice: limit }).order;
  assert.equal(o.status, 'pending');
  const t = find('ETH', T0 + 10e3, (x) => x >= stop);
  matchPending(ctx.db, t);
  const done = order(ctx.db, o.id);
  assert.equal(done.status, 'filled');
  assert.ok(done.fill_price >= stop && done.fill_price <= limit);
});

test('trailing stop: the stop follows new highs and never moves down', () => {
  const ctx = mk();
  marketBuy(ctx, 'ETH', 1);
  // Pick a start where the price keeps climbing for a while so the peak must move.
  const start = find('ETH', T0, (x, t) => P('ETH', t + 30 * 60e3) > x * 1.01, { step: 60e3 });
  const p0 = P('ETH', start);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'buy', type: 'trailing_stop', quantity: 1, trailPercent: 3 }, start), /only be used to sell/);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'sell', type: 'trailing_stop', quantity: 1 }, start), /either a trailing amount or a trailing percent/);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'sell', type: 'trailing_stop', quantity: 1, trailAmount: 5, trailPercent: 3 }, start), /either a trailing amount or a trailing percent/);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'sell', type: 'trailing_stop', quantity: 1, trailPercent: 100 }, start), /below 100/);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'sell', type: 'trailing_stop', quantity: 1, trailAmount: p0 + 1 }, start), /smaller than the current price/);

  const o = place(ctx, { symbol: 'ETH', side: 'sell', type: 'trailing_stop', quantity: 1, trailPercent: 3 }, start).order;
  assert.equal(o.peak_price, p0);
  assert.equal(o.price, r6(p0 * 0.97));
  let lastPeak = p0;
  for (let t = start + 60e3; t <= start + 30 * 60e3; t += 60e3) {
    matchPending(ctx.db, t);
    const cur = order(ctx.db, o.id);
    assert.equal(cur.status, 'pending');
    assert.ok(cur.peak_price >= lastPeak, 'peak never decreases');
    assert.equal(cur.price, r6(cur.peak_price * 0.97));
    lastPeak = cur.peak_price;
  }
  assert.ok(lastPeak > p0, 'the stop level rose with the price');
});

test('trailing stop sells once the price falls the trailing distance from its peak', () => {
  const ctx = mk();
  marketBuy(ctx, 'ETH', 1);
  const start = T0 + 60e3;
  const o = place(ctx, { symbol: 'ETH', side: 'sell', type: 'trailing_stop', quantity: 1, trailAmount: P('ETH', start) * 0.004 }, start).order;
  let done;
  for (let t = start + 10e3; t < start + DAY && !done; t += 10e3) {
    matchPending(ctx.db, t);
    const cur = order(ctx.db, o.id);
    if (cur.status === 'filled') done = { cur, t };
  }
  assert.ok(done, 'trailing stop eventually triggers');
  assert.ok(done.cur.fill_price <= done.cur.peak_price - o.trail_value + 1e-6);
  assert.equal(holding(ctx.db, ctx.user.id, 'ETH'), undefined);
});

// ------------------------------------------------------------------ OCO

test('OCO: when one leg fills the other is cancelled in the same step and shares sell once', () => {
  const ctx = mk();
  marketBuy(ctx, 'ETH', 2);
  const tp = T0 + 60e3;
  const p = P('ETH', tp);
  const target = r6(p * 1.004);
  const stop = r6(p * 0.9);
  const { orders } = place(ctx, { symbol: 'ETH', side: 'sell', quantity: 2, legs: [{ type: 'take_profit', price: target }, { type: 'stop_loss', price: stop }] }, tp);
  const [a, b] = orders;
  assert.equal(a.oco_group, a.id);
  assert.equal(b.oco_group, a.id);
  const t = find('ETH', tp + 10e3, (x) => x >= target || x <= stop);
  assert.ok(P('ETH', t) >= target, 'take-profit leg is the one that fires');
  matchPending(ctx.db, t);
  assert.equal(order(ctx.db, a.id).status, 'filled');
  const other = order(ctx.db, b.id);
  assert.equal(other.status, 'cancelled');
  assert.match(other.note, /other leg filled/i);
  assert.equal(fillsOf(ctx.db, b.id).length, 0);
  assert.equal(holding(ctx.db, ctx.user.id, 'ETH'), undefined);
  matchPending(ctx.db, t + 10e3); // nothing left to fire
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM fills WHERE side = ?').get('sell').c, 1);
});

test('OCO: the stop-loss leg can fire first and cancels the take-profit', () => {
  const ctx = mk();
  marketBuy(ctx, 'ETH', 1);
  const tp = T0 + 60e3;
  const p = P('ETH', tp);
  const stop = r6(p * 0.996);
  const { orders: [a, b] } = place(ctx, { symbol: 'ETH', side: 'sell', quantity: 1, legs: [{ type: 'take_profit', price: p * 1.2 }, { type: 'stop_loss', price: stop }] }, tp);
  const t = find('ETH', tp + 10e3, (x) => x <= stop);
  matchPending(ctx.db, t);
  assert.equal(order(ctx.db, b.id).status, 'filled');
  assert.equal(order(ctx.db, a.id).status, 'cancelled');
});

test('OCO: cancelling either leg cancels both, and the pair reserves shares only once', () => {
  const ctx = mk();
  marketBuy(ctx, 'ETH', 2);
  const tp = T0 + 60e3;
  const p = P('ETH', tp);
  const legs = [{ type: 'take_profit', price: p * 1.05 }, { type: 'stop_loss', price: p * 0.95 }];
  const { orders: [a, b] } = place(ctx, { symbol: 'ETH', side: 'sell', quantity: 2, legs }, tp);
  // Both legs cover all 2 shares, yet no further sell fits because the pair already holds them.
  rejects(() => place(ctx, { symbol: 'ETH', side: 'sell', type: 'limit', quantity: 0.5, price: p * 2 }, tp), /Insufficient holdings/);
  assert.deepEqual(cancelOrder(ctx.db, ctx.user.id, b.id).sort(), [a.id, b.id].sort());
  assert.equal(order(ctx.db, a.id).status, 'cancelled');
  assert.equal(order(ctx.db, b.id).status, 'cancelled');
  place(ctx, { symbol: 'ETH', side: 'sell', type: 'limit', quantity: 2, price: p * 2 }, tp); // shares free again
});

test('OCO: validation of legs', () => {
  const ctx = mk();
  marketBuy(ctx, 'ETH', 2);
  const tp = T0 + 60e3;
  const p = P('ETH', tp);
  const sell = (legs, extra = {}) => () => place(ctx, { symbol: 'ETH', side: 'sell', quantity: 1, legs, ...extra }, tp);
  rejects(sell([{ type: 'limit', price: p * 1.1 }]), /exactly two legs/);
  rejects(sell([{ type: 'market' }, { type: 'limit', price: p * 1.1 }]), /OCO legs must be one of/);
  rejects(sell([{ type: 'trailing_stop' }, { type: 'limit', price: p * 1.1 }]), /OCO legs must be one of/);
  rejects(sell([{ type: 'limit', price: p * 0.9 }, { type: 'stop', price: p * 0.8 }]), /rest away from the current price/);
  rejects(sell([{ type: 'limit', price: p * 1.1 }, { type: 'stop_loss', price: p * 0.9 }], { quantity: 5 }), /Insufficient holdings/);
});

test('OCO: if a leg cannot fill, the whole fill rolls back and the pair is closed', () => {
  const ctx = mk();
  marketBuy(ctx, 'ETH', 2);
  const tp = T0 + 60e3;
  const p = P('ETH', tp);
  const stop = r6(p * 0.996);
  const { orders: [a, b] } = place(ctx, { symbol: 'ETH', side: 'sell', quantity: 2, legs: [{ type: 'take_profit', price: p * 1.2 }, { type: 'stop_loss', price: stop }] }, tp);
  ctx.db.prepare('DELETE FROM holdings WHERE user_id = ?').run(ctx.user.id); // shares vanish before the trigger
  const cash = balance(ctx.db, ctx.user.id);
  const t = find('ETH', tp + 10e3, (x) => x <= stop);
  matchPending(ctx.db, t);
  assert.equal(order(ctx.db, b.id).status, 'rejected');
  assert.match(order(ctx.db, b.id).note, /Insufficient holdings/);
  assert.equal(order(ctx.db, a.id).status, 'cancelled');
  assert.equal(balance(ctx.db, ctx.user.id), cash, 'no money moved');
  assert.equal(fillsOf(ctx.db, b.id).length, 0, 'no partial bookkeeping left behind');
});

// ------------------------------------------------------------------ time in force and expiry

test('day order expires at the end of the UTC day, keeping what was already filled', () => {
  const ctx = mk();
  const p = P('ETH', T0);
  const o = place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: p * 0.5, timeInForce: 'day' }).order;
  assert.equal(o.expires_at, Date.parse('2026-03-11T00:00:00Z'));
  matchPending(ctx.db, dayEnd(T0) - 1000);
  assert.equal(order(ctx.db, o.id).status, 'pending');
  matchPending(ctx.db, dayEnd(T0));
  const done = order(ctx.db, o.id);
  assert.equal(done.status, 'expired');
  assert.match(done.note, /expired/i);
  assert.ok(ctx.db.prepare("SELECT 1 FROM notifications WHERE message LIKE '%expired%'").get());
  // The reserved cash is free again, and an expired order cannot be cancelled.
  assert.equal(cancelOrder(ctx.db, ctx.user.id, o.id), null);
  assert.equal(riskSettings(ctx.db, ctx.user.id, T0).mode, 'demo');
});

test('good-till-cancelled order never expires on its own', () => {
  const ctx = mk();
  const p = P('ETH', T0);
  const o = place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: p * 0.5, timeInForce: 'gtc' }).order;
  assert.equal(o.tif, 'gtc');
  assert.equal(o.expires_at, null);
  matchPending(ctx.db, T0 + 60 * DAY);
  assert.equal(order(ctx.db, o.id).status, 'pending');
  assert.equal(cancelOrder(ctx.db, ctx.user.id, o.id).length, 1);
  assert.equal(order(ctx.db, o.id).status, 'cancelled');
});

test('a day order that fills before the day ends is not expired afterwards', () => {
  const ctx = mk();
  const o = place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: P('ETH', T0) * 2, timeInForce: 'day' }).order;
  assert.equal(order(ctx.db, o.id).status, 'filled');
  matchPending(ctx.db, dayEnd(T0) + DAY);
  assert.equal(order(ctx.db, o.id).status, 'filled');
});

test('expired day orders release their reservation', () => {
  const ctx = mk({ balance: 10000, largePct: 100 });
  const p = P('ETH', T0);
  place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 2, price: p * 0.9, timeInForce: 'day' });
  rejects(() => place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 2, price: p * 0.9 }), /Insufficient funds/);
  matchPending(ctx.db, dayEnd(T0));
  const next = dayEnd(T0) + 1000;
  place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 2, price: P('ETH', next) * 0.9 }, next);
});

test('invalid time in force is rejected', () => {
  const ctx = mk();
  rejects(() => place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 1, timeInForce: 'forever' }), /Time in force/);
});

// ------------------------------------------------------------------ partial fills

test('partial fills: liquidity limits each slot and the rest fills over time', () => {
  const ctx = mk();
  const { order: o, warnings } = place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 12 });
  assert.ok(warnings.some((w) => w.code === 'PARTIAL_FILL'));
  assert.equal(o.status, 'partially_filled');
  assert.equal(o.filled_quantity, 5);
  matchPending(ctx.db, T0 + 1000); // same 5 s slot: no more liquidity
  assert.equal(order(ctx.db, o.id).filled_quantity, 5);
  matchPending(ctx.db, T0 + 5000);
  assert.equal(order(ctx.db, o.id).filled_quantity, 10);
  assert.equal(order(ctx.db, o.id).status, 'partially_filled');
  matchPending(ctx.db, T0 + 10000);
  const done = order(ctx.db, o.id);
  assert.equal(done.status, 'filled');
  assert.equal(done.filled_quantity, 12);

  const fills = fillsOf(ctx.db, o.id);
  assert.deepEqual(fills.map((f) => f.quantity), [5, 5, 2]);
  const vwap = fills.reduce((s, f) => s + f.price * f.quantity, 0) / 12;
  assert.ok(Math.abs(done.fill_price - vwap) < 1e-5, 'order shows the volume-weighted average price');
  assert.equal(holding(ctx.db, ctx.user.id, 'ETH').quantity, 12);
  assert.ok(Math.abs(holding(ctx.db, ctx.user.id, 'ETH').avg_cost - vwap) < 1e-5);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM transactions WHERE order_id = ?').get(o.id).c, 3);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) c FROM notifications WHERE message LIKE '%partially filled%'").get().c, 1);
  const spent = ctx.db.prepare('SELECT SUM(amount) s FROM transactions WHERE order_id = ?').get(o.id).s;
  assert.ok(Math.abs(1e6 + spent - balance(ctx.db, ctx.user.id)) < 0.01);
});

test('partial fills: selling a large position also fills in parts and never oversells', () => {
  const ctx = mk();
  place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 5 });
  place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 5 }, T0 + 5000);
  const { order: o } = place(ctx, { symbol: 'ETH', side: 'sell', type: 'market', quantity: 10 }, T0 + 10000);
  assert.equal(o.filled_quantity, 5);
  assert.equal(holding(ctx.db, ctx.user.id, 'ETH').quantity, 5);
  matchPending(ctx.db, T0 + 15000);
  assert.equal(order(ctx.db, o.id).status, 'filled');
  assert.equal(holding(ctx.db, ctx.user.id, 'ETH'), undefined);
});

test('partial fills: cancelling keeps what filled and drops the rest', () => {
  const ctx = mk();
  const { order: o } = place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 12 });
  assert.equal(cancelOrder(ctx.db, ctx.user.id, o.id).length, 1);
  matchPending(ctx.db, T0 + 5000);
  const cur = order(ctx.db, o.id);
  assert.equal(cur.status, 'cancelled');
  assert.equal(cur.filled_quantity, 5);
  assert.equal(holding(ctx.db, ctx.user.id, 'ETH').quantity, 5);
});

test('partial fills: a day order that expires mid-fill keeps its partial quantity', () => {
  const ctx = mk();
  const { order: o } = place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 12 });
  matchPending(ctx.db, dayEnd(T0));
  const cur = order(ctx.db, o.id);
  assert.equal(cur.status, 'expired');
  assert.equal(cur.filled_quantity, 5);
});

test('partial fills: a triggered stop keeps working through later slots', () => {
  const ctx = mk();
  place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 5 });
  place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 5 }, T0 + 5000);
  const tp = T0 + 60e3;
  const stop = r6(P('ETH', tp) * 0.995);
  const { order: o } = place(ctx, { symbol: 'ETH', side: 'sell', type: 'stop_loss', quantity: 10, price: stop }, tp);
  const t = find('ETH', tp + 10e3, (x) => x <= stop);
  matchPending(ctx.db, t);
  assert.equal(order(ctx.db, o.id).filled_quantity, 5);
  matchPending(ctx.db, t + 5000); // price may have bounced above the stop; the trigger is latched
  assert.equal(order(ctx.db, o.id).status, 'filled');
});

// ------------------------------------------------------------------ server-side validation

test('validation: cannot sell more than owned, including shares held by other working orders', () => {
  const ctx = mk();
  marketBuy(ctx, 'ETH', 2);
  const p = P('ETH', T0);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'sell', type: 'market', quantity: 3 }), /Insufficient holdings/);
  rejects(() => place(ctx, { symbol: 'BTC', side: 'sell', type: 'market', quantity: 0.1 }), /Insufficient holdings/);
  place(ctx, { symbol: 'ETH', side: 'sell', type: 'limit', quantity: 1.5, price: p * 2 });
  rejects(() => place(ctx, { symbol: 'ETH', side: 'sell', type: 'limit', quantity: 1, price: p * 2 }), /Insufficient holdings/);
  place(ctx, { symbol: 'ETH', side: 'sell', type: 'limit', quantity: 0.5, price: p * 2 }); // exactly what is left
});

test('validation: cannot spend more than the balance, including cash held by resting buy orders', () => {
  const ctx = mk({ balance: 10000, largePct: 100 });
  const p = P('ETH', T0);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 4 }), /Insufficient funds/);
  const first = place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 2, price: p * 0.9 }).order;
  rejects(() => place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 2, price: p * 0.9 }), /Insufficient funds/);
  cancelOrder(ctx.db, ctx.user.id, first.id);
  place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 2, price: p * 0.9 });
});

test('validation: rejected requests leave no order or ledger rows behind', () => {
  const ctx = mk({ balance: 1000 });
  rejects(() => place(ctx, { symbol: 'BTC', side: 'buy', type: 'market', quantity: 5 }), /Insufficient funds/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM transactions').get().c, 0);
  assert.equal(balance(ctx.db, ctx.user.id), 1000);
});

test('validation: malformed orders are rejected', () => {
  const ctx = mk();
  const bad = (spec, re) => rejects(() => place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 1, ...spec }), re);
  bad({ symbol: 'NOPE' }, /Unknown asset/);
  bad({ quantity: 0 }, /Quantity/);
  bad({ quantity: -1 }, /Quantity/);
  bad({ quantity: 'x' }, /Quantity/);
  bad({ quantity: NaN }, /Quantity/);
  bad({ side: 'hold' }, /Side/);
  bad({ type: 'iceberg' }, /Unknown order type/);
  bad({ type: 'limit' }, /Limit price is required/);
  bad({ type: 'limit', price: -5 }, /Limit price/);
  bad({ type: 'stop' }, /Stop price is required/);
});

// ------------------------------------------------------------------ risk controls

test('risk: large orders need confirmation, and nothing is placed without it', () => {
  const ctx = mk({ balance: 10000 });
  rejects(() => place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 2 }), /large order/i,
    { status: 409, code: 'LARGE_ORDER_CONFIRMATION_REQUIRED' });
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0);
  const done = place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 2 }, T0, { confirmLarge: true });
  assert.equal(done.order.status, 'filled');
  assert.ok(done.warnings.some((w) => w.code === 'MAX_ORDER_SIZE'));
});

test('risk: a mid-sized order only warns, and thresholds are configurable', () => {
  const ctx = mk({ balance: 10000 });
  const mid = place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: P('ETH', T0) * 0.99 });
  assert.ok(mid.warnings.some((w) => w.code === 'MAX_ORDER_SIZE'), '34% of the portfolio is above the 25% default');
  const preview = previewOrder(ctx.db, ctx.user, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 2 }, T0);
  assert.equal(preview.requiresConfirmation, true);
  updateRiskSettings(ctx.db, ctx.user.id, { largeOrderPct: 100, maxOrderPct: 90 }, T0);
  const after = previewOrder(ctx.db, ctx.user, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 2 }, T0);
  assert.equal(after.requiresConfirmation, false);
  assert.equal(after.warnings.some((w) => w.code === 'MAX_ORDER_SIZE'), false);
});

test('risk: volatile assets carry a warning, calm ones do not', () => {
  const ctx = mk();
  const eth = previewOrder(ctx.db, ctx.user, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 0.1 }, T0);
  assert.ok(eth.warnings.some((w) => w.code === 'VOLATILE_ASSET'));
  const eur = previewOrder(ctx.db, ctx.user, { symbol: 'EURUSD', side: 'buy', type: 'market', quantity: 10 }, T0);
  assert.deepEqual(eur.warnings, []);
  assert.equal(eur.estimate.price, P('EURUSD', T0));
  assert.equal(eur.estimate.mode, 'demo');
});

test('risk: the daily demo-loss limit pauses new buys once reached, but never blocks selling', () => {
  const ctx = mk({ balance: 100000 });
  const hours = (n) => T0 + n * 3600e3;
  // Find a buy time followed by a sell time at least 1.5% lower on the same day.
  let tA; let tB;
  for (let a = 0; a <= 8 && !tB; a += 0.25) {
    for (let b = a + 0.25; b <= 10; b += 0.25) {
      if (P('ETH', hours(b)) <= P('ETH', hours(a)) * 0.985) { tA = hours(a); tB = hours(b); break; }
    }
  }
  assert.ok(tB, 'the simulated price falls at some point during the day');
  const o = marketBuy(ctx, 'ETH', 4, tA);
  assert.equal(o.status, 'filled');
  const lossAtB = (o.fill_price - P('ETH', tB)) * 4;
  updateRiskSettings(ctx.db, ctx.user.id, { dailyLossLimit: lossAtB * 0.5 }, tB);

  const near = riskSettings(ctx.db, ctx.user.id, tB);
  assert.equal(near.limitReached, true);
  assert.ok(near.todayLoss >= near.dailyLossLimit);
  rejects(() => place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 1 }, tB), /Daily demo-loss limit/, { status: 403, code: 'DAILY_LOSS_LIMIT' });
  const sell = place(ctx, { symbol: 'ETH', side: 'sell', type: 'market', quantity: 4 }, tB).order;
  assert.equal(sell.status, 'filled'); // reducing risk stays allowed
  assert.ok(riskSettings(ctx.db, ctx.user.id, tB + 1000).resetsAt.startsWith('2026-03-11'));
  // The limit is per UTC day: the next day buys work again.
  const nextDay = dayEnd(T0) + 3600e3;
  place(ctx, { symbol: 'ETH', side: 'buy', type: 'market', quantity: 1 }, nextDay);
});

test('risk: nearing the daily limit warns, and a resting buy is rejected if the limit is hit before it fills', () => {
  const ctx = mk({ balance: 100000 });
  const hours = (n) => T0 + n * 3600e3;
  let tA; let tB;
  for (let a = 0; a <= 8 && !tB; a += 0.25) {
    for (let b = a + 0.25; b <= 10; b += 0.25) {
      if (P('ETH', hours(b)) <= P('ETH', hours(a)) * 0.985) { tA = hours(a); tB = hours(b); break; }
    }
  }
  const o = marketBuy(ctx, 'ETH', 4, tA);
  const loss = (o.fill_price - P('ETH', tB)) * 4;
  updateRiskSettings(ctx.db, ctx.user.id, { dailyLossLimit: loss * 1.1 }, tB);
  const near = place(ctx, { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 0.2, price: P('ETH', tB) * 0.5 }, tB);
  assert.ok(near.warnings.some((w) => w.code === 'DAILY_LOSS_NEAR'));
  assert.equal(near.order.status, 'pending');
  updateRiskSettings(ctx.db, ctx.user.id, { dailyLossLimit: loss * 0.5 }, tB); // now the limit is breached
  // The resting buy would fill (price 2x), but the loss limit stops it.
  ctx.db.prepare('UPDATE orders SET price = ?, reserve_price = ? WHERE id = ?').run(P('ETH', tB + 10e3) * 2, P('ETH', tB + 10e3), near.order.id);
  matchPending(ctx.db, tB + 10e3);
  const cur = order(ctx.db, near.order.id);
  assert.equal(cur.status, 'rejected');
  assert.match(cur.note, /Daily demo-loss limit/);
});

// ------------------------------------------------------------------ HTTP API

test('API: preview, large-order confirmation, OCO, cancellation and risk settings', async () => {
  const db = openDb(':memory:');
  const server = createApp(db, { secret: 's', log: () => {} }).listen(0);
  const base = `http://localhost:${server.address().port}/api`;
  try {
    const reg = await (await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'T', email: 't@x.com', password: 'password1' }),
    })).json();
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` };
    const call = async (method, path, body) => {
      const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const price = (await call('GET', '/markets/ETH')).body.asset.price;

    const prev = await call('POST', '/orders/preview', { symbol: 'ETH', side: 'buy', type: 'market', quantity: 2 });
    assert.equal(prev.status, 200);
    assert.equal(prev.body.requiresConfirmation, true);
    assert.ok(prev.body.warnings.some((w) => w.code === 'VOLATILE_ASSET'));

    const large = await call('POST', '/orders', { symbol: 'ETH', side: 'buy', type: 'market', quantity: 2 });
    assert.equal(large.status, 409);
    assert.equal(large.body.code, 'LARGE_ORDER_CONFIRMATION_REQUIRED');
    assert.equal((await call('GET', '/orders')).body.orders.length, 0);
    const ok = await call('POST', '/orders', { symbol: 'ETH', side: 'buy', type: 'market', quantity: 2, confirmLarge: true });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.order.status, 'filled');

    assert.equal((await call('POST', '/orders', { symbol: 'ETH', side: 'sell', type: 'market', quantity: 5 })).body.error, 'Insufficient holdings');
    assert.equal((await call('POST', '/orders', { symbol: 'ETH', side: 'buy', type: 'iceberg', quantity: 1 })).status, 400);
    assert.equal((await call('POST', '/orders', { symbol: 'ETH', side: 'sell', type: 'stop_loss', quantity: 1, price: price * 2 })).status, 400);

    const day = await call('POST', '/orders', { symbol: 'ETH', side: 'sell', type: 'take_profit', quantity: 0.5, price: price * 1.5, timeInForce: 'day' });
    assert.equal(day.status, 201);
    assert.equal(day.body.order.tif, 'day');
    const trail = await call('POST', '/orders', { symbol: 'ETH', side: 'sell', type: 'trailing_stop', quantity: 0.5, trailPercent: 5 });
    assert.equal(trail.status, 201);
    assert.equal(trail.body.order.trail_mode, 'percent');

    const oco = await call('POST', '/orders/oco', { symbol: 'ETH', side: 'sell', quantity: 1, legs: [{ type: 'take_profit', price: price * 1.5 }, { type: 'stop_loss', price: price * 0.5 }] });
    assert.equal(oco.status, 201);
    assert.equal(oco.body.orders.length, 2);
    assert.equal((await call('POST', '/orders/oco', { symbol: 'ETH', side: 'sell', quantity: 1, legs: [{ type: 'limit', price: price * 1.5 }] })).status, 400);
    const cancelled = await call('DELETE', `/orders/${oco.body.orders[1].id}`);
    assert.equal(cancelled.body.cancelled.length, 2);
    assert.equal((await call('DELETE', `/orders/${oco.body.orders[0].id}`)).status, 404);

    const risk = await call('PUT', '/risk', { dailyLossLimit: 250, maxOrderPct: 10, largeOrderPct: 80 });
    assert.equal(risk.body.dailyLossLimit, 250);
    assert.equal((await call('GET', '/risk')).body.maxOrderPct, 10);
    assert.equal((await call('PUT', '/risk', { maxOrderPct: 500 })).status, 400);
    assert.equal((await call('PUT', '/risk', { dailyLossLimit: null })).body.dailyLossLimit, null);
  } finally { server.close(); }
});
