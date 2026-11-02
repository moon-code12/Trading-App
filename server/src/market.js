// Simulated market: deterministic price curves, no external feed.
// Assets come from catalog.js; add new ones there or with addAsset().
import { ASSET_DEFINITIONS, validateAsset } from './catalog.js';
import { marketStatus, sessionState } from './sessions.js';
import { bidAsk, gapFraction, getSimulation, quantityRules } from './simulation.js';

export const ASSETS = [];
export function addAsset(def) {
  ASSETS.push(validateAsset(def, ASSETS));
  return def;
}
ASSET_DEFINITIONS.forEach(addAsset);

const seed = (s) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0);
const round = (n) => Math.round(n * 1e6) / 1e6;

// Deterministic pseudo-random value in [-1, 1] for an integer slot.
const hash = (k, slot) => {
  const x = Math.sin(slot * 12.9898 + k * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
};
// Smooth value noise: interpolates between hashed values every `ms`.
const noise = (k, t, ms) => {
  const slot = Math.floor(t / ms);
  const f = t / ms - slot;
  const e = f * f * (3 - 2 * f);
  return hash(k, slot) * (1 - e) + hash(k, slot + 1) * e;
};
// Non-repeating price movement: several noise scales (6h, 1h, 10m, 1m, 15s).
const SCALES = [[6 * 3600e3, 0.05], [3600e3, 0.02], [600e3, 0.008], [60e3, 0.003], [15e3, 0.0012]];

// The underlying continuous price curve, ignoring market hours and gaps. This is the "mid" price of a market that never sleeps.
function rawPrice(asset, t) {
  const k = seed(asset.symbol);
  const v = 1 + SCALES.reduce((sum, [ms, amp], i) => sum + amp * noise(k * 31 + i * 101, t, ms), 0);
  return round(asset.base * v);
}

// The mid price at a moment. With the ideal profile this is just the continuous curve. With market hours on,
// a closed market shows its closing price (frozen), and every trading session starts with its own repeatable gap, so
// the price jumps between one close and the next open.
export function priceAt(asset, t = Date.now()) {
  const sim = getSimulation();
  if ((!sim.marketHours && !sim.gaps) || asset.session === 'always') return rawPrice(asset, t);
  const st = sessionState(asset.session, t);
  const at = !st.open && sim.marketHours ? st.end : t;
  const gap = gapFraction(asset, st.start, sim);
  return gap ? round(rawPrice(asset, at) * (1 + gap)) : rawPrice(asset, at);
}

export const LIQUIDITY_SLOT_MS = 5000;
export const liquiditySlot = (t = Date.now()) => Math.floor(t / LIQUIDITY_SLOT_MS);

export const getAsset = (symbol) => ASSETS.find((a) => a.symbol === symbol);

export function quote(asset, t = Date.now()) {
  const price = priceAt(asset, t);
  const prev = priceAt(asset, t - 24 * 3600 * 1000);
  const { base, volume, session, ...rest } = asset; // liquidity and risk stay in the quote for the order ticket
  const { bid, ask, spreadBps } = bidAsk(asset, price);
  return { ...rest, price, bid, ask, spreadBps, quantityRules: quantityRules(asset), change24h: round(((price - prev) / prev) * 100) };
}

export function history(asset, points = 60, stepMs = 60 * 60 * 1000, t = Date.now()) {
  return Array.from({ length: points }, (_, i) => {
    const ts = t - (points - 1 - i) * stepMs;
    return { t: ts, price: priceAt(asset, ts) };
  });
}

export const TIMEFRAMES = {
  '1H': { bucketMs: 60 * 1000, count: 60 },
  '1D': { bucketMs: 15 * 60 * 1000, count: 96 },
  '1W': { bucketMs: 3600 * 1000, count: 168 },
  '1M': { bucketMs: 6 * 3600 * 1000, count: 120 },
  '3M': { bucketMs: 24 * 3600 * 1000, count: 90 },
};

// ---- Simulated traded volume
// One model feeds the candles, the 24h figure and the chart's volume bars, so they always agree:
// volume is generated per minute (the catalogue's daily volume spread over 1,440 minutes, with a slow swing
// and minute-to-minute jitter) and anything longer is the sum of its minutes.

const MINUTE = 60 * 1000;
const minuteVolume = (asset, i) => {
  const k = seed(asset.symbol);
  return (asset.volume / 1440) * (1 + 0.3 * noise(k * 7 + 3, i * MINUTE, 3 * 3600e3)) * (1 + 0.2 * hash(k * 29 + 5, i));
};

// Units traded between two moments; partial minutes count in proportion.
export function volumeBetween(asset, from, to) {
  if (!(to > from)) return 0;
  let sum = 0;
  for (let i = Math.floor(from / MINUTE); i <= Math.ceil(to / MINUTE) - 1; i++) {
    sum += (minuteVolume(asset, i) * (Math.min(to, (i + 1) * MINUTE) - Math.max(from, i * MINUTE))) / MINUTE;
  }
  return sum;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

// A finished candle's volume never changes, so it is remembered (the chart asks for the same ones every few seconds).
const closedVolumes = new Map();
const candleVolume = (asset, bucketMs, start, end) => {
  if (end < start + bucketMs) return round3(volumeBetween(asset, start, end)); // still forming
  const key = `${asset.symbol}:${bucketMs}:${start}`;
  if (!closedVolumes.has(key)) {
    if (closedVolumes.size > 20000) closedVolumes.clear();
    closedVolumes.set(key, round3(volumeBetween(asset, start, end)));
  }
  return closedVolumes.get(key);
};

// OHLC candles aligned to bucket boundaries, with simulated volume; the last candle is still forming.
export function candles(asset, tf = '1D', now = Date.now()) {
  const { bucketMs, count } = TIMEFRAMES[tf];
  const lastStart = Math.floor(now / bucketMs) * bucketMs;
  return Array.from({ length: count }, (_, i) => {
    const start = lastStart - (count - 1 - i) * bucketMs;
    const end = Math.min(start + bucketMs, now);
    const samples = Array.from({ length: 12 }, (_, j) => priceAt(asset, start + ((end - start) * j) / 11));
    return {
      t: start,
      open: samples[0], close: samples[samples.length - 1],
      high: Math.max(...samples), low: Math.min(...samples),
      volume: candleVolume(asset, bucketMs, start, end),
    };
  });
}

// Closing prices for `extra` candles before the visible window plus the window itself, oldest first.
// Each close is exactly the close candles() reports for the same candle.
export function candleCloses(asset, tf = '1D', now = Date.now(), extra = 0) {
  const { bucketMs, count } = TIMEFRAMES[tf];
  const lastStart = Math.floor(now / bucketMs) * bucketMs;
  const total = count + extra;
  return Array.from({ length: total }, (_, i) => priceAt(asset, Math.min(lastStart - (total - 1 - i) * bucketMs + bucketMs, now)));
}

// ---- Market discovery: 24h statistics, search and comparison

const DAY = 24 * 3600 * 1000;
const STAT_STEP = 5 * 60 * 1000;

// Simulated 24h traded volume: everything traded in the 24 hours to `t`, from the minute model above.
export const volume24h = (asset, t = Date.now()) => Math.round(volumeBetween(asset, t - DAY, t));

// Open, high, low and volume over the 24 hours to `t`, sampled every 5 minutes (the current price is always a sample).
export function stats24h(asset, t = Date.now()) {
  const samples = [];
  for (let at = t - DAY; at < t; at += STAT_STEP) samples.push(priceAt(asset, at));
  const price = priceAt(asset, t);
  samples.push(price);
  const open = samples[0];
  const volume = volume24h(asset, t);
  return {
    open24h: open,
    high24h: Math.max(...samples),
    low24h: Math.min(...samples),
    change24h: round(((price - open) / open) * 100),
    volume24h: volume,
    volumeUsd24h: Math.round(volume * price),
  };
}

// Everything the markets screens need about one asset.
export function snapshot(asset, t = Date.now()) {
  return { ...quote(asset, t), ...stats24h(asset, t), market: marketStatus(asset.session, t) };
}

// Top gainers and losers by 24h change (only assets that actually rose or fell) and the most active by traded value.
export function discover(rows, limit = 3) {
  const top = (list) => list.slice(0, limit);
  return {
    gainers: top(rows.filter((x) => x.change24h > 0).sort((x, y) => y.change24h - x.change24h)),
    losers: top(rows.filter((x) => x.change24h < 0).sort((x, y) => x.change24h - y.change24h)),
    active: top([...rows].sort((x, y) => y.volumeUsd24h - x.volumeUsd24h)),
  };
}

// Disabled assets are hidden from every listing (they can still be looked up by symbol, for existing holdings).
export const listedAssets = () => ASSETS.filter((a) => a.status !== 'disabled');
export const categories = () => [...new Set(listedAssets().map((a) => a.category))];

// Case-insensitive search by symbol or name, optionally limited to a category.
export function searchAssets({ q = '', category } = {}) {
  const needle = String(q).trim().toLowerCase();
  return listedAssets().filter((a) => (!category || a.category === category)
    && (!needle || a.symbol.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle)));
}

export const COMPARE_RANGES = { '1D': DAY, '1W': 7 * DAY, '1M': 30 * DAY };

// Two assets over one range, both rebased to 100 at the start so different price scales can be compared.
export function compareSeries(a, b, range = '1D', t = Date.now(), points = 96) {
  const span = COMPARE_RANGES[range];
  const times = Array.from({ length: points }, (_, i) => t - span + (span * i) / (points - 1));
  const rebased = (asset) => {
    const prices = times.map((x) => priceAt(asset, x));
    return times.map((x, i) => ({ t: Math.round(x), value: round((prices[i] / prices[0]) * 100) }));
  };
  const sa = rebased(a);
  const sb = rebased(b);
  const last = (s) => s[s.length - 1].value;
  return {
    range, series: { [a.symbol]: sa, [b.symbol]: sb },
    returnPct: { [a.symbol]: round(last(sa) - 100), [b.symbol]: round(last(sb) - 100) },
  };
}
