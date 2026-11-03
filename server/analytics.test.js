import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { replayFills, computeAnalytics, buildStatement } from './src/analytics.js';
import { getAsset, priceAt } from './src/market.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const fill = (id, side, symbol, quantity, price) => ({ id, side, symbol, quantity, price });

test('replay: weighted average cost across multiple buys', () => {
  const { positions, realized } = replayFills([fill(1, 'buy', 'ETH', 2, 100), fill(2, 'buy', 'ETH', 2, 200)]);
  assert.equal(positions.get('ETH').quantity, 4);
  assert.equal(positions.get('ETH').avgCost, 150);
  assert.equal(realized, 0);
});

test('replay: a sell realizes profit and leaves average cost unchanged', () => {
  const { positions, realized, realizedByOrder } = replayFills([
    fill(1, 'buy', 'ETH', 2, 100), fill(2, 'buy', 'ETH', 2, 200), fill(3, 'sell', 'ETH', 1, 250),
  ]);
  assert.equal(realizedByOrder.get(3), 100); // (250 - 150) * 1
  assert.equal(realized, 100);
  assert.equal(positions.get('ETH').quantity, 3);
  assert.equal(positions.get('ETH').avgCost, 150);
});

test('replay: losses, full close and re-entry reset the cost basis', () => {
  const { positions, realized, realizedBySymbol } = replayFills([
    fill(1, 'buy', 'BTC', 1, 100), fill(2, 'sell', 'BTC', 1, 60), fill(3, 'buy', 'BTC', 1, 400),
  ]);
  assert.equal(realized, -40);
  assert.equal(realizedBySymbol.get('BTC'), -40);
  assert.equal(positions.get('BTC').avgCost, 400);
});

test('replay: fractional quantities and sub-dollar prices keep precision', () => {
  const { positions, realized } = replayFills([
    fill(1, 'buy', 'EURUSD', 0.5, 1.080123), fill(2, 'sell', 'EURUSD', 0.25, 1.090123),
  ]);
  near(realized, 0.0025, 1e-9);
  near(positions.get('EURUSD').quantity, 0.25, 1e-12);
  near(positions.get('EURUSD').avgCost, 1.080123, 1e-12);
});

const DAY = 24 * 3600e3;
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

// Builds an account with a hand-written ledger so expected numbers are known exactly.
async function seed(now, trades, flows = []) {
  const db = await openDb(':memory:');
  const created = now - 10 * DAY;
  const cashDelta = trades.reduce((s, t) => s + (t.side === 'buy' ? -1 : 1) * t.qty * t.price, 0) + flows.reduce((s, f) => s + f.amount, 0);
  const uid = (await db.prepare("INSERT INTO users (name, email, password_hash, balance, created_at) VALUES ('T', 't@x.com', 'x', ?, ?)")
    .run(10000 + cashDelta, sqlTime(created))).lastInsertRowid;
  const addOrder = db.prepare("INSERT INTO orders (user_id, symbol, side, type, quantity, status, fill_price, filled_at) VALUES (?, ?, ?, 'market', ?, 'filled', ?, ?)");
  const addFill = db.prepare('INSERT INTO fills (order_id, user_id, symbol, side, quantity, price, filled_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const addTx = db.prepare('INSERT INTO transactions (user_id, type, symbol, amount, note, order_id, fill_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const events = [
    ...trades.map((t) => ({ at: t.at, run: async () => {
      const oid = (await addOrder.run(uid, t.symbol, t.side, t.qty, t.price, sqlTime(t.at))).lastInsertRowid;
      const fid = (await addFill.run(oid, uid, t.symbol, t.side, t.qty, t.price, sqlTime(t.at))).lastInsertRowid;
      const amount = (t.side === 'buy' ? -1 : 1) * t.qty * t.price;
      await addTx.run(uid, t.side, t.symbol, amount, `${t.qty} ${t.symbol} @ ${t.price}`, oid, fid, sqlTime(t.at));
    } })),
    ...flows.map((f) => ({ at: f.at, run: async () => await addTx.run(uid, f.amount > 0 ? 'deposit' : 'withdrawal', null, f.amount, 'Demo', null, null, sqlTime(f.at)) })),
  ].sort((a, b) => a.at - b.at);
  events.forEach((e) => e.run());
  return { db, user: { id: uid } };
}

test('analytics: average cost, realized and unrealized P/L, returns', async () => {
  const now = Date.parse('2026-06-15T12:00:00Z');
  const { db, user } = await seed(now, [
    { at: now - 5 * DAY, symbol: 'ETH', side: 'buy', qty: 2, price: 3000 },
    { at: now - 4 * DAY, symbol: 'ETH', side: 'buy', qty: 1, price: 3300 },
    { at: now - 2 * DAY, symbol: 'ETH', side: 'sell', qty: 1, price: 3500 },
  ], [{ at: now - 3 * DAY, amount: 1000 }]);
  const a = await computeAnalytics(db, user, now);
  const P = priceAt(getAsset('ETH'), now);

  assert.equal(a.mode, 'demo');
  assert.match(a.note, /demo/i);
  const h = a.holdings[0];
  assert.equal(h.symbol, 'ETH');
  assert.equal(h.quantity, 2);
  near(h.avgCost, 3100); // (2*3000 + 1*3300) / 3
  near(h.price, P);
  near(h.value, 2 * P, 1e-4);
  near(h.costBasis, 6200, 1e-4);
  near(h.unrealizedPnl, 2 * (P - 3100), 1e-4);
  near(h.realizedPnl, 400, 1e-4); // (3500 - 3100) * 1

  const s = a.summary;
  near(s.cash, 5200, 1e-4); // 10000 - 6000 - 3300 + 3500 + 1000
  near(s.totalValue, 5200 + 2 * P, 1e-4);
  near(s.realizedPnl, 400, 1e-4);
  near(s.unrealizedPnl, 2 * (P - 3100), 1e-4);
  near(s.tradingPnl, s.realizedPnl + s.unrealizedPnl, 1e-4);
  // The deposit is excluded from performance, so equity-based P/L matches trading P/L.
  near(s.totalPnl, s.tradingPnl, 1e-3);
  near(s.totalReturnPct, (s.totalPnl / 11000) * 100, 1e-3);
  near(s.startingBalance, 10000);
  near(s.netDeposits, 1000);
  near(a.allocation.reduce((t, x) => t + x.pct, 0), 100, 0.01);
});

test('analytics: performance periods and portfolio-value history', async () => {
  const now = Date.parse('2026-06-15T12:00:00Z');
  const { db, user } = await seed(now, [
    { at: now - 5 * DAY, symbol: 'ETH', side: 'buy', qty: 2, price: 3000 },
  ], [{ at: now - 3 * DAY, amount: 1000 }]);
  const a = await computeAnalytics(db, user, now);
  const eth = getAsset('ETH');
  const P = priceAt(eth, now);

  const day = a.performance['1D'];
  near(day.pnl, 2 * (P - priceAt(eth, now - DAY)), 1e-3);
  near(a.summary.dailyPnl, day.pnl);
  assert.equal(day.netDeposits, 0);

  const week = a.performance['1W']; // starts before the buy: 10,000 cash, deposit counts as a flow
  near(week.startValue, 10000, 1e-3);
  near(week.netDeposits, 1000);
  near(week.pnl, 2 * P - 6000, 1e-3); // end 5000 + 2P, minus 10000 start, minus the 1000 deposit
  const all = a.performance.ALL;
  near(all.startValue, 10000, 1e-3);
  near(all.history[0].value, 10000, 1e-3);
  near(all.history.at(-1).value, a.summary.totalValue, 1e-3);
  assert.equal(all.history.length, 60);
  assert.ok(all.history.every((p, i, arr) => i === 0 || p.t >= arr[i - 1].t));
  assert.equal(Date.parse(all.since), now - 10 * DAY);
});

test('analytics: best and worst holdings, and an account with no trades', async () => {
  const now = Date.parse('2026-06-15T12:00:00Z');
  const { db, user } = await seed(now, [
    { at: now - 2 * DAY, symbol: 'ETH', side: 'buy', qty: 1, price: 6000 }, // deep loss
    { at: now - 2 * DAY, symbol: 'AAPL', side: 'buy', qty: 10, price: 50 }, // big gain
  ]);
  const a = await computeAnalytics(db, user, now);
  assert.equal(a.best.symbol, 'AAPL');
  assert.equal(a.worst.symbol, 'ETH');
  assert.ok(a.best.unrealizedPct > 0 && a.worst.unrealizedPct < 0);

  const empty = await seed(now, []);
  const e = await computeAnalytics(empty.db, empty.user, now);
  assert.deepEqual(e.holdings, []);
  assert.equal(e.best, null);
  assert.equal(e.worst, null);
  assert.equal(e.summary.totalValue, 10000);
  assert.equal(e.summary.totalReturnPct, 0);
});

test('API: analytics agrees with fills, and the CSV statement is demo-labelled', async () => {
  const db = await openDb(':memory:');
  const server = createApp(db, { secret: 's', log: () => {} }).listen(0);
  const base = `http://localhost:${server.address().port}/api`;
  try {
    const reg = await (await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'T', email: 't@x.com', password: 'password1' }),
    })).json();
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` };
    const order = (body) => fetch(`${base}/orders`, { method: 'POST', headers, body: JSON.stringify({ type: 'market', ...body }) }).then((r) => r.json());
    const b1 = (await order({ symbol: 'AAPL', side: 'buy', quantity: 20 })).order;
    const b2 = (await order({ symbol: 'AAPL', side: 'buy', quantity: 10 })).order;
    const s1 = (await order({ symbol: 'AAPL', side: 'sell', quantity: 10 })).order;
    const avg = (b1.fill_price * 20 + b2.fill_price * 10) / 30;

    const a = await (await fetch(`${base}/portfolio/analytics`, { headers })).json();
    const pf = await (await fetch(`${base}/portfolio`, { headers })).json();
    near(a.holdings[0].avgCost, avg, 1e-5);
    near(a.holdings[0].avgCost, pf.holdings[0].avgCost, 1e-5); // matches the live holdings table
    near(a.summary.realizedPnl, (s1.fill_price - avg) * 10, 1e-3);
    near(a.summary.totalValue, pf.totalValue, 0.05);
    near(a.summary.totalPnl, a.summary.tradingPnl, 0.05);

    const res = await fetch(`${base}/transactions/export`, { headers });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /demo-statement-.*\.csv/);
    const lines = (await res.text()).trim().split('\r\n');
    assert.equal(lines[0], 'date_utc,type,symbol,quantity,price,amount,realized_pnl,balance_after,description,mode');
    assert.equal(lines.length, 5); // header + opening balance + 3 trades
    assert.ok(lines.slice(1).every((l) => l.endsWith(',DEMO')));
    assert.match(lines[1], /opening_balance/);
    const sell = lines[4].split(',');
    assert.equal(sell[1], 'sell');
    near(Number(sell[6]), (s1.fill_price - avg) * 10, 1e-3);
    assert.equal((await fetch(`${base}/transactions/export`)).status, 401);
    assert.equal((await buildStatement(db, { id: reg.user.id })).split('\r\n')[0].split(',').length, 10);
  } finally { server.close(); }
});
