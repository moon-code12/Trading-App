// Chart drawings (horizontal lines, trend lines, Fibonacci retracements, measurements).
// Points are anchored to a time and a price, not to pixels, so a drawing stays put as the chart updates or resizes.
// They are remembered in the browser per symbol and timeframe.

export const DRAWING_STORAGE_KEY = 'tradeapp.chartDrawings.v1';
export const TOOLS = [
  { key: 'select', label: 'Select', points: 0 },
  { key: 'hline', label: 'Level', points: 1 },
  { key: 'trend', label: 'Trend line', points: 2 },
  { key: 'fib', label: 'Fib', points: 2 },
  { key: 'measure', label: 'Measure', points: 2 },
  { key: 'rect', label: 'Rectangle', points: 2 },
  { key: 'note', label: 'Note', points: 1 },
  { key: 'alert', label: 'Price alert', points: 1 },
];
export const NOTE_MAX = 80;
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
export const DRAW_COLORS = ['#38bdf8', '#facc15', '#c084fc', '#fb923c', '#f8fafc'];
const MAX_PER_CHART = 40;

const defaultStorage = () => { try { return globalThis.localStorage; } catch { return undefined; } };
const isPoint = (p) => p && Number.isFinite(p.t) && Number.isFinite(p.price);

export function sanitizeDrawings(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((d) => d && typeof d.id === 'string' && TOOLS.some((t) => t.key === d.type && t.points > 0) && Array.isArray(d.points))
    .map((d) => ({
      id: d.id,
      type: d.type,
      color: DRAW_COLORS.includes(d.color) ? d.color : DRAW_COLORS[0],
      points: d.points.filter(isPoint).map((p) => ({ t: p.t, price: p.price })),
      ...(d.type === 'note' ? { text: typeof d.text === 'string' ? d.text.slice(0, NOTE_MAX) : 'Note' } : {}),
      ...(d.type === 'alert' ? { side: d.side === 'below' ? 'below' : 'above' } : {}),
    }))
    .filter((d) => d.points.length === TOOLS.find((t) => t.key === d.type).points)
    .slice(0, MAX_PER_CHART);
}

const keyFor = (symbol, tf) => `${symbol}:${tf}`;

export function loadDrawings(symbol, tf, storage = defaultStorage()) {
  try {
    const all = JSON.parse(storage?.getItem(DRAWING_STORAGE_KEY) ?? '{}');
    return sanitizeDrawings(all?.[keyFor(symbol, tf)]);
  } catch {
    return [];
  }
}

export function saveDrawings(symbol, tf, drawings, storage = defaultStorage()) {
  try {
    let all = {};
    try { all = JSON.parse(storage.getItem(DRAWING_STORAGE_KEY) ?? '{}') || {}; } catch { /* start fresh */ }
    all[keyFor(symbol, tf)] = sanitizeDrawings(drawings);
    storage.setItem(DRAWING_STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export const newId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// A (possibly fractional) candle position for a time. Times beyond the loaded candles are extrapolated.
export function indexAtTime(candles, t) {
  const n = candles.length;
  if (n === 0) return 0;
  if (n === 1) return 0;
  if (t <= candles[0].t) return (t - candles[0].t) / (candles[1].t - candles[0].t);
  if (t >= candles[n - 1].t) return n - 1 + (t - candles[n - 1].t) / (candles[n - 1].t - candles[n - 2].t);
  let lo = 0; let hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (candles[mid].t <= t) lo = mid; else hi = mid; }
  return lo + (t - candles[lo].t) / (candles[hi].t - candles[lo].t);
}

// The time at a (possibly fractional) candle position; the inverse of indexAtTime.
export function timeAtIndex(candles, i) {
  const n = candles.length;
  if (n === 0) return 0;
  if (n === 1) return candles[0].t;
  if (i <= 0) return candles[0].t + i * (candles[1].t - candles[0].t);
  if (i >= n - 1) return candles[n - 1].t + (i - (n - 1)) * (candles[n - 1].t - candles[n - 2].t);
  const lo = Math.floor(i);
  return candles[lo].t + (i - lo) * (candles[lo + 1].t - candles[lo].t);
}

// Distance in pixels from a point to a segment.
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const u = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

// An alert watches for the price to reach its level from the side it was set on.
export const alertHit = (d, price) => (d.side === 'below' ? price <= d.points[0].price : price >= d.points[0].price);

// Summary of a measurement between two points.
export function measure(a, b, candles) {
  const delta = b.price - a.price;
  return {
    delta,
    pct: a.price ? (delta / a.price) * 100 : 0,
    bars: Math.round(indexAtTime(candles, b.t) - indexAtTime(candles, a.t)),
  };
}
