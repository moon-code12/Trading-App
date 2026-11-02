// How realistic the simulated market is. A profile is plain data: per-category spreads, fees, slippage, execution
// latency, price gaps and quantity rules, plus switches for market hours and gaps.
//
//   ideal      zero spread, fees, slippage and delay; every market always open; any quantity. This is how the
//              app behaved before the realism work, and it is what automated tests use unless they ask otherwise.
//   realistic  everything on. This is what the server uses by default.
//
// Nothing here is random. Every "random-looking" number (slippage jitter, latency, liquidity swings, gaps) is a hash of
// the profile seed and the thing it belongs to (symbol, order id, time slot), so the same inputs always give the same
// result and tests can assert exact values. Change `seed` to get a different but equally repeatable market.

export const PAPER_TRADING_NOTICE = 'Paper trading is a simulation. Real markets have live order books, different spreads, fees, slippage, '
  + 'delays, liquidity and outages, and your emotions and risk are different when real money is at stake, so real results can differ '
  + 'from these results, often for the worse. Prices, spreads, fees and fills here are simplified models, not an offer or a prediction.';

const NO_RULES = { min: 1e-6, step: 0, max: 1e12, label: 'any quantity of at least 0.000001' };

const ZERO = { spreadBps: 0, feeBps: 0, minFee: 0, impactBps: 0, jitterBps: 0, latencyMs: [0, 0], gapBps: 0, qty: NO_RULES };

export const IDEAL = Object.freeze({
  name: 'ideal', seed: 0, marketHours: false, gaps: false, liquidityVariance: 0,
  riskFactor: { low: 1, medium: 1, high: 1 },
  categories: {},
  fallback: ZERO,
});

export const REALISTIC = Object.freeze({
  name: 'realistic', seed: 1, marketHours: true, gaps: true, liquidityVariance: 0.3,
  // Riskier assets trade with wider spreads and more slippage.
  riskFactor: { low: 0.8, medium: 1, high: 1.5 },
  categories: {
    crypto: {
      spreadBps: 10, feeBps: 10, minFee: 0.01, impactBps: 4, jitterBps: 3, latencyMs: [300, 1200], gapBps: 0,
      qty: { min: 0.00001, step: 0.00001, max: 1000, label: 'from 0.00001 coins in steps of 0.00001' },
    },
    stocks: {
      spreadBps: 4, feeBps: 3, minFee: 0.01, impactBps: 2, jitterBps: 2, latencyMs: [500, 1800], gapBps: 80,
      qty: { min: 1, step: 1, max: 10000, label: 'whole shares only' },
    },
    forex: {
      spreadBps: 1.5, feeBps: 0, minFee: 0, impactBps: 0.5, jitterBps: 0.5, latencyMs: [200, 800], gapBps: 15,
      qty: { min: 1000, step: 1000, max: 1000000, label: 'units in lots of 1,000' },
    },
    commodities: {
      spreadBps: 6, feeBps: 5, minFee: 0.01, impactBps: 3, jitterBps: 2, latencyMs: [500, 2000], gapBps: 50,
      qty: { min: 0.01, step: 0.01, max: 1000, label: 'from 0.01 in steps of 0.01' },
    },
  },
  // Categories an administrator invents later.
  fallback: { spreadBps: 8, feeBps: 5, minFee: 0.01, impactBps: 3, jitterBps: 2, latencyMs: [400, 1500], gapBps: 40, qty: NO_RULES },
});

export const PROFILES = { ideal: IDEAL, realistic: REALISTIC };

let active = IDEAL;

// Accepts a profile name or a (partial) profile object; anything missing comes from the realistic profile.
export function resolveProfile(spec) {
  if (spec === undefined || spec === null) return IDEAL;
  if (typeof spec === 'string') {
    if (!PROFILES[spec]) throw new Error(`Unknown simulation profile "${spec}" (known: ${Object.keys(PROFILES).join(', ')})`);
    return PROFILES[spec];
  }
  return { ...REALISTIC, ...spec, riskFactor: { ...REALISTIC.riskFactor, ...spec.riskFactor }, categories: spec.categories ?? REALISTIC.categories };
}

export function configureSimulation(spec) {
  active = resolveProfile(spec);
  return active;
}
export const getSimulation = () => active;

// ---- Deterministic numbers

// A repeatable number in [0, 1) for any combination of values (FNV-1a over the text).
export function hash01(seed, ...parts) {
  let h = 2166136261 ^ (seed | 0);
  for (const ch of `${parts.join('|')}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489917); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export const hashSigned = (seed, ...parts) => hash01(seed, ...parts) * 2 - 1;

// ---- Per-asset parameters

const round6 = (n) => Math.round(n * 1e6) / 1e6;

export function paramsFor(asset, sim = active) {
  const c = sim.categories[asset.category] ?? sim.fallback;
  const risk = sim.riskFactor[asset.risk] ?? 1;
  return { ...c, risk, spreadBps: (asset.spreadBps ?? c.spreadBps * risk), qty: { ...c.qty, ...asset.quantityRules } };
}

// What an administrator-set spread replaces: the category default, scaled by the asset's risk.
export const defaultSpreadBps = (asset, sim = active) => (sim.categories[asset.category] ?? sim.fallback).spreadBps * (sim.riskFactor[asset.risk] ?? 1);

// Bid (what you can sell at) and ask (what you must pay) around the mid price.
export function bidAsk(asset, mid, sim = active) {
  const { spreadBps } = paramsFor(asset, sim);
  if (!spreadBps) return { bid: mid, ask: mid, spreadBps: 0 };
  const half = (mid * spreadBps) / 2e4;
  return { bid: round6(mid - half), ask: round6(mid + half), spreadBps };
}

// Trading fee for a fill of this value: a percentage with a minimum, or nothing when the category charges none.
export function feeFor(asset, notional, sim = active) {
  const { feeBps, minFee } = paramsFor(asset, sim);
  if (!feeBps) return 0;
  return Math.max(minFee, Math.round((notional * feeBps) / 1e4 * 100) / 100);
}

// Worst-case slippage in basis points (a full-liquidity slice with the worst jitter).
export function maxSlippageBps(asset, sim = active) {
  const { impactBps, jitterBps, risk } = paramsFor(asset, sim);
  return (impactBps + jitterBps) * risk;
}

// Slippage in basis points for one slice: bigger slices (relative to available liquidity) move the price more,
// plus a small repeatable jitter. Always against the trader.
export function slippageBps(asset, { orderId, slot, qty, liquidity }, sim = active) {
  const { impactBps, jitterBps, risk } = paramsFor(asset, sim);
  if (!impactBps && !jitterBps) return 0;
  const size = liquidity > 0 ? Math.min(qty / liquidity, 1) : 1;
  return Math.round((impactBps * size + jitterBps * hash01(sim.seed, 'slip', orderId, slot)) * risk * 1e4) / 1e4;
}

// How long an order takes to reach the market, in milliseconds (0 when there is no delay).
export function latencyMs(asset, orderId, sim = active) {
  const [lo, hi] = paramsFor(asset, sim).latencyMs;
  return hi <= 0 ? 0 : Math.round(lo + (hi - lo) * hash01(sim.seed, 'latency', orderId));
}

// Quantity that can be filled in one 5-second slot: the asset's liquidity, swinging up and down deterministically.
export function liquidityAt(asset, slot, sim = active) {
  if (!sim.liquidityVariance) return asset.liquidity;
  return asset.liquidity * (1 + sim.liquidityVariance * hashSigned(sim.seed, 'liq', asset.symbol, slot));
}

// The size of one price gap at the start of a trading session, as a fraction (positive or negative).
export function gapFraction(asset, sessionStartMs, sim = active) {
  if (!sim.gaps) return 0;
  const { gapBps, risk } = paramsFor(asset, sim);
  return (gapBps / 1e4) * risk * hashSigned(sim.seed, 'gap', asset.symbol, Math.floor(sessionStartMs / 60000));
}

// ---- Quantity rules

export const quantityRules = (asset, sim = active) => paramsFor(asset, sim).qty;

// A readable complaint about the quantity, or null if it is allowed.
export function checkQuantity(asset, qty, sim = active) {
  const r = paramsFor(asset, sim).qty;
  const name = asset.symbol;
  if (qty < r.min - 1e-12) return `The minimum order for ${name} is ${r.min}`;
  if (qty > r.max + 1e-12) return `The maximum order for ${name} is ${r.max}`;
  if (r.step) {
    const steps = qty / r.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) return `${name} trades ${r.label}: quantity must be a multiple of ${r.step}`;
  }
  return null;
}

// Rounds a quantity down to the allowed step (never below one step when the step is set).
export function floorToStep(qty, step) {
  if (!step) return qty;
  return Math.max(step, Math.floor(qty / step + 1e-9) * step);
}

// A summary safe to send to browsers: what the current profile does, per category.
export function describeProfile(sim = active) {
  const c = (p) => ({ spreadBps: p.spreadBps, feeBps: p.feeBps, minFee: p.minFee, slippageBps: [0, p.impactBps + p.jitterBps], latencyMs: p.latencyMs, gapBps: p.gapBps, quantity: p.qty.label });
  return {
    name: sim.name, marketHours: sim.marketHours, gaps: sim.gaps, notice: PAPER_TRADING_NOTICE,
    categories: Object.fromEntries(Object.entries(sim.categories).map(([k, v]) => [k, c(v)])),
  };
}
