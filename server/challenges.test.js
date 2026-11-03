import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { priceAt, getAsset } from './src/market.js';
import { placeOrder } from './src/trading.js';
import { timeWeightedPerformance } from './src/analytics.js';
import { ACHIEVEMENTS } from './src/achievements.js';
import { RULES, START_BALANCES, aliasFor, validateAlias, weekStart } from './src/challenges.js';
import { code as totp } from './src/totp.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const T0 = Date.UTC(2026, 10, 2, 1, 0, 0); // Monday 2 November 2026, 01:00 UTC
const WEEK_START = weekStart(T0);
const WEEK_END = WEEK_START + WEEK;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const eth = () => getAsset('ETH');

// An hour in the week when ETH is clearly higher than at `from`, so a long position made at `from` is in profit.
function laterHigher(from, minRise = 0.002) {
  for (let t = from + HOUR; t < WEEK_END - HOUR; t += HOUR) if (priceAt(eth(), t) > priceAt(eth(), from) * (1 + minRise)) return t;
  throw new Error('no rise found');
}

async function setup() {
  const db = await openDb(':memory:');
  const clock = { t: T0 };
  const server = createApp(db, { secret: 's', now: () => clock.t, mailer: { send() {} } }).listen(0);
  const base = `http://localhost:${server.address().port}/api`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const users = [];
  const signUp = async (name, balance = 10000) => {
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}@secret-mail.test`;
    const r = await call('POST', '/auth/register', { name, email, password: 'password1' });
    // Accounts in these tests existed long before the (made-up) dates used below.
    await db.prepare("UPDATE users SET balance = ?, created_at = '2026-01-01 00:00:00' WHERE id = ?").run(balance, r.body.user.id);
    await db.prepare('UPDATE sessions SET expires_at = 9e15 WHERE user_id = ?').run(r.body.user.id); // the test clock jumps weeks ahead
    const u = { id: r.body.user.id, token: r.body.token, email, name };
    users.push(u);
    return u;
  };
  const row = async (u) => await db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  // A market order that fills straight away at the price of time `t` (the ideal profile has no delay or costs).
  const trade = async (u, side, quantity, t, symbol = 'ETH') => await placeOrder(db, await row(u), { symbol, side, type: 'market', quantity }, t, { confirmLarge: true });
  const spend = async (u, dollars, t) => await trade(u, 'buy', dollars / priceAt(eth(), t), t);
  const cashFlow = async (u, amount, t) => {
    await db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, u.id);
    await db.prepare('INSERT INTO transactions (user_id, type, amount, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(u.id, amount > 0 ? 'deposit' : 'withdrawal', amount, 'test', new Date(t).toISOString().replace('T', ' ').replace('Z', ''));
  };
  const weekly = async (u) => (await call('GET', '/challenges', null, u.token)).body.weekly.find((c) => c.status === 'running' || c.status === 'upcoming' && c.startsAt === WEEK_START);
  const current = async (u) => (await call('GET', '/challenges', null, u.token)).body.weekly.find((c) => c.startsAt === WEEK_START);
  const board = async (u, id, sort = '') => await call('GET', `/challenges/${id}${sort ? `?sort=${sort}` : ''}`, null, u.token);
  return { db, clock, server, call, signUp, users, row, trade, spend, cashFlow, weekly, current, board, close: () => server.close() };
}

// ------------------------------------------------------------------ the fairness measure

test('time-weighted return: deposits and withdrawals are never profit, and the percentage chains the periods between them', async () => {
  const ctx = await setup();
  try {
    const u = await ctx.signUp('Ann');
    const control = await ctx.signUp('Control');
    const tb = WEEK_START + 2 * HOUR;
    const [td1, td2] = [tb + 30 * 60e3, tb + 40 * 60e3];
    const te = laterHigher(tb);
    const from = tb - HOUR;
    for (const x of [u, control]) await ctx.trade(x, 'buy', 2, tb);
    const cost = (await ctx.db.prepare('SELECT -amount a FROM transactions WHERE user_id = ? AND type = ?').get(u.id, 'buy')).a;
    const plain = await timeWeightedPerformance(ctx.db, control, from, te);
    near(plain.returnPct, ((10000 - 2 * priceAt(eth(), tb) + 2 * priceAt(eth(), te)) / 10000 - 1) * 100, 1e-3);

    await ctx.cashFlow(u, 1_000_000, td1);
    await ctx.cashFlow(u, -400_000, td2);
    const p = await timeWeightedPerformance(ctx.db, u, from, te);
    // Profit is exactly what trading made: the money moved in and out is reported separately and is not profit.
    near(p.pnl, plain.pnl, 1e-9);
    assert.equal(p.netFlows, 600_000);
    near(p.endValue, plain.endValue + 600_000, 1e-6);
    // The percentage is the product of the returns in each stretch between money moving (the position is worth
    // more or less as the price moves, and the cash that was put in simply sits there at 0%).
    const price = (t) => priceAt(eth(), t);
    const cash0 = 10000 - cost;
    const before1 = cash0 + 2 * price(td1);
    const before2 = cash0 + 1_000_000 + 2 * price(td2);
    const after2 = before2 - 400_000;
    const end = cash0 + 600_000 + 2 * price(te);
    const growth = (before1 / 10000) * (before2 / (before1 + 1_000_000)) * (end / after2);
    near(p.returnPct, (growth - 1) * 100, 1e-9);
    assert.ok(Number.isFinite(p.returnPct));

    // Money moving with no trading at all is not a return of any kind.
    const cashOnly = await ctx.signUp('Cash only');
    await ctx.cashFlow(cashOnly, 50_000, tb);
    await ctx.cashFlow(cashOnly, -20_000, tb + HOUR);
    const none = await timeWeightedPerformance(ctx.db, cashOnly, from, te);
    assert.deepEqual([none.returnPct, none.pnl, none.netFlows], [0, 0, 30_000]);
  } finally { ctx.close(); }
});

test('time-weighted return: a deposit made before the start is part of the starting balance, not profit', async () => {
  const ctx = await setup();
  try {
    const u = await ctx.signUp('Bea');
    await ctx.cashFlow(u, 90_000, WEEK_START - HOUR); // 100,000 in total before the window
    const tb = WEEK_START + 2 * HOUR;
    await ctx.trade(u, 'buy', 5, tb);
    const te = laterHigher(tb);
    const p = await timeWeightedPerformance(ctx.db, u, WEEK_START, te);
    near(p.startValue, 100_000, 1e-6);
    near(p.returnPct, (5 * (priceAt(eth(), te) - priceAt(eth(), tb)) / 100_000) * 100, 1e-3);
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ weekly challenges

test('weekly challenges: this week and next week appear on their own, running Monday to Monday UTC', async () => {
  const ctx = await setup();
  try {
    const u = await ctx.signUp('Cy');
    assert.equal((await ctx.call('GET', '/challenges')).status, 401);
    const { body } = await ctx.call('GET', '/challenges', null, u.token);
    assert.equal(body.weekly.length, 2);
    const [now, next] = body.weekly;
    assert.deepEqual([now.startsAt, now.endsAt, now.status], [WEEK_START, WEEK_END, 'running']);
    assert.deepEqual([next.startsAt, next.status], [WEEK_END, 'upcoming']);
    assert.equal(new Date(WEEK_START).getUTCDay(), 1, 'a Monday');
    assert.equal(now.joinDeadline, WEEK_START + 48 * HOUR);
    assert.match(now.name, /Weekly challenge: week of 2026-11-02/);
    assert.equal(now.joined, false);
    assert.equal(now.canJoin, true);
    assert.equal((await ctx.call('GET', '/challenges', null, u.token)).body.weekly.length, 2, 'not created twice');
    assert.equal(weekStart(Date.UTC(2026, 10, 8, 23, 59)), WEEK_START, 'Sunday night is still the same week');
    assert.equal(weekStart(Date.UTC(2026, 10, 9)), WEEK_END);
  } finally { ctx.close(); }
});

test('joining: needs equity, an open window, and a clean account; you can only join once', async () => {
  const ctx = await setup();
  try {
    const poor = await ctx.signUp('Poor', 500);
    const u = await ctx.signUp('Dee');
    const cur = await ctx.current(u);
    assert.equal((await ctx.call('POST', `/challenges/${cur.id}/join`, null, poor.token)).status, 400);
    assert.match((await ctx.call('POST', `/challenges/${cur.id}/join`, null, poor.token)).body.error, /at least \$1,000/);
    const joined = await ctx.call('POST', `/challenges/${cur.id}/join`, null, u.token);
    assert.equal(joined.status, 201);
    assert.equal(joined.body.challenge.joined, true);
    assert.equal((await ctx.call('POST', `/challenges/${cur.id}/join`, null, u.token)).status, 409);
    assert.equal((await ctx.db.prepare('SELECT start_equity FROM challenge_entries WHERE user_id = ?').get(u.id)).start_equity, 10000);

    ctx.clock.t = WEEK_START + 49 * HOUR;
    const late = await ctx.signUp('Late');
    const closed = await ctx.call('POST', `/challenges/${cur.id}/join`, null, late.token);
    assert.equal(closed.status, 400);
    assert.match(closed.body.error, /Joining has closed/);
    assert.equal((await ctx.call('GET', '/challenges', null, late.token)).body.weekly[0].canJoin, false);

    const susp = await ctx.signUp('Susp');
    ctx.clock.t = T0;
    await ctx.db.prepare('UPDATE users SET suspended_at = 1 WHERE id = ?').run(susp.id);
    assert.match((await ctx.call('POST', `/challenges/${cur.id}/join`, null, susp.token)).body.error, /suspended/);
    assert.equal((await ctx.call('POST', '/challenges/9999/join', null, u.token)).status, 404);
  } finally { ctx.close(); }
});

test('ranking uses percentage return, not just money: a smaller account can beat a bigger one, and the profit view differs', async () => {
  const ctx = await setup();
  try {
    const small = await ctx.signUp('Small', 10_000);
    const big = await ctx.signUp('Big', 100_000);
    const cur = await ctx.current(small);
    for (const u of [small, big]) await ctx.call('POST', `/challenges/${cur.id}/join`, null, u.token);
    const tb = WEEK_START + 3 * HOUR;
    const te = laterHigher(tb);
    await ctx.spend(small, 5_000, tb); // half of its account
    await ctx.spend(big, 15_000, tb); // 15% of its account, but three times the money
    ctx.clock.t = te;
    const [pb, pe] = [priceAt(eth(), tb), priceAt(eth(), te)];
    const move = pe / pb - 1;

    const byReturn = (await ctx.board(small, cur.id)).body.leaderboard;
    const smallAlias = await aliasFor(ctx.db, small.id);
    assert.deepEqual(byReturn.ranked.map((r) => r.name === smallAlias), [true, false], 'the small account ranks first by return');
    near(byReturn.ranked[0].returnPct, 0.5 * move * 100, 1e-3);
    near(byReturn.ranked[1].returnPct, 0.15 * move * 100, 1e-3);
    near(byReturn.ranked[0].profit, 5_000 * move, 0.05);
    near(byReturn.ranked[1].profit, 15_000 * move, 0.05);

    const byProfit = (await ctx.board(small, cur.id, 'profit')).body;
    const bigAlias = await aliasFor(ctx.db, big.id);
    assert.deepEqual(byProfit.leaderboard.ranked.map((r) => r.name === bigAlias), [true, false], 'the big account ranks first by profit');
    assert.match(byProfit.note, /Bigger accounts make bigger profits/);
    assert.match((await ctx.board(small, cur.id)).body.note, /percentage return/);
    assert.equal(byReturn.you.rank, 1);
    assert.equal(byReturn.ranked[0].you, true);
    assert.equal((await ctx.call('GET', `/challenges/${cur.id}?sort=money`, null, small.token)).status, 400);

    // The public weekly board is the same view.
    const pub = (await ctx.call('GET', '/leaderboard', null, big.token)).body;
    assert.equal(pub.challenge.id, cur.id);
    assert.equal(pub.leaderboard.ranked[0].name, await aliasFor(ctx.db, small.id));
    assert.equal(pub.leaderboard.you.rank, 2);
    assert.equal((await ctx.call('GET', '/leaderboard?sort=profit', null, big.token)).body.leaderboard.ranked[0].name, await aliasFor(ctx.db, big.id));
  } finally { ctx.close(); }
});

test('deposits made after a challenge begins are not profit, and cannot be used to inflate a percentage', async () => {
  const ctx = await setup();
  try {
    const honest = await ctx.signUp('Honest');
    const padder = await ctx.signUp('Padder');
    const cur = await ctx.current(honest);
    for (const u of [honest, padder]) await ctx.call('POST', `/challenges/${cur.id}/join`, null, u.token);
    const tb = WEEK_START + 3 * HOUR;
    const te = laterHigher(tb);
    await ctx.cashFlow(padder, 100_000, WEEK_START + 2 * HOUR); // after the challenge began
    await ctx.spend(honest, 5_000, tb); // half of its money
    await ctx.spend(padder, 15_000, tb); // three times as much money, but only a small slice of what it now holds
    ctx.clock.t = te;
    const rows = Object.fromEntries((await ctx.board(honest, cur.id)).body.leaderboard.ranked.map((r) => [r.name, r]));
    const a = rows[await aliasFor(ctx.db, honest.id)];
    const b = rows[await aliasFor(ctx.db, padder.id)];
    const move = priceAt(eth(), te) / priceAt(eth(), tb) - 1;
    near(b.profit, 15_000 * move, 0.05); // the 100,000 is not in the profit
    near(a.profit, 5_000 * move, 0.05);
    const naive = (b.profit / 10_000) * 100; // what "profit divided by the original balance" would have claimed
    assert.ok(naive > a.returnPct, 'that naive measure would have let the padder win');
    assert.ok(b.returnPct < a.returnPct, 'the real measure does not');
    near(b.returnPct, (15_000 * move / 110_000) * 100, 0.005); // return on all the money it was actually using
    const ranked = (await ctx.board(honest, cur.id)).body.leaderboard.ranked;
    assert.equal(ranked[0].name, await aliasFor(ctx.db, honest.id));
    assert.equal((await ctx.board(honest, cur.id, 'profit')).body.leaderboard.ranked[0].name, await aliasFor(ctx.db, padder.id), 'the money view favours the bigger bets');
  } finally { ctx.close(); }
});

test('deposits and withdrawals during a challenge leave the profit untouched', async () => {
  const ctx = await setup();
  try {
    const control = await ctx.signUp('Control');
    const depositor = await ctx.signUp('Depositor');
    const withdrawer = await ctx.signUp('Withdrawer');
    const cur = await ctx.current(control);
    for (const u of [control, depositor, withdrawer]) await ctx.call('POST', `/challenges/${cur.id}/join`, null, u.token);
    const tb = WEEK_START + 3 * HOUR;
    const te = laterHigher(tb);
    for (const u of [control, depositor, withdrawer]) await ctx.spend(u, 4_000, tb);
    await ctx.cashFlow(depositor, 5_000_000, tb + HOUR / 2);
    await ctx.cashFlow(withdrawer, -5_000, tb + HOUR / 2);
    ctx.clock.t = te;
    const rows = Object.fromEntries((await ctx.board(control, cur.id)).body.leaderboard.ranked.map((r) => [r.name, r]));
    const [c, d, w] = await Promise.all([control, depositor, withdrawer].map(async (u) => rows[await aliasFor(ctx.db, u.id)]));
    near(d.profit, c.profit, 1e-9);
    near(w.profit, c.profit, 1e-9);
    assert.ok(c.profit > 0);
    assert.ok(Number.isFinite(d.returnPct) && Number.isFinite(w.returnPct));
  } finally { ctx.close(); }
});

test('being ranked takes at least one trade and the minimum starting equity; early trades and early joining give no head start', async () => {
  const ctx = await setup();
  try {
    const idle = await ctx.signUp('Idle');
    const trader = await ctx.signUp('Trader');
    const cur = await ctx.current(idle);
    for (const x of [idle, trader]) await ctx.call('POST', `/challenges/${cur.id}/join`, null, x.token);
    await ctx.trade(trader, 'buy', 1, WEEK_START + 2 * HOUR);
    ctx.clock.t = WEEK_START + 5 * HOUR;
    const lb = (await ctx.board(idle, cur.id)).body.leaderboard;
    assert.equal(lb.ranked.length, 1);
    assert.equal(lb.ranked[0].name, await aliasFor(ctx.db, trader.id));
    assert.equal(lb.waiting.length, 1);
    assert.equal(lb.waiting[0].reason, 'Make a trade to be ranked');
    assert.equal(lb.you.rank, null);
    assert.equal(lb.you.eligible, false);

    // Joining the upcoming week early, then trading before it starts, counts for nothing.
    const next = (await ctx.call('GET', '/challenges', null, idle.token)).body.weekly.find((c) => c.startsAt === WEEK_END);
    assert.equal((await ctx.call('POST', `/challenges/${next.id}/join`, null, idle.token)).status, 201);
    await ctx.trade(idle, 'buy', 1, WEEK_END - HOUR);
    ctx.clock.t = WEEK_END + HOUR;
    const lb2 = (await ctx.board(idle, next.id)).body.leaderboard;
    assert.equal(lb2.you.trades, 0, 'a trade made before the start does not count');
    assert.equal(lb2.you.rank, null);

    // Equity below the minimum when it starts: not ranked, even after trading.
    const low = await ctx.signUp('Low');
    const next2 = (await ctx.call('GET', '/challenges', null, low.token)).body.weekly.find((c) => c.startsAt === WEEK_END);
    ctx.clock.t = T0;
    await ctx.call('POST', `/challenges/${next2.id}/join`, null, low.token);
    await ctx.db.prepare('UPDATE users SET balance = 400 WHERE id = ?').run(low.id);
    await ctx.trade(low, 'buy', 0.01, WEEK_END + 2 * HOUR);
    ctx.clock.t = WEEK_END + 3 * HOUR;
    const lowYou = (await ctx.board(low, next2.id)).body.leaderboard.you;
    assert.equal(lowYou.eligible, false);
    assert.match(lowYou.reason, /at least \$1,000 of equity/);
    assert.equal(RULES.minStartEquity, 1000);
  } finally { ctx.close(); }
});

test('results freeze when the challenge ends: nothing done afterwards changes them, and everyone is told', async () => {
  const ctx = await setup();
  try {
    const a = await ctx.signUp('Aaa');
    const b = await ctx.signUp('Bbb');
    const idle = await ctx.signUp('Idl');
    const cur = await ctx.current(a);
    for (const x of [a, b, idle]) await ctx.call('POST', `/challenges/${cur.id}/join`, null, x.token);
    const tb = WEEK_START + 3 * HOUR;
    const te = laterHigher(tb);
    await ctx.spend(a, 6_000, tb);
    await ctx.spend(b, 2_000, tb);
    ctx.clock.t = WEEK_END + 5 * HOUR; // after the end
    const first = (await ctx.board(a, cur.id)).body;
    assert.equal(first.challenge.status, 'ended');
    const settled = await ctx.db.prepare('SELECT * FROM challenge_entries WHERE challenge_id = ? ORDER BY id').all(cur.id);
    assert.ok(settled.every((e) => e.finalized_at !== null));
    // 'a' held three times as much ETH as 'b', so it does best if ETH ended the week higher and worst if lower.
    const endMove = priceAt(eth(), WEEK_END) / priceAt(eth(), tb) - 1;
    assert.ok(Math.abs(endMove) > 1e-4);
    assert.deepEqual(settled.map((e) => e.final_rank), endMove > 0 ? [1, 2, null] : [2, 1, null]);
    assert.equal(settled[2].final_reason, 'Make a trade to be ranked');
    const frozen = JSON.stringify(first.leaderboard);

    // Trades and deposits after the end change nothing.
    await ctx.trade(b, 'buy', 1, WEEK_END + 6 * HOUR);
    await ctx.cashFlow(a, 1_000_000, WEEK_END + 7 * HOUR);
    ctx.clock.t = WEEK_END + 2 * DAY;
    assert.equal(JSON.stringify((await ctx.board(a, cur.id)).body.leaderboard), frozen);
    assert.equal((await ctx.call('POST', `/challenges/${cur.id}/leave`, null, a.token)).status, 409, 'results are final');

    // Ranked by return over the whole week, measured only up to the end.
    const expected = await timeWeightedPerformance(ctx.db, a, WEEK_START, WEEK_END - 1);
    const aRow = first.leaderboard.ranked.find((r) => r.you);
    assert.ok(Math.abs(aRow.returnPct - expected.returnPct) < 1e-3);
    const notes = ctx.db.prepare("SELECT message FROM notifications WHERE kind = 'challenge' AND user_id = ?");
    assert.match((await notes.get(a.id)).message, endMove > 0 ? /You finished #1 of 2/ : /You finished #2 of 2/);
    assert.match((await notes.get(idle.id)).message, /not ranked/);
    assert.equal((await notes.all(a.id)).length, 1, 'told once, however often it is read');
    assert.ok(te > tb);
  } finally { ctx.close(); }
});

test('ties are broken the same way every time: profit, then who joined first', async () => {
  const ctx = await setup();
  try {
    const first = await ctx.signUp('First');
    const second = await ctx.signUp('Second');
    const cur = await ctx.current(first);
    await ctx.call('POST', `/challenges/${cur.id}/join`, null, first.token);
    ctx.clock.t += 1000;
    await ctx.call('POST', `/challenges/${cur.id}/join`, null, second.token);
    for (const x of [first, second]) await ctx.spend(x, 3_000, WEEK_START + 4 * HOUR);
    ctx.clock.t = WEEK_START + 9 * HOUR;
    const rows = (await ctx.board(second, cur.id)).body.leaderboard.ranked;
    assert.equal(rows[0].returnPct, rows[1].returnPct);
    assert.deepEqual(rows.map((r) => r.name), [await aliasFor(ctx.db, first.id), await aliasFor(ctx.db, second.id)]);
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ privacy and opting out

test('leaderboards never expose emails, real names, ids or balances', async () => {
  const ctx = await setup();
  try {
    const ann = await ctx.signUp('Annabel Smith');
    const bob = await ctx.signUp('Robert Jones');
    const cur = await ctx.current(ann);
    for (const x of [ann, bob]) await ctx.call('POST', `/challenges/${cur.id}/join`, null, x.token);
    for (const x of [ann, bob]) await ctx.spend(x, 3_000, WEEK_START + 4 * HOUR);
    ctx.clock.t = WEEK_START + 9 * HOUR;
    const priv = (await ctx.call('POST', '/challenges', { name: 'Friends', days: 3 }, ann.token)).body;
    await ctx.call('POST', '/challenges/join', { code: priv.challenge.code }, bob.token);
    const responses = [
      await ctx.board(bob, cur.id), await ctx.call('GET', '/leaderboard', null, bob.token), await ctx.call('GET', '/challenges', null, bob.token),
      await ctx.board(bob, priv.challenge.id),
    ];
    for (const r of responses) {
      const text = JSON.stringify(r.body);
      for (const secret of ['secret-mail.test', '@', 'Annabel', 'Smith', 'Robert', 'Jones', 'password', 'balance', 'userId', 'user_id', 'email']) {
        assert.ok(!text.includes(secret), `"${secret}" leaked: ${text.slice(0, 300)}`);
      }
    }
    for (const r of (await ctx.board(bob, cur.id)).body.leaderboard.ranked) {
      assert.deepEqual(Object.keys(r).sort(), ['name', 'profit', 'rank', 'returnPct', 'trades', 'you']);
      assert.match(r.name, /^Trader-[0-9A-F]{4}$/);
    }
  } finally { ctx.close(); }
});

test('display names: automatic and unique, changeable, and never an email or an impersonation', async () => {
  const ctx = await setup();
  try {
    const a = await ctx.signUp('Ann');
    const b = await ctx.signUp('Ben');
    const first = (await ctx.call('GET', '/leaderboard/settings', null, a.token)).body;
    assert.match(first.displayName, /^Trader-[0-9A-F]{4}$/);
    assert.equal(first.optOut, false);
    assert.equal(await aliasFor(ctx.db, a.id), first.displayName, 'stable');
    assert.notEqual(await aliasFor(ctx.db, b.id), first.displayName);
    const put = async (u, body) => await ctx.call('PUT', '/leaderboard/settings', body, u.token);
    assert.equal((await put(a, { displayName: 'Moonshot 42' })).body.displayName, 'Moonshot 42');
    assert.equal((await put(b, { displayName: 'moonshot 42' })).status, 409, 'unique, ignoring case');
    assert.equal((await put(a, { displayName: 'moonshot 42' })).status, 200, 'you can change your own capitalisation');
    for (const bad of ['', 'ab', 'a@b.com', 'x'.repeat(21), ' bad ! ', 'Trader-0000', '-dash', 'Drop;Table']) {
      assert.equal((await put(b, { displayName: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await put(b, {})).status, 400);
    assert.equal(validateAlias('Good_Name-1'), null);
    assert.equal((await ctx.call('GET', '/leaderboard/settings')).status, 401);
  } finally { ctx.close(); }
});

test('opting out: you disappear from public leaderboards and cannot join them, but private challenges are unaffected', async () => {
  const ctx = await setup();
  try {
    const stay = await ctx.signUp('Stay');
    const leave = await ctx.signUp('Leave');
    const cur = await ctx.current(stay);
    for (const x of [stay, leave]) await ctx.call('POST', `/challenges/${cur.id}/join`, null, x.token);
    for (const x of [stay, leave]) await ctx.spend(x, 3_000, WEEK_START + 4 * HOUR);
    ctx.clock.t = WEEK_START + 9 * HOUR;
    const names = async (viewer) => (await ctx.board(viewer, cur.id)).body.leaderboard.ranked.map((r) => r.name);
    assert.equal((await names(stay)).length, 2);
    assert.equal((await ctx.call('GET', '/challenges', null, stay.token)).body.weekly[0].participants, 2);

    await ctx.call('PUT', '/leaderboard/settings', { optOut: true }, leave.token);
    assert.deepEqual(await names(stay), [await aliasFor(ctx.db, stay.id)]);
    assert.equal((await ctx.call('GET', '/challenges', null, stay.token)).body.weekly[0].participants, 1);
    const mine = (await ctx.board(leave, cur.id)).body.leaderboard;
    const stayAlias = await aliasFor(ctx.db, stay.id);
    assert.equal(mine.ranked.some((r) => r.name === stayAlias), true, 'you can still see the board');
    assert.equal(mine.you.hidden, true, 'but you are told you are hidden');
    assert.equal(mine.ranked.some((r) => r.you), false, 'and you are not on it');
    assert.equal((await ctx.call('GET', '/leaderboard/settings', null, leave.token)).body.optOut, true);

    const newcomer = await ctx.signUp('New');
    await ctx.call('PUT', '/leaderboard/settings', { optOut: true }, newcomer.token);
    const refused = await ctx.call('POST', `/challenges/${cur.id}/join`, null, newcomer.token);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /opted out of public leaderboards/);
    assert.match((await ctx.call('GET', '/challenges', null, newcomer.token)).body.weekly[0].joinBlockedReason, /opted out/);

    // Private challenges are for friends who share a code, so opting out of the public ones does not matter there.
    const priv = (await ctx.call('POST', '/challenges', { name: 'Mates', days: 2 }, newcomer.token)).body.challenge;
    assert.equal((await ctx.call('POST', '/challenges/join', { code: priv.code }, leave.token)).status, 201);
    assert.equal((await ctx.board(leave, priv.id)).status, 200);

    await ctx.call('PUT', '/leaderboard/settings', { optOut: false }, leave.token);
    assert.equal((await names(stay)).length, 2, 'back on the board when you opt back in');
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ private challenges and invitation codes

test('private challenges: created with a code only the owner sees; members join with the code; outsiders cannot even tell it exists', async () => {
  const ctx = await setup();
  try {
    const owner = await ctx.signUp('Owner');
    const friend = await ctx.signUp('Friend');
    const stranger = await ctx.signUp('Stranger');
    const made = await ctx.call('POST', '/challenges', { name: '  Office league  ', days: 7 }, owner.token);
    assert.equal(made.status, 201);
    const ch = made.body.challenge;
    assert.match(ch.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(ch.name, 'Office league');
    assert.deepEqual([ch.owner, ch.joined, ch.kind, ch.status, ch.participants], [true, true, 'private', 'running', 1]);
    assert.equal(ch.endsAt - ch.startsAt, 7 * DAY);
    assert.equal(ch.joinDeadline, ch.startsAt + 24 * HOUR);

    assert.equal((await ctx.board(friend, ch.id)).status, 404, 'not a member yet');
    assert.equal((await ctx.call('POST', `/challenges/${ch.id}/join`, null, friend.token)).status, 404, 'no joining by id');
    const messy = ` ${ch.code.toLowerCase().replace('-', ' ')} `;
    const joined = await ctx.call('POST', '/challenges/join', { code: messy }, friend.token);
    assert.equal(joined.status, 201, 'case, spaces and the dash do not matter');
    assert.equal(joined.body.challenge.code, undefined, 'only the owner sees the code');
    assert.equal(joined.body.challenge.owner, false);
    assert.equal((await ctx.call('POST', '/challenges/join', { code: ch.code }, friend.token)).status, 409, 'already in');
    assert.equal((await ctx.board(friend, ch.id)).status, 200);
    assert.equal((await ctx.board(stranger, ch.id)).status, 404);
    assert.equal((await ctx.call('GET', '/challenges', null, stranger.token)).body.private.length, 0);
    assert.equal((await ctx.call('GET', '/challenges', null, friend.token)).body.private[0].name, 'Office league');
    assert.equal((await ctx.call('POST', '/challenges/join', { code: 'ZZZZ-ZZZZ' }, stranger.token)).status, 404);
    assert.equal((await ctx.call('POST', '/challenges/join', { code: 'short' }, stranger.token)).status, 404);
    assert.equal((await ctx.call('POST', '/challenges/join', {}, stranger.token)).status, 400);
  } finally { ctx.close(); }
});

test('invitation codes: guessing is rate-limited, rotating replaces the code, and joining closes after the first day', async () => {
  const ctx = await setup();
  try {
    const owner = await ctx.signUp('Owner');
    const guesser = await ctx.signUp('Guesser');
    const friend = await ctx.signUp('Friend');
    const ch = (await ctx.call('POST', '/challenges', { name: 'Closed circle', days: 5 }, owner.token)).body.challenge;
    for (let i = 0; i < 10; i++) assert.equal((await ctx.call('POST', '/challenges/join', { code: `AAAA-BBB${i}` }, guesser.token)).status, 404);
    const limited = await ctx.call('POST', '/challenges/join', { code: ch.code }, guesser.token);
    assert.equal(limited.status, 429, 'even the right code is refused once you have been guessing');
    assert.ok(limited.headers.get('retry-after'));
    assert.equal((await ctx.call('POST', '/challenges/join', { code: 'AAAA-BBBB' }, friend.token)).status, 404, 'the limit is per person');

    const rotated = await ctx.call('POST', `/challenges/${ch.id}/rotate-code`, null, owner.token);
    assert.notEqual(rotated.body.code, ch.code);
    assert.equal((await ctx.call('POST', '/challenges/join', { code: ch.code }, friend.token)).status, 404, 'the old code is dead');
    assert.equal((await ctx.call('POST', `/challenges/${ch.id}/rotate-code`, null, friend.token)).status, 404, 'non-members cannot rotate');
    assert.equal((await ctx.call('POST', '/challenges/join', { code: rotated.body.code }, friend.token)).status, 201);
    assert.equal((await ctx.call('POST', `/challenges/${ch.id}/rotate-code`, null, friend.token)).status, 403, 'members cannot rotate');
    assert.equal((await ctx.call('GET', '/challenges', null, owner.token)).body.private[0].code, rotated.body.code);

    ctx.clock.t = T0 + 25 * HOUR;
    const late = await ctx.signUp('Late');
    const closed = await ctx.call('POST', '/challenges/join', { code: rotated.body.code }, late.token);
    assert.equal(closed.status, 400);
    assert.match(closed.body.error, /Joining has closed/);
  } finally { ctx.close(); }
});

test('private challenges: sensible limits, leaving, and a future start', async () => {
  const ctx = await setup();
  try {
    const owner = await ctx.signUp('Owner');
    const friend = await ctx.signUp('Friend');
    const create = async (body) => await ctx.call('POST', '/challenges', body, owner.token);
    for (const bad of [{ name: 'ab', days: 3 }, { name: 'Fine name', days: 0 }, { name: 'Fine name', days: 31 }, { name: 'Fine name', days: 1.5 }, { name: 'Fine name' }, { days: 3 },
      { name: 'Fine name', days: 3, startsAt: new Date(T0 - 3 * DAY).toISOString() }, { name: 'Fine name', days: 3, startsAt: new Date(T0 + 15 * DAY).toISOString() }, { name: 'Fine name', days: 3, startsAt: 'tomorrow' }]) {
      assert.equal((await create(bad)).status, 400, JSON.stringify(bad));
    }
    const future = (await create({ name: 'Next week', days: 3, startsAt: new Date(T0 + 2 * DAY).toISOString() })).body.challenge;
    assert.equal(future.status, 'upcoming');
    assert.equal(future.startsAt, T0 + 2 * DAY);
    for (let i = 0; i < 4; i++) assert.equal((await create({ name: `League ${i}`, days: 1 })).status, 201);
    assert.equal((await create({ name: 'One too many', days: 1 })).status, 409, 'five at a time');

    assert.equal((await ctx.call('POST', '/challenges/join', { code: future.code }, friend.token)).status, 201);
    assert.equal((await ctx.call('POST', `/challenges/${future.id}/leave`, null, friend.token)).status, 200);
    assert.equal((await ctx.board(friend, future.id)).status, 404, 'once out, it is invisible again');
    assert.equal((await ctx.call('POST', `/challenges/${future.id}/leave`, null, friend.token)).status, 404);
    assert.equal((await ctx.call('POST', `/challenges/${future.id}/leave`, null, owner.token)).status, 200, 'the owner can leave too');
  } finally { ctx.close(); }
});

test('a private challenge fills up at the maximum number of people', async () => {
  const ctx = await setup();
  try {
    const owner = await ctx.signUp('Owner');
    const ch = (await ctx.call('POST', '/challenges', { name: 'Packed', days: 2 }, owner.token)).body.challenge;
    await ctx.db.prepare('UPDATE challenges SET max_participants = 2 WHERE id = ?').run(ch.id);
    const a = await ctx.signUp('Aa');
    const b = await ctx.signUp('Bb');
    assert.equal((await ctx.call('POST', '/challenges/join', { code: ch.code }, a.token)).status, 201);
    const full = await ctx.call('POST', '/challenges/join', { code: ch.code }, b.token);
    assert.equal(full.status, 400);
    assert.match(full.body.error, /full/);
  } finally { ctx.close(); }
});

test('a private challenge is ranked the same fair way, with only display names on show', async () => {
  const ctx = await setup();
  try {
    const owner = await ctx.signUp('Owner', 10_000);
    const rich = await ctx.signUp('Rich', 200_000);
    ctx.clock.t = WEEK_START + 3 * HOUR;
    const ch = (await ctx.call('POST', '/challenges', { name: 'Friends', days: 3 }, owner.token)).body.challenge;
    await ctx.call('POST', '/challenges/join', { code: ch.code }, rich.token);
    const tb = ctx.clock.t;
    const te = laterHigher(tb);
    await ctx.spend(owner, 6_000, tb);
    await ctx.spend(rich, 30_000, tb);
    await ctx.cashFlow(rich, 10_000_000, tb + HOUR / 2);
    ctx.clock.t = te;
    const lb = (await ctx.board(owner, ch.id)).body.leaderboard;
    assert.equal(lb.ranked[0].name, await aliasFor(ctx.db, owner.id));
    assert.equal((await ctx.board(owner, ch.id, 'profit')).body.leaderboard.ranked[0].name, await aliasFor(ctx.db, rich.id));
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ practice accounts

test('practice reset: a fresh balance and a clean slate, with a record of what it replaced', async () => {
  const ctx = await setup();
  try {
    const u = await ctx.signUp('Pat');
    assert.deepEqual((await ctx.call('GET', '/practice', null, u.token)).body, { balances: START_BALANCES, canReset: true, blockedReason: null, resets: 0, lastResetAt: null });
    await ctx.trade(u, 'buy', 2, T0 - HOUR);
    await ctx.trade(u, 'buy', 3, T0 - HOUR / 2, 'SOL');
    await ctx.call('POST', '/orders', { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: 1 }, u.token);
    await ctx.call('POST', '/alerts', { symbol: 'ETH', direction: 'above', target: 99999 }, u.token);
    const before = (await ctx.db.prepare('SELECT balance FROM users WHERE id = ?').get(u.id)).balance;
    assert.ok(before < 10000);

    assert.equal((await ctx.call('POST', '/practice/reset', { startingBalance: 5 }, u.token)).status, 400);
    const reset = await ctx.call('POST', '/practice/reset', { startingBalance: 100000 }, u.token);
    assert.equal(reset.status, 200);
    assert.equal(reset.body.balance, 100000);
    for (const table of ['holdings', 'orders', 'fills', 'transactions', 'price_alerts']) {
      assert.equal((await ctx.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id = ?`).get(u.id)).n, 0, table);
    }
    const rec = await ctx.db.prepare('SELECT * FROM practice_resets WHERE user_id = ?').get(u.id);
    assert.equal(rec.previous_balance, Math.round(before * 100) / 100);
    assert.ok(rec.previous_equity > 9000);
    assert.equal(rec.new_balance, 100000);
    const info = (await ctx.call('GET', '/practice', null, u.token)).body;
    assert.deepEqual([info.resets, info.lastResetAt], [1, T0]);

    const analytics = await ctx.call('GET', '/portfolio/analytics', null, u.token);
    assert.equal(analytics.status, 200);
    assert.equal(analytics.body.summary.totalValue, 100000);
    assert.equal(analytics.body.holdings.length, 0);
    assert.equal((await ctx.call('POST', '/practice/reset', {}, u.token)).body.balance, 10000, 'defaults to the standard balance');
    assert.ok((await ctx.call('GET', '/achievements', null, u.token)).body.achievements.find((a) => a.key === 'fresh_start').earned);
    assert.equal((await ctx.call('POST', '/practice/reset', {})).status, 401);
  } finally { ctx.close(); }
});

test('practice reset is blocked in the middle of a challenge, so nobody can wipe a bad run', async () => {
  const ctx = await setup();
  try {
    const u = await ctx.signUp('Quinn');
    const cur = await ctx.current(u);
    await ctx.call('POST', `/challenges/${cur.id}/join`, null, u.token);
    const blocked = await ctx.call('POST', '/practice/reset', {}, u.token);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /Weekly challenge.*has not ended/);
    const info = (await ctx.call('GET', '/practice', null, u.token)).body;
    assert.equal(info.canReset, false);
    assert.match(info.blockedReason, /has not ended/);

    await ctx.trade(u, 'buy', 1, T0);
    await ctx.call('POST', `/challenges/${cur.id}/leave`, null, u.token);
    assert.equal((await ctx.call('POST', '/practice/reset', {}, u.token)).status, 200, 'fine once you have left');

    const v = await ctx.signUp('Vee');
    await ctx.call('POST', `/challenges/${cur.id}/join`, null, v.token);
    ctx.clock.t = WEEK_END + HOUR;
    assert.equal((await ctx.call('POST', '/practice/reset', {}, v.token)).status, 200, 'and once the challenge is over');
    assert.equal((await ctx.db.prepare('SELECT finalized_at FROM challenge_entries WHERE user_id = ?').get(v.id)).finalized_at !== null, true, 'its result was frozen first');

    const w = await ctx.signUp('Wyn');
    ctx.clock.t = T0 + WEEK;
    await ctx.db.prepare("INSERT INTO withdrawal_requests (user_id, amount, created_at) VALUES (?, 5, 1)").run(w.id);
    assert.match((await ctx.call('POST', '/practice/reset', {}, w.token)).body.error, /withdrawal request/);
    const s = await ctx.signUp('Sam');
    await ctx.db.prepare('UPDATE users SET suspended_at = 1 WHERE id = ?').run(s.id);
    assert.match((await ctx.call('POST', '/practice/reset', {}, s.token)).body.error, /suspended/);
  } finally { ctx.close(); }
});

// ------------------------------------------------------------------ achievements

test('achievements: a fixed list of beginner goals, each earned once and announced', async () => {
  const ctx = await setup();
  try {
    const u = await ctx.signUp('Ada');
    assert.equal(new Set(ACHIEVEMENTS.map((a) => a.key)).size, ACHIEVEMENTS.length);
    const fresh = (await ctx.call('GET', '/achievements', null, u.token)).body;
    assert.equal(fresh.total, ACHIEVEMENTS.length);
    assert.equal(fresh.earned, 0);
    assert.ok(fresh.achievements.every((a) => a.title && a.description && !a.earned && a.earnedAt === null));
    assert.equal((await ctx.call('GET', '/achievements')).status, 401);

    const order = await ctx.call('POST', '/orders', { symbol: 'ETH', side: 'buy', type: 'market', quantity: 1 }, u.token);
    assert.equal(order.status, 201);
    const get = async () => Object.fromEntries((await ctx.call('GET', '/achievements', null, u.token)).body.achievements.map((a) => [a.key, a]));
    let a = await get();
    assert.equal(a.first_trade.earned, true);
    assert.equal(a.first_sale.earned, false);
    const when = a.first_trade.earnedAt;
    await ctx.call('POST', '/orders', { symbol: 'ETH', side: 'buy', type: 'market', quantity: 1 }, u.token);
    a = await get();
    assert.equal(a.first_trade.earnedAt, when, 'earning it again changes nothing');
    const notes = await ctx.db.prepare("SELECT message FROM notifications WHERE user_id = ? AND kind = 'achievement'").all(u.id);
    assert.equal(notes.filter((n) => /First trade/.test(n.message)).length, 1, 'announced once');
  } finally { ctx.close(); }
});

test('achievements: every beginner goal can be earned by doing what it says', async () => {
  const ctx = await setup();
  try {
    const u = await ctx.signUp('Eve', 1_000_000);
    const helper = [await ctx.signUp('H1'), await ctx.signUp('H2')];
    const get = async () => Object.fromEntries((await ctx.call('GET', '/achievements', null, u.token)).body.achievements.map((a) => [a.key, a.earned]));
    const call = async (m, p, b) => await ctx.call(m, p, b, u.token);
    const tb = WEEK_START + 2 * HOUR;
    const te = laterHigher(tb);

    // profit: buy low, sell high, and the sale counts
    await ctx.trade(u, 'buy', 2, tb);
    await ctx.trade(u, 'sell', 2, te);
    let a = await get();
    assert.deepEqual([a.first_trade, a.first_sale, a.first_profit], [true, true, true]);
    assert.equal(a.limit_order, false);

    await call('POST', '/orders', { symbol: 'ETH', side: 'buy', type: 'limit', quantity: 1, price: 1 });
    assert.equal((await get()).limit_order, true);
    assert.equal((await get()).safety_net, false);
    await call('PUT', '/risk', { dailyLossLimit: 500 });
    assert.equal((await get()).safety_net, true, 'setting a daily loss limit counts');

    assert.equal((await get()).price_alert, false);
    await call('POST', '/alerts', { symbol: 'ETH', direction: 'above', target: 99999 });
    assert.equal((await get()).price_alert, true);

    for (const s of ['BTC', 'ETH']) await call('PUT', `/watchlist/${s}`);
    assert.equal((await get()).curator, false);
    await call('PUT', '/watchlist/SOL');
    assert.equal((await get()).curator, true);

    // explorer and diversified: three markets, three holdings
    await ctx.trade(u, 'buy', 1, T0, 'ETH');
    assert.equal((await get()).explorer, false);
    await ctx.trade(u, 'buy', 5, T0, 'AAPL');
    await ctx.trade(u, 'buy', 1, T0, 'XAU');
    a = await get();
    assert.deepEqual([a.explorer, a.diversified], [true, true]);

    assert.equal(a.secured, false);
    const setupRes = await call('POST', '/auth/2fa/setup');
    await call('POST', '/auth/2fa/enable', { code: totp(setupRes.body.secret, ctx.clock.t) });
    assert.equal((await get()).secured, true);

    assert.equal((await get()).challenger, false);
    const cur = await ctx.current(u);
    await call('POST', `/challenges/${cur.id}/join`, null);
    assert.equal((await get()).challenger, true);
    assert.equal((await get()).finisher, false);
  } finally { ctx.close(); }
});

test('achievements: finishing a challenge, and a podium place only when at least three people were ranked', async () => {
  const ctx = await setup();
  try {
    const owner = await ctx.signUp('Owner');
    const ch = (await ctx.call('POST', '/challenges', { name: 'Three-way', days: 2 }, owner.token)).body.challenge;
    const players = [owner, await ctx.signUp('P2'), await ctx.signUp('P3')];
    for (const p of players.slice(1)) await ctx.call('POST', '/challenges/join', { code: ch.code }, p.token);
    // The 'owner' wins; with only two traders the podium would not count, with three it does.
    await ctx.spend(players[0], 6_000, T0 + HOUR);
    await ctx.spend(players[1], 3_000, T0 + HOUR);
    await ctx.spend(players[2], 1_000, T0 + HOUR);
    ctx.clock.t = T0 + 2 * DAY + HOUR;
    await ctx.call('GET', '/challenges', null, owner.token);
    const earned = async (u) => Object.fromEntries((await ctx.db.prepare('SELECT key FROM achievements WHERE user_id = ?').all(u.id)).map((r) => [r.key, true]));
    for (const p of players) assert.equal((await earned(p)).finisher, true, 'everyone with a ranked result finished');
    const ranks = await ctx.db.prepare('SELECT user_id, final_rank FROM challenge_entries WHERE challenge_id = ? ORDER BY final_rank').all(ch.id);
    assert.equal(ranks.length, 3);
    for (const p of players) assert.equal((await earned(p)).podium, true);

    const duo = (await ctx.call('POST', '/challenges', { name: 'Just two', days: 1 }, players[0].token)).body.challenge;
    await ctx.call('POST', '/challenges/join', { code: duo.code }, players[1].token);
    await ctx.db.prepare('DELETE FROM achievements').run();
    ctx.clock.t += 3 * DAY;
    await ctx.db.prepare('UPDATE challenges SET ends_at = ? WHERE id = ?').run(ctx.clock.t - 1, duo.id);
    await ctx.db.prepare('DELETE FROM challenge_entries WHERE challenge_id = ?').run(ch.id);
    await ctx.spend(players[0], 1_000, ctx.clock.t - 2 * HOUR);
    await ctx.call('GET', '/challenges', null, players[0].token);
    assert.ok(!(await earned(players[0])).podium, 'two traders is not a podium');
  } finally { ctx.close(); }
});
