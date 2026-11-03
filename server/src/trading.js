// Order engine: validation, risk checks, triggers, partial fills, expiry and OCO.
// All money here is simulated demo funds. Every state change that touches several rows
// (balance, holdings, fills, ledger, sibling orders) runs inside one savepoint so it
// either fully happens or not at all.
import { getAsset, priceAt, liquiditySlot, LIQUIDITY_SLOT_MS } from './market.js';
import { notify } from './db.js';
import { isOpen, nextOpen } from './sessions.js';
import {
  PAPER_TRADING_NOTICE, bidAsk, checkQuantity, feeFor, floorToStep, getSimulation, latencyMs, liquidityAt, maxSlippageBps, paramsFor,
  quantityRules, slippageBps,
} from './simulation.js';
import { performanceSince } from './analytics.js';
import { evaluateAchievements } from './achievements.js';

const r2 = (n) => Math.round(n * 100) / 100;
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const EPS = 1e-9;
const DAY_MS = 24 * 3600e3;

export const ORDER_TYPES = ['market', 'limit', 'stop', 'stop_loss', 'take_profit', 'stop_limit', 'trailing_stop'];
export const OCO_LEG_TYPES = ['limit', 'stop', 'stop_loss', 'take_profit', 'stop_limit'];
const SELL_ONLY = new Set(['stop_loss', 'take_profit', 'trailing_stop']);
const LABELS = {
  market: 'Market', limit: 'Limit', stop: 'Stop', stop_loss: 'Stop-loss', take_profit: 'Take-profit',
  stop_limit: 'Stop-limit', trailing_stop: 'Trailing stop',
};
// Orders that execute at whatever the market is offering once triggered, so they can slip. Limit-type orders never do.
const MARKET_STYLE = new Set(['market', 'stop', 'stop_loss', 'trailing_stop']);
const WORKING = "status IN ('pending', 'partially_filled')";

export class OrderError extends Error {
  constructor(message, { status = 400, code = 'INVALID_ORDER', details } = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}
const fail = (msg, opts) => { throw new OrderError(msg, opts); };

// Nested-safe transaction: a real transaction at the top level, savepoints inside it.
export const atomic = (db, fn) => db.transaction(fn);

const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
export const dayStart = (now) => Math.floor(now / DAY_MS) * DAY_MS;
export const dayEnd = (now) => dayStart(now) + DAY_MS;
const remaining = (o) => Math.max(o.quantity - o.filled_quantity, 0);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

// ---------------------------------------------------------------- risk settings

export async function lossState(db, userId, now = Date.now(), { full = false } = {}) {
  const u = await db.prepare('SELECT daily_loss_limit FROM users WHERE id = ?').get(userId);
  if (u.daily_loss_limit === null && !full) return { limit: null, loss: 0, pnl: 0, reached: false };
  const { pnl } = await performanceSince(db, { id: userId }, dayStart(now), now);
  const loss = Math.max(0, r2(-pnl));
  const limit = u.daily_loss_limit;
  return { limit, loss, pnl: r2(pnl), reached: limit !== null && loss >= limit - EPS };
}

export async function riskSettings(db, userId, now = Date.now()) {
  const u = await db.prepare('SELECT daily_loss_limit, max_order_pct, large_order_pct FROM users WHERE id = ?').get(userId);
  const state = await lossState(db, userId, now, { full: true });
  return {
    dailyLossLimit: u.daily_loss_limit, maxOrderPct: u.max_order_pct, largeOrderPct: u.large_order_pct,
    todayLoss: state.loss, todayPnl: state.pnl, limitReached: state.reached,
    resetsAt: new Date(dayEnd(now)).toISOString(), mode: 'demo',
  };
}

export async function updateRiskSettings(db, userId, { dailyLossLimit, maxOrderPct, largeOrderPct }, now = Date.now()) {
  if (dailyLossLimit !== undefined) await db.prepare('UPDATE users SET daily_loss_limit = ? WHERE id = ?').run(dailyLossLimit, userId);
  if (maxOrderPct !== undefined) await db.prepare('UPDATE users SET max_order_pct = ? WHERE id = ?').run(maxOrderPct, userId);
  if (largeOrderPct !== undefined) await db.prepare('UPDATE users SET large_order_pct = ? WHERE id = ?').run(largeOrderPct, userId);
  return await riskSettings(db, userId, now);
}

// ---------------------------------------------------------------- reservations

// Cash and shares already committed to working orders. An OCO pair can only fill one
// leg, so a group counts once (its largest leg).
async function reserved(db, uid) {
  const rows = await db.prepare(`SELECT * FROM orders WHERE user_id = ? AND ${WORKING}`).all(uid);
  const groups = new Map();
  let cash = 0;
  const shares = {};
  const add = (symbol, c, q) => { cash += c; shares[symbol] = (shares[symbol] ?? 0) + q; };
  for (const o of rows) {
    const c = o.side === 'buy' ? remaining(o) * (o.reserve_price ?? o.limit_price ?? o.price ?? 0) : 0;
    const q = o.side === 'sell' ? remaining(o) : 0;
    if (o.oco_group === null) { add(o.symbol, c, q); continue; }
    const g = groups.get(o.oco_group) ?? { symbol: o.symbol, c: 0, q: 0 };
    g.c = Math.max(g.c, c);
    g.q = Math.max(g.q, q);
    groups.set(o.oco_group, g);
  }
  for (const g of groups.values()) add(g.symbol, g.c, g.q);
  return { cash, shares };
}

async function portfolioValue(db, uid, balance, now) {
  const held = (await db.prepare('SELECT symbol, quantity FROM holdings WHERE user_id = ?').all(uid))
    .reduce((s, h) => s + h.quantity * priceAt(getAsset(h.symbol), now), 0);
  return balance + held;
}

// ---------------------------------------------------------------- validation

// Does this order rest away from the market right now (true) or trigger immediately (false)?
function triggersNow(f, p) {
  const buy = f.side === 'buy';
  switch (f.type) {
    case 'market': return true;
    case 'limit': return buy ? p <= f.price : p >= f.price;
    case 'take_profit': return p >= f.price;
    case 'stop': case 'stop_loss': return buy ? p >= f.price : p <= f.price;
    case 'stop_limit': return (buy ? p >= f.price : p <= f.price) && (buy ? p <= f.limit_price : p >= f.limit_price);
    default: return false;
  }
}

// Turns a request into the row to store, throwing OrderError on anything unacceptable.
function normalizeLeg(spec, side, quantity, p, asset) {
  const type = spec.type;
  if (!ORDER_TYPES.includes(type)) fail('Unknown order type');
  if (SELL_ONLY.has(type) && side !== 'sell') fail(`${LABELS[type]} orders can only be used to sell`);
  const positive = (v, name) => { if (!(num(v) > 0)) fail(`${name} is required and must be positive`); return v; };
  const f = { type, side, quantity, price: null, limit_price: null, trail_mode: null, trail_value: null, peak_price: null };
  switch (type) {
    case 'market': break;
    case 'limit': f.price = positive(spec.price, 'Limit price'); break;
    case 'stop': f.price = positive(spec.price, 'Stop price'); break;
    case 'stop_loss':
      f.price = positive(spec.price, 'Stop-loss price');
      if (f.price >= p) fail('Stop-loss price must be below the current price');
      break;
    case 'take_profit':
      f.price = positive(spec.price, 'Take-profit price');
      if (f.price <= p) fail('Take-profit price must be above the current price');
      break;
    case 'stop_limit':
      f.price = positive(spec.price, 'Stop price');
      f.limit_price = positive(spec.limitPrice, 'Limit price');
      break;
    case 'trailing_stop': {
      const amount = num(spec.trailAmount);
      const percent = num(spec.trailPercent);
      if ((amount > 0) === (percent > 0)) fail('Provide either a trailing amount or a trailing percent');
      if (amount > 0) {
        if (amount >= p) fail('Trailing amount must be smaller than the current price');
        Object.assign(f, { trail_mode: 'amount', trail_value: amount });
      } else {
        if (percent >= 100) fail('Trailing percent must be below 100');
        Object.assign(f, { trail_mode: 'percent', trail_value: percent });
      }
      f.peak_price = p;
      f.price = trailLevel(f, p);
      break;
    }
    default: break;
  }
  // The most cash a buy could need per unit if it fills at the price it rests at, plus room for the fee, and for slippage
  // and a gap at the open when the order executes at market.
  if (side === 'buy') {
    const base = type === 'market' ? p
      : type === 'limit' ? Math.min(f.price, p)
        : type === 'stop' ? Math.max(f.price, p)
          : Math.min(f.limit_price, Math.max(f.price, p));
    f.reserve_price = base * (1 + reserveMargin(asset, type));
  } else f.reserve_price = null;
  return f;
}

// Extra room, as a fraction, kept back for buys: the fee always, and for market-style orders slippage and an opening gap.
function reserveMargin(asset, type) {
  const sim = getSimulation();
  const { feeBps, gapBps, risk } = paramsFor(asset, sim);
  let margin = feeBps / 1e4;
  if (MARKET_STYLE.has(type)) margin += maxSlippageBps(asset, sim) / 1e4 + (sim.gaps && asset.session !== 'always' ? (2 * gapBps * risk) / 1e4 : 0);
  return margin;
}

const trailLevel = (o, peak) => r6(o.trail_mode === 'percent' ? peak * (1 - o.trail_value / 100) : peak - o.trail_value);

function checkCommon(spec) {
  if (!(num(spec.quantity) >= 1e-6)) fail('Quantity must be a positive number (minimum 0.000001)');
  if (!['buy', 'sell'].includes(spec.side)) fail('Side must be buy or sell');
  const tif = spec.timeInForce;
  if (tif !== undefined && !['day', 'gtc'].includes(tif)) fail('Time in force must be day or gtc');
}

// Validates and prices one order or an OCO pair without writing anything.
async function plan(db, user, spec, now) {
  checkCommon(spec);
  const asset = getAsset(spec.symbol);
  if (!asset) fail('Unknown asset');
  if ((asset.status ?? 'active') !== 'active') fail(`Trading in ${asset.symbol} is currently ${asset.status}`, { status: 409, code: 'ASSET_UNAVAILABLE' });
  const legSpecs = spec.legs ?? [spec];
  if (spec.legs) {
    if (legSpecs.length !== 2) fail('An OCO order needs exactly two legs');
    if (legSpecs.some((l) => !OCO_LEG_TYPES.includes(l.type))) fail(`OCO legs must be one of: ${OCO_LEG_TYPES.map((t) => LABELS[t]).join(', ')}`);
  }
  const qtyProblem = checkQuantity(asset, spec.quantity);
  if (qtyProblem) fail(qtyProblem, { code: 'INVALID_QUANTITY', details: { rules: quantityRules(asset) } });
  const mid = priceAt(asset, now);
  const book = bidAsk(asset, mid);
  const p = spec.side === 'buy' ? book.ask : book.bid; // buyers pay the ask, sellers receive the bid
  const legs = legSpecs.map((l) => normalizeLeg(l, spec.side, spec.quantity, p, asset));
  if (spec.legs && legs.some((l) => triggersNow(l, p))) fail('Each OCO leg must rest away from the current price, otherwise it would fill immediately');

  const user0 = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (user0.suspended_at) fail('Your account is suspended, so you cannot trade. Contact support for help', { status: 403, code: 'ACCOUNT_SUSPENDED' });
  const held = await reserved(db, user.id);
  const buy = spec.side === 'buy';
  const needCash = Math.max(...legs.map((l) => (buy ? spec.quantity * l.reserve_price : 0)));
  if (buy && r2(needCash) > r2(user0.balance - held.cash)) fail('Insufficient funds');
  if (!buy) {
    const h = await db.prepare('SELECT quantity FROM holdings WHERE user_id = ? AND symbol = ?').get(user.id, spec.symbol);
    const free = (h?.quantity ?? 0) - (held.shares[spec.symbol] ?? 0);
    if (spec.quantity > free + EPS) fail('Insufficient holdings');
  }

  const loss = await lossState(db, user.id, now);
  if (buy && loss.reached) {
    fail(`Daily demo-loss limit reached (${loss.loss.toFixed(2)} of ${loss.limit.toFixed(2)}). New buy orders are paused until the next UTC day`, { status: 403, code: 'DAILY_LOSS_LIMIT' });
  }

  const notional = spec.quantity * (buy ? Math.max(...legs.map((l) => l.reserve_price)) : p);
  const total = await portfolioValue(db, user.id, user0.balance, now);
  const pct = total > 0 ? (notional / total) * 100 : 100;
  const warnings = [];
  if (pct > user0.max_order_pct) {
    warnings.push({ code: 'MAX_ORDER_SIZE', message: `This order is ${pct.toFixed(1)}% of your portfolio, above your ${user0.max_order_pct}% maximum order size.` });
  }
  if (asset.risk === 'high') {
    warnings.push({ code: 'VOLATILE_ASSET', message: `${asset.symbol} is a highly volatile asset. Its price can swing several percent within hours, so losses can be sudden.` });
  }
  if (buy && loss.limit !== null && loss.loss >= loss.limit * 0.8) {
    warnings.push({ code: 'DAILY_LOSS_NEAR', message: `You have lost ${loss.loss.toFixed(2)} today, close to your ${loss.limit.toFixed(2)} daily demo-loss limit.` });
  }
  const slotLiquidity = liquidityAt(asset, liquiditySlot(now));
  if (spec.quantity > slotLiquidity) {
    warnings.push({ code: 'PARTIAL_FILL', message: `Simulated liquidity for ${asset.symbol} is about ${Number(slotLiquidity.toPrecision(3))} per 5 seconds, so this order will fill in several parts.` });
  }
  const sim = getSimulation();
  const marketOpen = !sim.marketHours || isOpen(asset.session, now);
  const opensAt = marketOpen ? null : nextOpen(asset.session, now);
  if (!marketOpen) {
    warnings.push({ code: 'MARKET_CLOSED', message: `The ${asset.symbol} market is closed. The order will wait and execute after it opens (${new Date(opensAt).toISOString().replace('T', ' ').slice(0, 16)} UTC), at whatever price it opens at, which can be quite different (a price gap).` });
  }

  const tif = spec.timeInForce ?? (legs[0].type === 'market' ? 'day' : 'gtc');
  return {
    asset, price: p, legs, tif, warnings, tifExpiresAt: tif === 'day' ? dayEnd(opensAt ?? now) : null,
    requiresConfirmation: pct > user0.large_order_pct,
    estimate: {
      price: mid, bid: book.bid, ask: book.ask, spreadBps: book.spreadBps, notional: r2(notional), portfolioPct: r6(pct),
      estimatedFee: feeFor(asset, notional), maxSlippageBps: maxSlippageBps(asset), marketOpen, opensAt: opensAt ? new Date(opensAt).toISOString() : null,
      mode: 'demo', notice: PAPER_TRADING_NOTICE,
    },
  };
}

export async function previewOrder(db, user, spec, now = Date.now()) {
  const pl = await plan(db, user, spec, now);
  return {
    estimate: pl.estimate, warnings: pl.warnings, requiresConfirmation: pl.requiresConfirmation,
    timeInForce: pl.tif, expiresAt: pl.tifExpiresAt ? new Date(pl.tifExpiresAt).toISOString() : null,
    legs: pl.legs.map(({ type, price, limit_price, trail_mode, trail_value }) => ({ type, price, limitPrice: limit_price, trailMode: trail_mode, trailValue: trail_value })),
  };
}

// ---------------------------------------------------------------- placing

const INSERT = `INSERT INTO orders (user_id, symbol, side, type, quantity, price, status, limit_price, trail_mode, trail_value,
  peak_price, tif, expires_at, oco_group, reserve_price) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`;

export async function placeOrder(db, user, spec, now = Date.now(), { confirmLarge = false } = {}) {
  const pl = await plan(db, user, spec, now);
  if (pl.requiresConfirmation && !confirmLarge) {
    fail('This is a large order. Please confirm it to continue', {
      status: 409, code: 'LARGE_ORDER_CONFIRMATION_REQUIRED', details: { warnings: pl.warnings, estimate: pl.estimate },
    });
  }
  const ids = await atomic(db, async () => {
    const insert = async (f, group) => {
      const id = (await db.prepare(INSERT).run(
        user.id, spec.symbol, f.side, f.type, f.quantity, f.price, f.limit_price, f.trail_mode, f.trail_value,
        f.peak_price, pl.tif, pl.tifExpiresAt, group, f.reserve_price,
      )).lastInsertRowid;
      // The order takes a moment to reach the (simulated) market.
      const delay = latencyMs(pl.asset, id);
      if (delay) await db.prepare('UPDATE orders SET execute_after = ? WHERE id = ?').run(now + delay, id);
      return id;
    };
    if (pl.legs.length === 1) return [await insert(pl.legs[0], null)];
    const a = await insert(pl.legs[0], null);
    const b = await insert(pl.legs[1], a);
    await db.prepare('UPDATE orders SET oco_group = ? WHERE id = ?').run(a, a);
    return [a, b];
  });
  if (pl.legs.length === 1) await processOrder(db, ids[0], now);
  const rows = await Promise.all(ids.map(async (id) => await db.prepare('SELECT * FROM orders WHERE id = ?').get(id)));
  return { order: rows[0], orders: rows, warnings: pl.warnings, estimate: pl.estimate };
}

export async function cancelOrder(db, userId, id) {
  const o = await db.prepare(`SELECT * FROM orders WHERE id = ? AND user_id = ? AND ${WORKING}`).get(id, userId);
  if (!o) return null;
  return await atomic(db, async () => {
    const targets = o.oco_group === null ? [o.id]
      : (await db.prepare(`SELECT id FROM orders WHERE oco_group = ? AND ${WORKING}`).all(o.oco_group)).map((r) => r.id);
    for (const t of targets) await db.prepare("UPDATE orders SET status = 'cancelled', note = 'Cancelled by you' WHERE id = ?").run(t);
    return targets;
  });
}

// ---------------------------------------------------------------- matching

function evaluate(o, p) {
  const buy = o.side === 'buy';
  const patch = {};
  let ready = false;
  const latch = (hit) => { if (hit && !o.triggered) patch.triggered = 1; return !!(o.triggered || hit); };
  switch (o.type) {
    case 'market': ready = true; break;
    case 'limit': ready = buy ? p <= o.price : p >= o.price; break;
    case 'take_profit': ready = p >= o.price; break;
    case 'stop': case 'stop_loss': ready = latch(buy ? p >= o.price : p <= o.price); break;
    case 'stop_limit': {
      const triggered = latch(buy ? p >= o.price : p <= o.price);
      ready = triggered && (buy ? p <= o.limit_price : p >= o.limit_price);
      break;
    }
    case 'trailing_stop': {
      const peak = Math.max(o.peak_price ?? p, p);
      const level = trailLevel(o, peak);
      if (peak !== o.peak_price) patch.peak_price = peak;
      if (level !== o.price) patch.price = level;
      ready = latch(p <= level);
      break;
    }
    default: break;
  }
  return { ready, patch };
}

async function persist(db, id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await db.prepare(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), id);
}

async function cancelSiblings(db, o, reason) {
  if (o.oco_group === null) return;
  const sibs = await db.prepare(`SELECT id FROM orders WHERE oco_group = ? AND id != ? AND ${WORKING}`).all(o.oco_group, o.id);
  for (const s of sibs) await db.prepare("UPDATE orders SET status = 'cancelled', note = ? WHERE id = ?").run(reason, s.id);
  if (sibs.length) await notify(db, o.user_id, 'order', `OCO: the other leg of order #${o.id} (${o.symbol}) was cancelled. ${reason}`);
}

// Executes one slice of an order at `price`. Throws (and the caller rolls back) on insufficient funds or shares.
async function fillSlice(db, o, price, now, qty, patch, { fee = 0, mid = null, slippage = 0 } = {}) {
  const uid = o.user_id;
  const cost = r2(price * qty);
  const charge = o.side === 'buy' ? fee : Math.min(fee, cost); // a sale never costs more in fees than it brings in
  const total = r2(o.side === 'buy' ? cost + charge : cost - charge);
  if (o.side === 'buy') {
    const { balance } = await db.prepare('SELECT balance FROM users WHERE id = ?').get(uid);
    if (balance < total) throw new Error('Insufficient funds');
    if ((await lossState(db, uid, now)).reached) throw new Error('Daily demo-loss limit reached');
    await db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(total, uid);
    const h = await db.prepare('SELECT * FROM holdings WHERE user_id = ? AND symbol = ?').get(uid, o.symbol);
    if (h) {
      const q = h.quantity + qty;
      await db.prepare('UPDATE holdings SET quantity = ?, avg_cost = ? WHERE user_id = ? AND symbol = ?')
        .run(q, (h.avg_cost * h.quantity + price * qty + charge) / q, uid, o.symbol); // the fee counts towards the cost basis
    } else {
      await db.prepare('INSERT INTO holdings VALUES (?, ?, ?, ?)').run(uid, o.symbol, qty, charge ? (price * qty + charge) / qty : price);
    }
  } else {
    const h = await db.prepare('SELECT * FROM holdings WHERE user_id = ? AND symbol = ?').get(uid, o.symbol);
    if (!h || h.quantity < qty - EPS) throw new Error('Insufficient holdings');
    const left = h.quantity - qty;
    if (left < EPS) await db.prepare('DELETE FROM holdings WHERE user_id = ? AND symbol = ?').run(uid, o.symbol);
    else await db.prepare('UPDATE holdings SET quantity = ? WHERE user_id = ? AND symbol = ?').run(left, uid, o.symbol);
    await db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(total, uid);
  }
  const at = sqlTime(now);
  const fillId = (await db.prepare('INSERT INTO fills (order_id, user_id, symbol, side, quantity, price, filled_at, fee, mid, slippage_bps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(o.id, uid, o.symbol, o.side, qty, price, at, charge, mid, slippage)).lastInsertRowid;
  await db.prepare('INSERT INTO transactions (user_id, type, symbol, amount, note, order_id, fill_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uid, o.side, o.symbol, o.side === 'buy' ? -total : total, `${qty} ${o.symbol} @ ${price}${charge ? `, fee ${charge}` : ''}`, o.id, fillId);

  const filled = o.filled_quantity + qty;
  const done = o.quantity - filled < EPS;
  const avg = ((o.fill_price ?? 0) * o.filled_quantity + price * qty) / filled;
  await persist(db, o.id, {
    ...patch, filled_quantity: done ? o.quantity : filled, fill_price: r6(avg), filled_at: at,
    status: done ? 'filled' : 'partially_filled', last_slot: liquiditySlot(now),
  });
  if (done) await notify(db, uid, 'order', `Your ${LABELS[o.type].toLowerCase()} ${o.side} order for ${o.quantity} ${o.symbol} filled at an average ${r6(avg)}.`);
  else if (o.filled_quantity === 0) await notify(db, uid, 'order', `Your ${LABELS[o.type].toLowerCase()} ${o.side} order for ${o.quantity} ${o.symbol} is partially filled (${r6(filled)} so far); the rest fills as liquidity allows.`);
  if (o.filled_quantity === 0) await cancelSiblings(db, o, 'The other leg filled.');
}

async function reject(db, o, reason) {
  await atomic(db, async () => {
    await db.prepare("UPDATE orders SET status = 'rejected', note = ? WHERE id = ?").run(reason, o.id);
    await cancelSiblings(db, o, `This leg was rejected: ${reason}.`);
  });
  await notify(db, o.user_id, 'order', `Order #${o.id} (${o.symbol}) rejected: ${reason}.`);
}

export async function processOrder(db, id, now = Date.now()) {
  const o = await db.prepare(`SELECT * FROM orders WHERE id = ? AND ${WORKING}`).get(id);
  if (!o) return;
  const asset = getAsset(o.symbol);
  // Orders wait, untouched, while the account is suspended or the asset is paused or disabled.
  if ((asset.status ?? 'active') !== 'active' || (await db.prepare('SELECT suspended_at FROM users WHERE id = ?').get(o.user_id))?.suspended_at) return;
  if (o.execute_after !== null && now < o.execute_after) return; // still on its way to the market
  if (getSimulation().marketHours && !isOpen(asset.session, now)) return; // queued until the market opens

  const mid = priceAt(asset, now);
  const { bid, ask } = bidAsk(asset, mid);
  const buy = o.side === 'buy';
  const quoted = buy ? ask : bid; // triggers and fills are judged on the side of the book this order trades against
  const { ready, patch } = evaluate(o, quoted);
  const slot = liquiditySlot(now);
  if (!ready || o.last_slot === slot) { await persist(db, o.id, patch); return; }

  const liquidity = liquidityAt(asset, slot);
  const qty = Math.min(remaining(o), floorToStep(liquidity, quantityRules(asset).step));
  const slip = MARKET_STYLE.has(o.type) ? slippageBps(asset, { orderId: o.id, slot, qty, liquidity }) : 0;
  let price = slip ? r6(quoted * (1 + (buy ? slip : -slip) / 1e4)) : quoted;
  // A limit is a promise: never pay more (or receive less) than the limit price.
  const limit = o.type === 'limit' ? o.price : o.type === 'stop_limit' ? o.limit_price : null;
  if (limit !== null) price = buy ? Math.min(price, limit) : Math.max(price, limit);
  const fee = feeFor(asset, r2(price * qty));
  try {
    await atomic(db, async () => await fillSlice(db, o, price, now, qty, patch, { fee, mid, slippage: slip }));
    await evaluateAchievements(db, o.user_id, now);
  } catch (e) {
    await reject(db, o, e.message);
  }
}

export async function expireOrders(db, now = Date.now()) {
  const due = await db.prepare(`SELECT * FROM orders WHERE ${WORKING} AND expires_at IS NOT NULL AND expires_at <= ?`).all(now);
  for (const o of due) {
    await db.prepare("UPDATE orders SET status = 'expired', note = 'Day order expired' WHERE id = ?").run(o.id);
    await notify(db, o.user_id, 'order', `Your day order #${o.id} for ${o.quantity} ${o.symbol} expired with ${r6(o.filled_quantity)} filled.`);
  }
}

export async function matchPending(db, now = Date.now()) {
  await expireOrders(db, now);
  await checkAlerts(db);
  for (const { id } of await db.prepare(`SELECT id FROM orders WHERE ${WORKING} ORDER BY id`).all()) await processOrder(db, id, now);
}

// Trigger active alerts whose target has been crossed; each fires once.
export async function checkAlerts(db) {
  const active = await db.prepare("SELECT * FROM price_alerts WHERE status = 'active'").all();
  for (const a of active) {
    const p = priceAt(getAsset(a.symbol));
    if (a.direction === 'above' ? p < a.target : p > a.target) continue;
    await db.prepare("UPDATE price_alerts SET status = 'triggered', triggered_at = CURRENT_TIMESTAMP WHERE id = ?").run(a.id);
    await notify(db, a.user_id, 'price', `${a.symbol} is now ${p}, ${a.direction} your alert at ${a.target}.`);
  }
}

// ---------------------------------------------------------------- order detail

const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });
// Notes are stored without a full stop; make them read as sentences.
const sentence = (text, fallback) => { const t = (text || fallback).trim(); return /[.!?]$/.test(t) ? t : `${t}.`; };
const away = (price, target) => `${(Math.abs(price - target) / price * 100).toFixed(2)}%`;

// A plain-language account of what an order is doing right now, or how it ended.
export function explainOrder(o, price, now = Date.now()) {
  const left = remaining(o);
  const asset = getAsset(o.symbol);
  const sym = o.symbol;
  switch (o.status) {
    case 'filled': return `Filled completely: ${fmt(o.quantity)} ${sym} at an average ${fmt(o.fill_price)}.`;
    case 'cancelled': return `${sentence(o.note, 'Cancelled')} ${o.filled_quantity > 0 ? `${fmt(o.filled_quantity)} ${sym} had already filled and stays in your portfolio.` : 'Nothing was filled.'}`.trim();
    case 'expired': return `This day order expired at the end of the UTC day with ${fmt(o.filled_quantity)} of ${fmt(o.quantity)} ${sym} filled.`;
    case 'rejected': return `Rejected: ${sentence(o.note, 'the order could not be completed')} ${o.filled_quantity > 0 ? `${fmt(o.filled_quantity)} ${sym} had filled before this.` : 'Nothing was filled.'}`;
    default: break;
  }
  const buy = o.side === 'buy';
  const verb = buy ? 'buy' : 'sell';
  const now$ = `The price is now ${fmt(price)}`;
  // Part-filled, or a market order waiting for liquidity.
  const liq = liquidityAt(asset, liquiditySlot(now));
  const sliceNote = `Up to about ${fmt(Number(liq.toPrecision(3)))} ${sym} can fill every 5 seconds, so about ${Math.ceil(left / liq)} more ${Math.ceil(left / liq) === 1 ? 'slice' : 'slices'} to go.`;
  if (o.execute_after !== null && now < o.execute_after) {
    return `Sent to the simulated market and still on its way (a simulated execution delay). It should execute in about ${Math.max(1, Math.ceil((o.execute_after - now) / 1000))} second(s).`;
  }
  if (getSimulation().marketHours && !isOpen(asset.session, now)) {
    return `The ${sym} market is closed, so this order is queued. It will be tried when the market opens (${new Date(nextOpen(asset.session, now)).toISOString().replace('T', ' ').slice(0, 16)} UTC), at the opening price, which can gap away from the last close.`;
  }
  if (o.type === 'market') return `Filling as simulated liquidity allows. ${fmt(left)} ${sym} still to ${verb}. ${sliceNote}`;
  const triggeredNote = o.filled_quantity > 0 ? ` ${fmt(o.filled_quantity)} ${sym} has filled so far. ${sliceNote}` : '';
  switch (o.type) {
    case 'limit': return `Waiting for the price to ${buy ? 'fall to' : 'rise to'} ${fmt(o.price)} or ${buy ? 'lower' : 'higher'}. ${now$}, ${away(price, o.price)} ${price > o.price ? 'above' : 'below'} your limit.${triggeredNote}`;
    case 'take_profit': return `Will sell once the price rises to ${fmt(o.price)}. ${now$}, ${away(price, o.price)} below your target.${triggeredNote}`;
    case 'stop': case 'stop_loss':
      return o.triggered
        ? `The stop at ${fmt(o.price)} was reached, so this is now working as a market order.${triggeredNote}`
        : `Will ${verb} at market once the price ${buy ? 'rises to' : 'falls to'} ${fmt(o.price)}. ${now$}, ${away(price, o.price)} ${price > o.price ? 'above' : 'below'} the stop.`;
    case 'stop_limit':
      return o.triggered
        ? `The stop at ${fmt(o.price)} was reached. Now waiting to ${verb} at ${fmt(o.limit_price)} or ${buy ? 'lower' : 'better'}. ${now$}.${triggeredNote}`
        : `Waiting for the price to ${buy ? 'rise to' : 'fall to'} the stop at ${fmt(o.price)}, then it will ${verb} at ${fmt(o.limit_price)} or ${buy ? 'lower' : 'better'}. ${now$}, ${away(price, o.price)} ${price > o.price ? 'above' : 'below'} the stop.`;
    case 'trailing_stop': {
      const trail = o.trail_mode === 'percent' ? `${fmt(o.trail_value)}%` : fmt(o.trail_value);
      return o.triggered
        ? `The trailing stop was reached and is now selling at market.${triggeredNote}`
        : `The stop trails ${trail} below the highest price seen (${fmt(o.peak_price)}), so it is at ${fmt(o.price)} and moves up if the price makes new highs. Sells if the price falls to it. ${now$}, ${away(price, o.price)} above the stop.`;
    }
    default: return '';
  }
}

// Everything the order detail screen shows: the order, each fill, the totals, linked OCO legs and live state.
export async function getOrderDetail(db, userId, id, now = Date.now()) {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, userId);
  if (!order) return null;
  const rows = await db.prepare('SELECT * FROM fills WHERE order_id = ? ORDER BY filled_at, id').all(order.id);
  const fills = rows.map((f) => ({
    id: f.id, quantity: f.quantity, price: f.price, amount: r2(f.quantity * f.price), fee: f.fee, mid: f.mid, slippageBps: f.slippage_bps,
    filledAt: new Date(`${f.filled_at.replace(' ', 'T')}Z`).toISOString(),
  }));
  const filled = fills.reduce((s, f) => s + f.quantity, 0);
  const value = rows.reduce((s, f) => s + f.quantity * f.price, 0);
  const working = ['pending', 'partially_filled'].includes(order.status);
  const price = priceAt(getAsset(order.symbol), now);
  const asset = getAsset(order.symbol);
  const left = remaining(order);
  const linked = order.oco_group === null ? [] : await db.prepare(
    'SELECT id, type, side, status, price, limit_price, note FROM orders WHERE oco_group = ? AND id != ? ORDER BY id',
  ).all(order.oco_group, order.id);
  return {
    order, fills, linked,
    summary: {
      quantity: order.quantity, filled: r6(filled), remaining: r6(left),
      progressPct: r6(Math.min(filled / order.quantity, 1) * 100),
      avgFillPrice: filled > 0 ? r6(value / filled) : null, totalValue: r2(value), totalFees: r2(rows.reduce((t, f) => t + f.fee, 0)), working, mode: 'demo',
      notice: PAPER_TRADING_NOTICE,
    },
    live: working ? {
      price,
      slicesRemaining: Math.ceil(left / liquidityAt(asset, liquiditySlot(now))),
      executesAt: order.execute_after !== null && order.execute_after > now ? new Date(order.execute_after).toISOString() : null,
      marketOpen: !getSimulation().marketHours || isOpen(asset.session, now),
      nextFillAt: new Date(order.last_slot === liquiditySlot(now) ? (liquiditySlot(now) + 1) * LIQUIDITY_SLOT_MS : now).toISOString(),
    } : null,
    explanation: explainOrder(order, price, now),
  };
}
