import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { ASSETS, getAsset, priceAt, quote } from './src/market.js';
import { loadAssetState } from './src/assetState.js';
import { matchPending, placeOrder, previewOrder, getOrderDetail, OrderError } from './src/trading.js';
import { replayFills } from './src/analytics.js';
import { sessionState, nextOpen } from './src/sessions.js';
import {
  IDEAL, REALISTIC, bidAsk, checkQuantity, configureSimulation, describeProfile, feeFor, floorToStep, gapFraction, hash01, latencyMs,
  liquidityAt, maxSlippageBps, paramsFor, quantityRules, slippageBps,
} from './src/simulation.js';
import { liquiditySlot } from './src/market.js';

const SEC = 1000;
const HOUR = 3600e3;
const MON_OPEN = Date.UTC(2026, 5, 8, 15, 0, 0); // Monday 15:00 UTC: US stocks, forex and commodities are open
const FRI_CLOSE = Date.UTC(2026, 5, 5, 21, 0, 0); // Friday 21:00 UTC: US stocks close
const SAT = Date.UTC(2026, 5, 6, 10, 0, 0); // Saturday 10:00 UTC: stocks, forex and commodities are closed
const r6 = (n) => Math.round(n * 1e6) / 1e6;

const asset = (symbol) => getAsset(symbol);

// A fresh database with one funded user, under the given profile.
async function world(profile = 'realistic', balance = 1e7) {
  configureSimulation(profile);
  const db = await openDb(':memory:');
  await db.prepare("INSERT INTO users (name, email, password_hash, balance) VALUES ('T', 't@x.com', 'x', ?)").run(balance);
  await loadAssetState(db);
  const user = await db.prepare('SELECT * FROM users').get();
  const place = async (spec, now) => await placeOrder(db, user, spec, now, { confirmLarge: true });
  const fills = async (orderId) => await db.prepare('SELECT * FROM fills WHERE order_id = ? ORDER BY id').all(orderId);
  const order = async (id) => await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  const balanceNow = async () => (await db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id)).balance;
  return { db, user, place, fills, order, balanceNow };
}

beforeEach(() => configureSimulation('ideal'));
after(() => configureSimulation('ideal'));

// ------------------------------------------------------------------ determinism

test('determinism: the same inputs always give the same numbers, and a different seed gives a different market', () => {
  assert.equal(hash01(1, 'a', 2), hash01(1, 'a', 2));
  assert.notEqual(hash01(1, 'a', 2), hash01(1, 'a', 3));
  assert.notEqual(hash01(1, 'a', 2), hash01(2, 'a', 2));
  for (let i = 0; i < 500; i++) { const h = hash01(7, 'x', i); assert.ok(h >= 0 && h < 1); }
  // Known value, so an accidental change to the hash (which would change every simulated fill) is noticed.
  assert.equal(hash01(1, 'slip', 42, 1000), hash01(1, 'slip', 42, 1000));
  const spread = Array.from({ length: 2000 }, (_, i) => hash01(3, 'u', i));
  const mean = spread.reduce((a, b) => a + b, 0) / spread.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `roughly uniform, mean ${mean}`);
  const eth = asset('ETH');
  const other = { ...REALISTIC, seed: 99 };
  assert.notEqual(latencyMs(eth, 5, REALISTIC), latencyMs(eth, 5, other));
  assert.equal(latencyMs(eth, 5, REALISTIC), latencyMs(eth, 5, REALISTIC));
});

test('determinism: the same orders at the same times give identical fills in two separate databases', async () => {
  const run = async () => {
    const w = await world();
    const placed = (await w.place({ symbol: 'SOL', side: 'buy', type: 'market', quantity: 130 }, MON_OPEN)).order;
    for (let i = 1; i <= 8; i++) await matchPending(w.db, MON_OPEN + 2 * SEC + i * 5 * SEC);
    const sold = (await w.place({ symbol: 'SOL', side: 'sell', type: 'market', quantity: 20 }, MON_OPEN + HOUR)).order;
    await matchPending(w.db, MON_OPEN + HOUR + 3 * SEC);
    return {
      buys: (await w.fills(placed.id)).map(({ quantity, price, fee, mid, slippage_bps, filled_at }) => [quantity, price, fee, mid, slippage_bps, filled_at]),
      sells: (await w.fills(sold.id)).map(({ quantity, price, fee }) => [quantity, price, fee]),
      balance: await w.balanceNow(), execAfter: (await w.order(placed.id)).execute_after,
    };
  };
  const a = await run();
  assert.ok(a.buys.length >= 3, 'a large order fills in several parts');
  assert.deepEqual(await run(), a);
});

// ------------------------------------------------------------------ profiles

test('the ideal profile is the old behaviour: no spread, fee, slippage, delay or gaps, and instant fills', async () => {
  const w = await world('ideal');
  for (const a of ASSETS) {
    const p = paramsFor(a, IDEAL);
    assert.equal(p.spreadBps + p.feeBps + p.impactBps + p.jitterBps + p.latencyMs[1], 0, a.symbol);
  }
  const mid = priceAt(asset('ETH'), MON_OPEN);
  assert.deepEqual(bidAsk(asset('ETH'), mid, IDEAL), { bid: mid, ask: mid, spreadBps: 0 });
  const o = (await w.place({ symbol: 'ETH', side: 'buy', type: 'market', quantity: 1 }, MON_OPEN)).order;
  assert.equal(o.status, 'filled');
  assert.equal(o.execute_after, null);
  const [f] = await w.fills(o.id);
  assert.equal(f.price, mid);
  assert.equal(f.fee, 0);
  assert.equal(f.slippage_bps, 0);
  assert.notEqual(priceAt(asset('AAPL'), SAT), priceAt(asset('AAPL'), SAT + 6 * HOUR), 'and markets never freeze');
  assert.equal(liquidityAt(asset('ETH'), 12345, IDEAL), asset('ETH').liquidity);
  assert.throws(() => configureSimulation('chaotic'), /Unknown simulation profile/);
});

// ------------------------------------------------------------------ bid, ask and spread

test('bid and ask: buyers pay the ask, sellers get the bid, both around the mid price', () => {
  configureSimulation('realistic');
  const aapl = asset('AAPL');
  const mid = priceAt(aapl, MON_OPEN);
  const { bid, ask, spreadBps } = bidAsk(aapl, mid);
  assert.ok(bid < mid && mid < ask);
  assert.equal(spreadBps, 4);
  assert.ok(Math.abs(((ask - bid) / mid) * 1e4 - 4) < 0.01, 'the gap between them is the spread');
  assert.ok(Math.abs((ask - mid) - (mid - bid)) < 2e-6, 'split evenly around the mid');
  const q = quote(aapl, MON_OPEN);
  assert.deepEqual([q.bid, q.ask, q.spreadBps, q.price], [bid, ask, 4, mid]);
});

test('spread depends on the market and on risk: forex is tight, crypto wider, and risky assets wider again', () => {
  configureSimulation('realistic');
  const bps = (s) => paramsFor(asset(s)).spreadBps;
  assert.equal(bps('EURUSD'), 1.5 * 0.8);
  assert.equal(bps('AAPL'), 4);
  assert.equal(bps('XAU'), 6);
  assert.equal(bps('BTC'), 15);
  assert.equal(bps('TSLA'), 6);
  assert.ok(bps('EURUSD') < bps('AAPL') && bps('AAPL') < bps('BTC'));
});

test('spread is configurable per asset: an override replaces the default, and clearing it restores the default', async () => {
  configureSimulation('realistic');
  const db = await openDb(':memory:');
  const clock = { t: MON_OPEN };
  await db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Ada', 'ada@x.com', 'x', 'admin')").run();
  const server = createApp(db, { secret: 's', now: () => clock.t, simulation: 'realistic' }).listen(0);
  try {
    const base = `http://localhost:${server.address().port}/api`;
    const reg = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Root', email: 'root@x.com', password: 'password1' }) });
    const { token, user } = await reg.json();
    await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const call = async (method, path, body) => {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    assert.equal((await call('GET', '/markets/AAPL')).body.asset.spreadBps, 4);
    const set = await call('PATCH', '/admin/assets/AAPL', { spreadBps: 25, reason: 'Volatile earnings week' });
    assert.equal(set.status, 200);
    assert.equal(set.body.asset.spreadBps, 25);
    assert.equal(set.body.asset.defaultSpreadBps, 4);
    assert.equal(set.body.asset.spreadOverridden, true);
    const live = (await call('GET', '/markets/AAPL')).body.asset;
    assert.equal(live.spreadBps, 25);
    assert.ok(Math.abs(((live.ask - live.bid) / live.price) * 1e4 - 25) < 0.05);
    assert.equal((await db.prepare("SELECT spread_bps FROM asset_state WHERE symbol = 'AAPL'").get()).spread_bps, 25, 'stored');

    delete asset('AAPL').spreadBps; // as if the process restarted
    await loadAssetState(db);
    assert.equal(paramsFor(asset('AAPL')).spreadBps, 25, 'survives a restart');

    assert.equal((await call('PATCH', '/admin/assets/AAPL', { spreadBps: -1 })).status, 400);
    assert.equal((await call('PATCH', '/admin/assets/AAPL', {})).status, 400);
    assert.equal((await call('PATCH', '/admin/assets/AAPL', { spreadBps: 0 })).body.asset.spreadBps, 0, 'a zero spread is allowed');
    assert.equal((await call('PATCH', '/admin/assets/AAPL', { spreadBps: null })).body.asset.spreadBps, 4, 'null restores the default');
    const log = (await call('GET', '/admin/audit?action=asset.spread')).body.entries;
    assert.deepEqual(log.map((e) => e.details), [
      { fromBps: 0, toBps: 4, reason: null }, { fromBps: 25, toBps: 0, reason: null }, { fromBps: 4, toBps: 25, reason: 'Volatile earnings week' },
    ]);
  } finally { server.close(); delete asset('AAPL').spreadBps; configureSimulation('ideal'); }
});

// ------------------------------------------------------------------ fees

test('fees: a percentage with a minimum, none for forex, and recorded on every fill', () => {
  configureSimulation('realistic');
  assert.equal(feeFor(asset('BTC'), 1000), 1); // 10 bps
  assert.equal(feeFor(asset('BTC'), 5), 0.01, 'the minimum fee');
  assert.equal(feeFor(asset('AAPL'), 10000), 3);
  assert.equal(feeFor(asset('XAU'), 2000), 1);
  assert.equal(feeFor(asset('EURUSD'), 100000), 0, 'forex is spread-only');
  assert.equal(feeFor(asset('BTC'), 1000, IDEAL), 0);
});

test('a buy costs the price plus the fee, and the fee becomes part of the cost basis', async () => {
  const w = await world();
  const o = (await w.place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: 10 }, MON_OPEN)).order;
  assert.equal(o.status, 'pending', 'it takes a moment to reach the market');
  await matchPending(w.db, MON_OPEN + 3 * SEC);
  const [f] = await w.fills(o.id);
  assert.equal(f.quantity, 10);
  const cost = Math.round(f.price * 10 * 100) / 100;
  assert.equal(f.fee, Math.max(0.01, Math.round(cost * 3 / 1e4 * 100) / 100));
  assert.equal(Math.round((1e7 - await w.balanceNow()) * 100) / 100, Math.round((cost + f.fee) * 100) / 100, 'balance fell by cost plus fee');
  const h = await w.db.prepare("SELECT * FROM holdings WHERE symbol = 'AAPL'").get();
  assert.ok(Math.abs(h.avg_cost - (f.price * 10 + f.fee) / 10) < 1e-9, 'cost basis includes the fee');
  const tx = await w.db.prepare('SELECT * FROM transactions WHERE order_id = ?').get(o.id);
  assert.equal(tx.amount, -Math.round((cost + f.fee) * 100) / 100);
  assert.match(tx.note, /, fee \d/);
});

test('a sell receives the price minus the fee, and realised profit counts the fees on both sides', async () => {
  const w = await world();
  const buy = (await w.place({ symbol: 'XAU', side: 'buy', type: 'market', quantity: 2 }, MON_OPEN)).order;
  await matchPending(w.db, MON_OPEN + 3 * SEC);
  const sell = (await w.place({ symbol: 'XAU', side: 'sell', type: 'market', quantity: 2 }, MON_OPEN + HOUR)).order;
  await matchPending(w.db, MON_OPEN + HOUR + 3 * SEC);
  const [b] = await w.fills(buy.id);
  const [s] = await w.fills(sell.id);
  assert.ok(b.fee > 0 && s.fee > 0);
  const proceeds = Math.round(s.price * 2 * 100) / 100 - s.fee;
  const spent = Math.round(b.price * 2 * 100) / 100 + b.fee;
  assert.ok(Math.abs(await w.balanceNow() - (1e7 - spent + proceeds)) < 0.011);
  const { realized } = replayFills(await w.db.prepare('SELECT id, symbol, side, quantity, price, fee FROM fills ORDER BY id').all());
  assert.ok(Math.abs(realized - ((s.price - (b.price * 2 + b.fee) / 2) * 2 - s.fee)) < 1e-9);
  assert.equal((await w.db.prepare("SELECT COUNT(*) n FROM holdings WHERE symbol = 'XAU'").get()).n, 0);
});

// ------------------------------------------------------------------ slippage

test('slippage: against the trader, bigger for bigger slices, bounded, and repeatable', () => {
  configureSimulation('realistic');
  const eth = asset('ETH');
  const args = (qty) => ({ orderId: 17, slot: 5000, qty, liquidity: 5 });
  const small = slippageBps(eth, args(0.1));
  const big = slippageBps(eth, args(5));
  assert.ok(small >= 0 && big > small, `${small} < ${big}`);
  assert.ok(big <= maxSlippageBps(eth) + 1e-9);
  assert.equal(maxSlippageBps(eth), (4 + 3) * 1.5);
  assert.equal(slippageBps(eth, args(2)), slippageBps(eth, args(2)));
  assert.notEqual(slippageBps(eth, { ...args(2), slot: 5001 }), slippageBps(eth, args(2)), 'jitter changes from slot to slot');
  assert.equal(slippageBps(eth, { ...args(2) }, IDEAL), 0);
});

test('a market buy fills above the ask and a market sell below the bid, never by more than the worst case', async () => {
  const w = await world();
  const eth = asset('ETH');
  const buy = (await w.place({ symbol: 'ETH', side: 'buy', type: 'market', quantity: 3 }, MON_OPEN)).order;
  const t1 = MON_OPEN + 5 * SEC;
  await matchPending(w.db, t1);
  const [b] = await w.fills(buy.id);
  const book = bidAsk(eth, priceAt(eth, t1));
  assert.equal(b.mid, priceAt(eth, t1), 'the mid price at the moment of the fill is recorded');
  assert.equal(b.price, r6(book.ask * (1 + b.slippage_bps / 1e4)));
  assert.ok(b.price >= book.ask && b.price <= book.ask * (1 + maxSlippageBps(eth) / 1e4) + 1e-6);

  const sell = (await w.place({ symbol: 'ETH', side: 'sell', type: 'market', quantity: 3 }, MON_OPEN + HOUR)).order;
  const t2 = MON_OPEN + HOUR + 5 * SEC;
  await matchPending(w.db, t2);
  const [s] = await w.fills(sell.id);
  const book2 = bidAsk(eth, priceAt(eth, t2));
  assert.equal(s.price, r6(book2.bid * (1 - s.slippage_bps / 1e4)));
  assert.ok(s.price <= book2.bid);
});

test('limit orders never slip and never fill beyond their limit price', async () => {
  const w = await world();
  const eth = asset('ETH');
  const t = MON_OPEN + 10 * SEC;
  const ask = bidAsk(eth, priceAt(eth, t)).ask;
  const limit = r6(ask * 1.01);
  const o = (await w.place({ symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: limit }, t - 10 * SEC)).order;
  await matchPending(w.db, t);
  const [f] = await w.fills(o.id);
  assert.equal(f.slippage_bps, 0);
  assert.equal(f.price, ask, 'filled at the ask, which is better than the limit');
  assert.ok(f.price <= limit);
  // A limit sitting just above the ask is still not beaten by the spread.
  const tight = (await w.place({ symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: bidAsk(eth, priceAt(eth, t + 20 * SEC)).ask }, t + 10 * SEC)).order;
  await matchPending(w.db, t + 20 * SEC);
  assert.ok((await w.fills(tight.id))[0].price <= (await w.order(tight.id)).price);
});

test('a buy limit between the bid and the ask does not fill: the spread is real', async () => {
  const w = await world();
  const eth = asset('ETH');
  const t = MON_OPEN + 10 * SEC;
  const { bid, ask } = bidAsk(eth, priceAt(eth, t));
  const o = (await w.place({ symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: r6((bid + ask) / 2) }, t - 10 * SEC)).order;
  await matchPending(w.db, t);
  assert.equal((await w.order(o.id)).status, 'pending', 'the mid price is not available to a buyer');
  assert.equal((await w.fills(o.id)).length, 0);
});

test('a sell stop triggers on the bid, not the mid price', async () => {
  const w = await world();
  const eth = asset('ETH');
  const t = MON_OPEN + 10 * SEC;
  await w.place({ symbol: 'ETH', side: 'buy', type: 'market', quantity: 2 }, MON_OPEN);
  await matchPending(w.db, MON_OPEN + 3 * SEC);
  const o = (await w.place({ symbol: 'ETH', side: 'sell', type: 'stop_loss', quantity: 2, price: priceAt(eth, MON_OPEN) * 0.5 }, MON_OPEN + 4 * SEC)).order;
  const { bid } = bidAsk(eth, priceAt(eth, t));
  const mid = priceAt(eth, t);
  // Put the stop between the bid and the mid: only the bid has reached it.
  await w.db.prepare('UPDATE orders SET price = ? WHERE id = ?').run(r6((bid + mid) / 2), o.id);
  await matchPending(w.db, t);
  assert.equal((await w.order(o.id)).status, 'filled');
  const lower = (await w.place({ symbol: 'ETH', side: 'buy', type: 'market', quantity: 1 }, t + SEC)).order;
  await matchPending(w.db, t + 10 * SEC);
  const o2 = (await w.place({ symbol: 'ETH', side: 'sell', type: 'stop_loss', quantity: 1, price: priceAt(eth, t) * 0.5 }, t + 11 * SEC)).order;
  const t3 = t + 30 * SEC;
  const book3 = bidAsk(eth, priceAt(eth, t3));
  await w.db.prepare('UPDATE orders SET price = ? WHERE id = ?').run(r6(book3.bid - 0.01), o2.id);
  await matchPending(w.db, t3);
  assert.equal((await w.order(o2.id)).status, 'pending', 'the bid is still above the stop');
  assert.ok(lower);
});

// ------------------------------------------------------------------ liquidity and partial fills

test('liquidity swings repeatably around the asset liquidity', () => {
  configureSimulation('realistic');
  const sol = asset('SOL');
  const values = Array.from({ length: 400 }, (_, i) => liquidityAt(sol, 1000 + i));
  assert.ok(values.every((v) => v >= sol.liquidity * 0.7 - 1e-9 && v <= sol.liquidity * 1.3 + 1e-9));
  assert.ok(new Set(values.map((v) => Math.round(v))).size > 20, 'it really varies');
  assert.deepEqual(values, Array.from({ length: 400 }, (_, i) => liquidityAt(sol, 1000 + i)));
  assert.equal(floorToStep(7.9, 1), 7);
  assert.equal(floorToStep(0.4, 1), 1, 'always at least one step so orders make progress');
  assert.equal(floorToStep(3.3, 0), 3.3);
});

test('a large order fills in parts, each within that moment\'s liquidity, and adds up exactly', async () => {
  const w = await world();
  const sol = asset('SOL');
  const o = (await w.place({ symbol: 'SOL', side: 'buy', type: 'market', quantity: 130 }, MON_OPEN)).order;
  assert.ok((await previewOrder(w.db, w.user, { symbol: 'SOL', side: 'buy', type: 'market', quantity: 130 }, MON_OPEN)).warnings.some((x) => x.code === 'PARTIAL_FILL'));
  const slots = [];
  for (let i = 1; i <= 12 && (await w.order(o.id)).status !== 'filled'; i++) {
    const at = MON_OPEN + 2 * SEC + i * 5 * SEC;
    await matchPending(w.db, at);
    slots.push(liquiditySlot(at));
  }
  const parts = await w.fills(o.id);
  assert.ok(parts.length >= 3, `${parts.length} parts`);
  assert.equal((await w.order(o.id)).status, 'filled');
  assert.ok(Math.abs(parts.reduce((s, f) => s + f.quantity, 0) - 130) < 1e-9);
  parts.forEach((f, i) => assert.ok(f.quantity <= liquidityAt(sol, slots[i]) + 1e-9, `part ${i} within liquidity`));
  assert.ok(new Set(parts.map((f) => f.quantity)).size > 1, 'the parts differ in size');
  assert.equal((await w.order(o.id)).status, 'filled');
  const detail = await getOrderDetail(w.db, w.user.id, o.id, MON_OPEN + HOUR);
  assert.equal(detail.fills.length, parts.length);
  assert.ok(detail.summary.totalFees > 0);
  assert.match(detail.summary.notice, /Paper trading is a simulation/);
  assert.ok(detail.fills.every((f) => f.fee > 0 && typeof f.mid === 'number' && f.slippageBps >= 0));
});

// ------------------------------------------------------------------ execution delay

test('execution delay: an order waits its simulated latency, then executes at the price of that moment', async () => {
  const w = await world();
  const eth = asset('ETH');
  const o = (await w.place({ symbol: 'ETH', side: 'buy', type: 'market', quantity: 1 }, MON_OPEN)).order;
  const delay = latencyMs(eth, o.id);
  assert.ok(delay >= 300 && delay <= 1200, `${delay}ms is within the crypto range`);
  assert.equal(o.execute_after, MON_OPEN + delay);
  await matchPending(w.db, MON_OPEN + delay - 1);
  assert.equal((await w.order(o.id)).status, 'pending', 'not there yet');
  assert.match((await getOrderDetail(w.db, w.user.id, o.id, MON_OPEN + 1)).explanation, /still on its way/);
  assert.ok((await getOrderDetail(w.db, w.user.id, o.id, MON_OPEN + 1)).live.executesAt);
  const at = MON_OPEN + delay + 4000;
  await matchPending(w.db, at);
  const [f] = await w.fills(o.id);
  assert.equal(f.mid, priceAt(eth, at), 'priced when it executed, not when it was sent');
  assert.equal((await w.order(o.id)).status, 'filled');
});

test('execution delay differs by market, and applies to resting orders too', async () => {
  configureSimulation('realistic');
  const ranges = { crypto: [300, 1200], stocks: [500, 1800], forex: [200, 800], commodities: [500, 2000] };
  for (const a of ASSETS) {
    const [lo, hi] = ranges[a.category];
    for (let id = 1; id <= 60; id++) { const d = latencyMs(a, id); assert.ok(d >= lo && d <= hi, `${a.symbol} ${d}`); }
  }
  const delays = Array.from({ length: 60 }, (_, id) => latencyMs(asset('BTC'), id + 1));
  assert.ok(new Set(delays).size > 20);
  const w = await world();
  const o = (await w.place({ symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: priceAt(asset('ETH'), MON_OPEN) * 1.2 }, MON_OPEN)).order;
  assert.ok(o.execute_after > MON_OPEN);
});

// ------------------------------------------------------------------ market hours and gaps

test('crypto trades at all hours: a Saturday-morning order fills', async () => {
  const w = await world();
  assert.equal(sessionState('always', SAT).open, true);
  const o = (await w.place({ symbol: 'BTC', side: 'buy', type: 'market', quantity: 0.05 }, SAT)).order;
  await matchPending(w.db, SAT + 5 * SEC);
  assert.equal((await w.order(o.id)).status, 'filled');
  assert.equal((await previewOrder(w.db, w.user, { symbol: 'BTC', side: 'buy', type: 'market', quantity: 0.05 }, SAT)).estimate.marketOpen, true);
});

test('stocks: a weekend order is queued with a warning, and fills after the open at the opening price', async () => {
  const w = await world();
  const aapl = asset('AAPL');
  const warnings = (await previewOrder(w.db, w.user, { symbol: 'AAPL', side: 'buy', type: 'market', quantity: 10 }, SAT)).warnings;
  assert.ok(warnings.some((x) => x.code === 'MARKET_CLOSED' && /2026-06-08 14:30 UTC/.test(x.message)));
  const o = (await w.place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: 10 }, SAT)).order;
  assert.equal(o.expires_at, Date.UTC(2026, 5, 9), 'a day order lasts until the end of the day the market opens');
  await matchPending(w.db, SAT + 2 * HOUR);
  await matchPending(w.db, Date.UTC(2026, 5, 7, 12));
  assert.equal((await w.order(o.id)).status, 'pending', 'nothing happens while the market is closed');
  assert.match((await getOrderDetail(w.db, w.user.id, o.id, SAT + HOUR)).explanation, /market is closed, so this order is queued/);
  assert.equal((await getOrderDetail(w.db, w.user.id, o.id, SAT + HOUR)).live.marketOpen, false);
  await matchPending(w.db, Date.UTC(2026, 5, 8, 14, 29));
  assert.equal((await w.order(o.id)).status, 'pending', 'one minute before the open');
  const openAt = Date.UTC(2026, 5, 8, 14, 30, 10);
  await matchPending(w.db, openAt);
  const [f] = await w.fills(o.id);
  assert.ok(f, 'filled once open');
  assert.equal(f.mid, priceAt(aapl, openAt));
  assert.notEqual(f.mid, priceAt(aapl, SAT), 'at a different price to the weekend one');
});

test('forex trades from Sunday evening to Friday evening; commodities pause for an hour each day', async () => {
  configureSimulation('realistic');
  const open = (id, ...d) => sessionState(id, Date.UTC(...d)).open;
  assert.equal(open('forex', 2026, 5, 6, 12), false, 'Saturday');
  assert.equal(open('forex', 2026, 5, 7, 21, 59), false, 'Sunday before 22:00');
  assert.equal(open('forex', 2026, 5, 7, 22, 0), true);
  assert.equal(open('forex', 2026, 5, 10, 22, 0), true, 'Wednesday night, no daily break');
  assert.equal(open('forex', 2026, 5, 5, 22, 0), false, 'Friday 22:00');
  assert.equal(open('commodities', 2026, 5, 9, 22, 30), false, 'daily break');
  assert.equal(open('commodities', 2026, 5, 9, 23, 0), true);
  assert.equal(open('us-equities', 2026, 5, 8, 14, 29), false);
  assert.equal(open('us-equities', 2026, 5, 8, 14, 30), true);
  assert.equal(open('us-equities', 2026, 5, 8, 21, 0), false);
  assert.equal(nextOpen('forex', SAT), Date.UTC(2026, 5, 7, 22, 0));
  const w = await world();
  const o = (await w.place({ symbol: 'EURUSD', side: 'buy', type: 'market', quantity: 3000 }, SAT)).order;
  await matchPending(w.db, SAT + 12 * HOUR);
  assert.equal((await w.order(o.id)).status, 'pending');
  await matchPending(w.db, Date.UTC(2026, 5, 7, 22, 0, 30));
  assert.equal((await w.order(o.id)).status, 'filled', 'filled as soon as Sunday trading starts');
});

test('a closed market shows its closing price, frozen, and never moves until it reopens', () => {
  configureSimulation('realistic');
  const aapl = asset('AAPL');
  const close = priceAt(aapl, FRI_CLOSE - 60e3);
  const samples = [FRI_CLOSE, FRI_CLOSE + 3 * HOUR, SAT, SAT + 9 * HOUR, Date.UTC(2026, 5, 8, 14, 29)].map((t) => priceAt(aapl, t));
  assert.ok(samples.every((p) => p === samples[0]), 'the same price all weekend');
  assert.ok(Math.abs(samples[0] - close) / close < 0.01, 'about where it closed');
  assert.notEqual(priceAt(aapl, MON_OPEN), samples[0], 'and different once trading resumes');
  assert.notEqual(priceAt(aapl, MON_OPEN), priceAt(aapl, MON_OPEN + 2 * HOUR), 'it moves again while open');
  const btc = asset('BTC');
  assert.notEqual(priceAt(btc, SAT), priceAt(btc, SAT + 3 * HOUR), 'crypto never freezes');
  assert.equal(quote(aapl, SAT).price, samples[0]);
});

test('price gaps: each session opens with its own repeatable jump, bounded by the category, and crypto has none', () => {
  const ratio = (symbol, t) => {
    configureSimulation('realistic');
    const withGap = priceAt(asset(symbol), t);
    configureSimulation('ideal');
    return withGap / priceAt(asset(symbol), t);
  };
  configureSimulation('realistic');
  const aapl = asset('AAPL');
  const bound = (REALISTIC.categories.stocks.gapBps / 1e4) * 1 + 1e-6;
  const mon = ratio('AAPL', MON_OPEN);
  assert.ok(Math.abs(mon - 1) <= bound + 1e-5 && mon !== 1);
  assert.ok(Math.abs(ratio('AAPL', MON_OPEN + 3 * HOUR) - mon) < 1e-6, 'the same gap all through one session');
  const tue = ratio('AAPL', Date.UTC(2026, 5, 9, 16));
  assert.notEqual(tue.toFixed(6), mon.toFixed(6), 'the next session gaps differently');
  const gaps = Array.from({ length: 40 }, (_, i) => gapFraction(aapl, Date.UTC(2026, 5, 1 + i, 14, 30), REALISTIC));
  assert.ok(gaps.some((g) => g > 0) && gaps.some((g) => g < 0), 'gaps go both ways');
  assert.ok(gaps.every((g) => Math.abs(g) <= bound));
  assert.equal(gapFraction(aapl, MON_OPEN, IDEAL), 0);
  assert.equal(ratio('BTC', MON_OPEN), 1);
  assert.equal(ratio('BTC', SAT), 1);
  const forexBound = REALISTIC.categories.forex.gapBps / 1e4 * 0.8;
  assert.ok(Math.abs(ratio('EURUSD', MON_OPEN) - 1) <= forexBound + 1e-6, 'forex gaps are much smaller than stock gaps');
  // The jump between one close and the next open really shows up in the price.
  configureSimulation('realistic');
  const fri = priceAt(aapl, FRI_CLOSE - 60e3);
  const monOpen = priceAt(aapl, Date.UTC(2026, 5, 8, 14, 30));
  assert.notEqual(fri, monOpen);
});

test('a stop-loss gaps through its price: it executes at the open, not at the stop', async () => {
  const w = await world();
  const aapl = asset('AAPL');
  await w.place({ symbol: 'AAPL', side: 'buy', type: 'market', quantity: 5 }, MON_OPEN);
  await matchPending(w.db, MON_OPEN + 4 * SEC);
  const fri = Date.UTC(2026, 5, 12, 20, 0);
  const stop = (await w.place({ symbol: 'AAPL', side: 'sell', type: 'stop_loss', quantity: 5, price: priceAt(aapl, fri) * 0.5 }, fri)).order;
  // Raise the stop above anything the next open could be, as if the price had gapped down through it overnight.
  const nextMon = Date.UTC(2026, 5, 15, 14, 31);
  await w.db.prepare('UPDATE orders SET price = ? WHERE id = ?').run(priceAt(aapl, nextMon) * 1.2, stop.id);
  await matchPending(w.db, Date.UTC(2026, 5, 13, 12));
  assert.equal((await w.order(stop.id)).status, 'pending', 'cannot trigger while closed');
  await matchPending(w.db, nextMon);
  const [f] = await w.fills(stop.id);
  assert.ok(f.price < (await w.order(stop.id)).price, 'filled below the stop price');
  assert.ok(Math.abs(f.mid - priceAt(aapl, nextMon)) < 1e-9);
});

// ------------------------------------------------------------------ quantity rules

test('quantity rules differ by market', () => {
  configureSimulation('realistic');
  const q = (s, n) => checkQuantity(asset(s), n);
  assert.equal(q('AAPL', 10), null);
  assert.match(q('AAPL', 1.5), /whole shares only/);
  assert.match(q('AAPL', 0), /minimum/);
  assert.match(q('AAPL', 10001), /maximum/);
  assert.equal(q('EURUSD', 2000), null);
  assert.match(q('EURUSD', 1500), /lots of 1,000/);
  assert.match(q('EURUSD', 500), /minimum order for EURUSD is 1000/);
  assert.equal(q('BTC', 0.00001), null);
  assert.equal(q('BTC', 0.12345), null);
  assert.match(q('BTC', 0.000005), /minimum/);
  assert.match(q('BTC', 0.000015), /multiple of 0.00001/);
  assert.equal(q('XAU', 0.07), null, 'no floating-point false alarms');
  assert.equal(q('XAU', 0.3), null);
  assert.match(q('XAU', 0.005), /minimum/);
  assert.match(q('XAU', 0.015), /multiple of 0.01/);
  assert.match(q('XAU', 1001), /maximum/);
  assert.deepEqual(quantityRules(asset('AAPL')), { min: 1, step: 1, max: 10000, label: 'whole shares only' });
  assert.equal(checkQuantity(asset('AAPL'), 1.5, IDEAL), null, 'the ideal profile allows anything');
  const custom = { symbol: 'ZZZ', category: 'etf', risk: 'low', quantityRules: { min: 5, step: 5, max: 50 } };
  assert.match(checkQuantity(custom, 7), /multiple of 5/);
  assert.equal(checkQuantity(custom, 10), null);
});

test('orders that break the quantity rules are refused with the rules attached', async () => {
  const w = await world();
  for (const [symbol, quantity, text] of [['AAPL', 2.5, /whole shares/], ['EURUSD', 1234, /lots of 1,000/], ['XAU', 0.001, /minimum/], ['BTC', 5000, /maximum/]]) {
    await assert.rejects(async () => await w.place({ symbol, side: 'buy', type: 'market', quantity }, MON_OPEN), (e) => {
      assert.ok(e instanceof OrderError);
      assert.equal(e.code, 'INVALID_QUANTITY');
      assert.match(e.message, text);
      assert.ok(e.details.rules.min > 0);
      return true;
    }, symbol);
  }
  assert.equal((await w.db.prepare('SELECT COUNT(*) n FROM orders').get()).n, 0);
});

test('quantity rules also reach the API: the quote carries them, and a bad quantity is a 400', async () => {
  const db = await openDb(':memory:');
  const server = createApp(db, { secret: 's', simulation: 'realistic', mailer: { send() {} } }).listen(0);
  try {
    const base = `http://localhost:${server.address().port}/api`;
    const reg = await (await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'B', email: 'b@x.com', password: 'password1' }) })).json();
    const call = async (method, path, body) => {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const info = (await call('GET', '/markets/AAPL')).body.asset;
    assert.equal(info.quantityRules.step, 1);
    assert.ok(info.bid < info.price && info.price < info.ask);
    const bad = await call('POST', '/orders', { symbol: 'AAPL', side: 'buy', type: 'market', quantity: 1.5 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_QUANTITY');
    assert.equal(bad.body.rules.step, 1);
    const preview = await call('POST', '/orders/preview', { symbol: 'BTC', side: 'buy', type: 'market', quantity: 0.01 });
    assert.equal(preview.status, 200);
    const e = preview.body.estimate;
    assert.ok(e.bid < e.ask && e.estimatedFee > 0 && e.maxSlippageBps > 0 && e.marketOpen === true);
    assert.match(e.notice, /real results can differ/);
  } finally { server.close(); configureSimulation('ideal'); }
});

// ------------------------------------------------------------------ funds

test('cash is held back for the fee and worst-case slippage, so an order that only just fits is refused', async () => {
  const w = await world('realistic', 1000);
  const ask = bidAsk(asset('BTC'), priceAt(asset('BTC'), MON_OPEN)).ask;
  const quantity = Math.floor((999.9 / ask) * 1e5) / 1e5; // costs a hair under 1,000 at the ask
  assert.ok(quantity * ask < 1000);
  await assert.rejects(async () => await w.place({ symbol: 'BTC', side: 'buy', type: 'market', quantity }, MON_OPEN), /Insufficient funds/);
  const ideal = await world('ideal', 1000);
  assert.equal((await ideal.place({ symbol: 'BTC', side: 'buy', type: 'market', quantity }, MON_OPEN)).order.status, 'filled', 'the ideal profile has no such margin');
});

// ------------------------------------------------------------------ explanation

test('the simulation description explains that paper trading can differ from real trading', async () => {
  const profile = describeProfile(REALISTIC);
  assert.match(profile.notice, /Paper trading is a simulation/);
  assert.match(profile.notice, /real results can differ/);
  assert.equal(profile.categories.stocks.spreadBps, 4);
  assert.equal(profile.categories.forex.feeBps, 0);
  assert.match(profile.categories.stocks.quantity, /whole shares/);
  const db = await openDb(':memory:');
  const server = createApp(db, { secret: 's', simulation: 'realistic' }).listen(0);
  try {
    const base = `http://localhost:${server.address().port}/api`;
    const reg = await (await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'B', email: 'b@x.com', password: 'password1' }) })).json();
    const res = await fetch(`${base}/simulation`, { headers: { authorization: `Bearer ${reg.token}` } });
    const body = await res.json();
    assert.equal(body.name, 'realistic');
    assert.equal(body.marketHours, true);
    assert.match(body.notice, /Paper trading is a simulation/);
    assert.equal((await fetch(`${base}/simulation`)).status, 401);
  } finally { server.close(); configureSimulation('ideal'); }
});

test('the server asks for the realistic profile by default, and tests get the ideal one', async () => {
  const db = await openDb(':memory:');
  const s1 = createApp(db, { secret: 's' }).listen(0);
  try {
    assert.equal(describeProfile().name, 'ideal');
    createApp(db, { secret: 's', simulation: 'realistic' });
    assert.equal(describeProfile().name, 'realistic');
    assert.equal(configureSimulation({ spread: 1, seed: 5 }).seed, 5, 'a partial profile is filled in from the realistic one');
    assert.equal(describeProfile().name, 'realistic');
  } finally { s1.close(); configureSimulation('ideal'); }
});
