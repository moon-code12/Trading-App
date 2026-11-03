// Portfolio analytics. Everything here is computed from the order and transaction
// ledgers, so figures stay consistent with what the user actually did. All values
// are simulated (demo) funds priced from the simulated market.
import { getAsset, priceAt } from './market.js';

// Prices and quantities keep 6 decimals (forex pairs trade near 1.0); money keeps 4.
const rnd = (n, d) => { const f = 10 ** d; return Math.round((n + Number.EPSILON) * f) / f; };
const px = (n) => rnd(n, 6);
const usd = (n) => rnd(n, 4);
const pct = (n) => rnd(n, 4);

export const PERIODS = { '1D': 24 * 3600e3, '1W': 7 * 24 * 3600e3, '1M': 30 * 24 * 3600e3, ALL: Infinity };
const POINTS = 60;
const EPS = 1e-9;

export const parseTs = (s) => Date.parse(`${s.replace(' ', 'T')}Z`);

// Replays fills in order using weighted-average cost. A sell realizes
// (price - avgCost) * quantity and leaves the average cost unchanged.
export function replayFills(fills) {
  const positions = new Map();
  const realizedByOrder = new Map();
  const realizedBySymbol = new Map();
  let realized = 0;
  for (const f of fills) {
    const pos = positions.get(f.symbol) ?? { quantity: 0, avgCost: 0 };
    if (f.side === 'buy') {
      const q = pos.quantity + f.quantity;
      pos.avgCost = (pos.avgCost * pos.quantity + f.price * f.quantity + (f.fee ?? 0)) / q;
      pos.quantity = q;
      positions.set(f.symbol, pos);
    } else {
      const qty = Math.min(f.quantity, pos.quantity);
      const pnl = (f.price - pos.avgCost) * qty - (f.fee ?? 0);
      realized += pnl;
      realizedByOrder.set(f.id, pnl);
      realizedBySymbol.set(f.symbol, (realizedBySymbol.get(f.symbol) ?? 0) + pnl);
      pos.quantity -= qty;
      if (pos.quantity < EPS) positions.delete(f.symbol);
    }
  }
  return { positions, realized, realizedByOrder, realizedBySymbol };
}

// Loads the ledger as time-ordered events: cash changes and share-quantity changes.
async function loadLedger(db, user) {
  const row = await db.prepare('SELECT balance, created_at FROM users WHERE id = ?').get(user.id);
  const fills = await db.prepare('SELECT id, order_id, symbol, side, quantity, price, fee, filled_at FROM fills WHERE user_id = ? ORDER BY filled_at, id').all(user.id);
  const txs = await db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id').all(user.id);
  const fillById = new Map(fills.map((f) => [f.id, f]));

  // The opening balance is whatever the ledger does not explain (demo accounts start with 10,000).
  const initialCash = rnd(row.balance - txs.reduce((s, t) => s + t.amount, 0), 2);
  const createdAt = parseTs(row.created_at);

  const events = txs.map((t) => {
    const o = t.fill_id ? fillById.get(t.fill_id) : null;
    const isFlow = t.type === 'deposit' || t.type === 'withdrawal';
    return {
      t: o ? parseTs(o.filled_at) : parseTs(t.created_at),
      cash: t.amount,
      flow: isFlow ? t.amount : 0,
      trade: o ? { symbol: o.symbol, qty: o.side === 'buy' ? o.quantity : -o.quantity } : null,
    };
  }).sort((a, b) => a.t - b.t);
  return { row, fills, txs, initialCash, createdAt, events };
}

// Walks events once while sampling ascending times; returns the equity at each time.
function equitySeries(ledger, times) {
  const { events, initialCash } = ledger;
  let i = 0;
  let cash = initialCash;
  const qty = new Map();
  return times.map((t) => {
    for (; i < events.length && events[i].t <= t; i++) {
      cash += events[i].cash;
      const tr = events[i].trade;
      if (tr) qty.set(tr.symbol, (qty.get(tr.symbol) ?? 0) + tr.qty);
    }
    let held = 0;
    for (const [symbol, q] of qty) if (q > EPS) held += q * priceAt(getAsset(symbol), t);
    return cash + held;
  });
}

function period(ledger, key, now) {
  return periodFrom(ledger, key === 'ALL' ? ledger.createdAt : now - PERIODS[key], now);
}

function periodFrom(ledger, from, now) {
  const start = Math.max(from, ledger.createdAt);
  const span = Math.max(now - start, 0);
  const times = Array.from({ length: POINTS }, (_, i) => start + (span * i) / (POINTS - 1));
  times[POINTS - 1] = now;
  const values = equitySeries(ledger, times);
  const startValue = values[0];
  const endValue = values[POINTS - 1];
  // Deposits and withdrawals are not performance, so they are stripped out (Modified Dietz style).
  const flows = ledger.events.filter((e) => e.t > start && e.t <= now).reduce((s, e) => s + e.flow, 0);
  const base = startValue + flows;
  const change = endValue - startValue - flows;
  return {
    since: new Date(start).toISOString(),
    startValue: usd(startValue), endValue: usd(endValue), netDeposits: usd(flows),
    pnl: usd(change), returnPct: base > 0 ? pct((change / base) * 100) : 0,
    history: times.map((t, i) => ({ t: Math.round(t), value: usd(values[i]) })),
  };
}

export async function computeAnalytics(db, user, now = Date.now()) {
  const ledger = await loadLedger(db, user);
  const { positions, realized, realizedBySymbol } = replayFills(ledger.fills.map((f) => ({ ...f })));
  const cash = ledger.initialCash + ledger.events.reduce((s, e) => s + e.cash, 0);

  const holdings = [...positions].map(([symbol, p]) => {
    const asset = getAsset(symbol);
    const price = priceAt(asset, now);
    const costBasis = p.avgCost * p.quantity;
    const value = price * p.quantity;
    return {
      symbol, name: asset.name, category: asset.category,
      quantity: px(p.quantity), avgCost: px(p.avgCost), price: px(price),
      costBasis: usd(costBasis), value: usd(value),
      unrealizedPnl: usd(value - costBasis),
      unrealizedPct: costBasis > 0 ? pct(((value - costBasis) / costBasis) * 100) : 0,
      realizedPnl: usd(realizedBySymbol.get(symbol) ?? 0),
      _value: value,
    };
  }).sort((a, b) => b._value - a._value);

  const invested = holdings.reduce((s, h) => s + h._value, 0);
  const totalValue = cash + invested;
  const unrealized = holdings.reduce((s, h) => s + h.unrealizedPnl, 0);
  const ranked = [...holdings].sort((a, b) => b.unrealizedPct - a.unrealizedPct);

  const allocation = [
    { label: 'Cash', symbol: null, value: usd(cash) },
    ...holdings.map((h) => ({ label: h.symbol, symbol: h.symbol, value: h.value })),
  ].map((a) => ({ ...a, pct: totalValue > 0 ? pct((a.value / totalValue) * 100) : 0 }));

  const performance = Object.fromEntries(Object.keys(PERIODS).map((k) => [k, period(ledger, k, now)]));
  const pick = (h) => h && { symbol: h.symbol, unrealizedPnl: h.unrealizedPnl, unrealizedPct: h.unrealizedPct };

  return {
    mode: 'demo',
    note: 'All figures are simulated demo values, not real money.',
    asOf: new Date(now).toISOString(),
    summary: {
      cash: usd(cash), invested: usd(invested), totalValue: usd(totalValue),
      realizedPnl: usd(realized), unrealizedPnl: usd(unrealized),
      tradingPnl: usd(realized + unrealized),
      dailyReturnPct: performance['1D'].returnPct, dailyPnl: performance['1D'].pnl,
      totalReturnPct: performance.ALL.returnPct, totalPnl: performance.ALL.pnl,
      netDeposits: performance.ALL.netDeposits, startingBalance: usd(ledger.initialCash),
    },
    holdings: holdings.map(({ _value, ...h }) => h),
    allocation,
    performance,
    best: pick(ranked[0]) ?? null,
    worst: ranked.length > 1 ? pick(ranked[ranked.length - 1]) : null,
  };
}

// ---- CSV statement

const csvText = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheets treating text as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvNum = (n) => (n === null || n === undefined ? '' : String(n));

export async function buildStatement(db, user) {
  const ledger = await loadLedger(db, user);
  const { realizedByOrder: realizedByFill } = replayFills(ledger.fills.map((f) => ({ ...f })));
  const fillById = new Map(ledger.fills.map((f) => [f.id, f]));
  const head = ['date_utc', 'type', 'symbol', 'quantity', 'price', 'amount', 'realized_pnl', 'balance_after', 'description', 'mode'];
  const iso = (s) => new Date(parseTs(s)).toISOString();
  let balance = ledger.initialCash;
  const rows = [[iso(ledger.row.created_at), 'opening_balance', '', '', '', csvNum(rnd(balance, 2)), '', csvNum(rnd(balance, 2)), 'Starting demo balance', 'DEMO']];
  for (const t of ledger.txs) {
    balance += t.amount;
    const o = t.fill_id ? fillById.get(t.fill_id) : null;
    rows.push([
      iso(o ? o.filled_at : t.created_at), t.type, t.symbol ?? '',
      o ? o.quantity : '', o ? o.price : '', rnd(t.amount, 4),
      o && o.side === 'sell' ? usd(realizedByFill.get(o.id) ?? 0) : '',
      rnd(balance, 4), t.note ?? '', 'DEMO',
    ]);
  }
  const textCols = new Set([1, 2, 8]);
  const lines = [head.join(','), ...rows.map((r) => r.map((v, i) => (textCols.has(i) ? csvText(v) : csvNum(v))).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

// Equity change since `from` with deposits and withdrawals stripped out (used by the daily loss limit).
export async function performanceSince(db, user, from, now = Date.now()) {
  const p = periodFrom(await loadLedger(db, user), from, now);
  return { pnl: p.pnl, returnPct: p.returnPct, startValue: p.startValue, endValue: p.endValue };
}

// Performance between two moments that deposits and withdrawals cannot change, used to rank challenges.
//   returnPct  time-weighted return: the account's return is measured separately between each deposit or withdrawal and
//              the results chained together, so putting money in (or taking it out) has no effect on the percentage
//              whenever it happens. (Dividing profit by "start plus deposits" would let a late deposit hide a loss.)
//   pnl        what trading made or lost: end value minus start value minus net deposits.
// Everything that is not a deposit or withdrawal (trades, fees) counts.
export async function timeWeightedPerformance(db, user, from, to) {
  const ledger = await loadLedger(db, user);
  const start = Math.max(from, ledger.createdAt);
  const end = Math.max(to, start);
  const flows = ledger.events.filter((e) => e.flow !== 0 && e.t > start && e.t <= end);
  // Equity at the start, just after each flow (events at the same moment are included), and at the end.
  const times = [start, ...flows.map((e) => e.t), end];
  const equity = equitySeries(ledger, times);
  let growth = 1;
  let after = equity[0];
  flows.forEach((flow, i) => {
    const before = equity[i + 1] - flow.flow; // equity an instant before the money moved
    if (after > EPS) growth *= before / after;
    after = equity[i + 1];
  });
  if (after > EPS) growth *= equity[equity.length - 1] / after;
  const netFlows = flows.reduce((s, e) => s + e.flow, 0);
  const endValue = equity[equity.length - 1];
  return {
    from: start, to: end, startValue: equity[0], endValue, netFlows,
    pnl: endValue - equity[0] - netFlows, returnPct: (growth - 1) * 100,
  };
}
