// Chart analysis: summary statistics, trend, support / resistance and indicator signals.
// Pure functions over the candles (and optional indicator series) so they are easy to test.

const last = (a) => a[a.length - 1];
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Least-squares trend of the closes. `slope` is the average % move per candle, `r2` how straight the line is (0 to 1).
export function trendOf(closes) {
  const n = closes.length;
  if (n < 3) return { direction: 'Sideways', slope: 0, r2: 0 };
  const xm = (n - 1) / 2;
  const ym = closes.reduce((s, v) => s + v, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  closes.forEach((v, i) => { sxy += (i - xm) * (v - ym); sxx += (i - xm) ** 2; syy += (v - ym) ** 2; });
  const slope = sxy / sxx;
  const r2 = syy ? (sxy * sxy) / (sxx * syy) : 0;
  const pct = (slope / ym) * 100;
  const direction = r2 < 0.25 || Math.abs(pct) < 0.01 ? 'Sideways' : pct > 0 ? 'Uptrend' : 'Downtrend';
  return { direction, slope: pct, r2 };
}

// Price levels where the market turned several times: local highs / lows grouped within `tolerance` of each other.
export function findLevels(candles, { window = 3, tolerance = 0.004, max = 3 } = {}) {
  const found = [];
  for (let i = window; i < candles.length - window; i++) {
    const slice = candles.slice(i - window, i + window + 1);
    if (candles[i].high === Math.max(...slice.map((c) => c.high))) found.push(candles[i].high);
    if (candles[i].low === Math.min(...slice.map((c) => c.low))) found.push(candles[i].low);
  }
  const groups = [];
  for (const p of found.sort((a, b) => a - b)) {
    const g = groups.find((x) => Math.abs(x.price - p) / p <= tolerance);
    if (g) { g.price = (g.price * g.touches + p) / (g.touches + 1); g.touches += 1; } else groups.push({ price: p, touches: 1 });
  }
  const price = candles.length ? last(candles).close : 0;
  const strong = groups.filter((g) => g.touches >= 2);
  const pool = strong.length ? strong : groups;
  const pick = (list) => list.sort((a, b) => b.touches - a.touches).slice(0, max).sort((a, b) => a.price - b.price);
  return {
    support: pick(pool.filter((g) => g.price < price)),
    resistance: pick(pool.filter((g) => g.price >= price)),
  };
}

// Plain-English readings of whichever indicators are switched on. tone: 'bull' | 'bear' | 'neutral'.
export function signalsFrom(candles, ind = {}) {
  const out = [];
  const i = candles.length - 1;
  if (i < 1) return out;
  const price = candles[i].close;
  const { rsi, macd, sma, ema, bollinger: bb } = ind;
  if (rsi && finite(rsi.values[i])) {
    const v = rsi.values[i];
    out.push(v >= 70 ? { tone: 'bear', text: `RSI ${v.toFixed(0)}: overbought, a pullback is more likely.` }
      : v <= 30 ? { tone: 'bull', text: `RSI ${v.toFixed(0)}: oversold, a bounce is more likely.` }
        : { tone: 'neutral', text: `RSI ${v.toFixed(0)}: neither overbought nor oversold.` });
  }
  if (macd && finite(macd.macd[i]) && finite(macd.signalLine[i])) {
    const above = macd.macd[i] > macd.signalLine[i];
    const crossed = finite(macd.macd[i - 1]) && finite(macd.signalLine[i - 1]) && (macd.macd[i - 1] > macd.signalLine[i - 1]) !== above;
    out.push({ tone: above ? 'bull' : 'bear', text: `MACD is ${above ? 'above' : 'below'} its signal line${crossed ? ' (just crossed)' : ''}: momentum is ${above ? 'rising' : 'falling'}.` });
  }
  for (const [name, s] of [['SMA', sma], ['EMA', ema]]) {
    if (s && finite(s.values[i])) {
      const above = price > s.values[i];
      out.push({ tone: above ? 'bull' : 'bear', text: `Price is ${above ? 'above' : 'below'} the ${name} ${s.period}.` });
    }
  }
  if (bb && finite(bb.upper[i]) && finite(bb.lower[i])) {
    const pos = (price - bb.lower[i]) / (bb.upper[i] - bb.lower[i] || 1);
    out.push(pos > 0.95 ? { tone: 'bear', text: 'Price is at the upper Bollinger band: stretched to the upside.' }
      : pos < 0.05 ? { tone: 'bull', text: 'Price is at the lower Bollinger band: stretched to the downside.' }
        : { tone: 'neutral', text: `Price is ${(pos * 100).toFixed(0)}% of the way up the Bollinger band.` });
  }
  return out;
}

// Statistics for a plain series of values (portfolio value, rebased comparison lines).
export function seriesStats(values) {
  const v = values.filter(finite);
  if (!v.length) return null;
  const rets = v.slice(1).map((x, i) => (v[i] ? (x - v[i]) / v[i] : 0));
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const volatility = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) * 100 : 0;
  let peak = v[0]; let dd = 0;
  for (const x of v) { peak = Math.max(peak, x); dd = Math.min(dd, peak ? (x - peak) / peak : 0); }
  return {
    start: v[0], end: last(v),
    change: last(v) - v[0],
    changePct: v[0] ? ((last(v) - v[0]) / v[0]) * 100 : 0,
    high: Math.max(...v), low: Math.min(...v),
    volatility, drawdownPct: dd * 100,
    trend: trendOf(v),
  };
}

// Pearson correlation of the returns of two equal-length series, from -1 to 1 (null if it can't be worked out).
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  const ra = []; const rb = [];
  for (let i = 1; i < n; i++) if (a[i - 1] && b[i - 1]) { ra.push(a[i] / a[i - 1] - 1); rb.push(b[i] / b[i - 1] - 1); }
  if (ra.length < 3) return null;
  const ma = ra.reduce((s, x) => s + x, 0) / ra.length;
  const mb = rb.reduce((s, x) => s + x, 0) / rb.length;
  let sab = 0; let saa = 0; let sbb = 0;
  ra.forEach((x, i) => { sab += (x - ma) * (rb[i] - mb); saa += (x - ma) ** 2; sbb += (rb[i] - mb) ** 2; });
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}

export const describeCorrelation = (r) => (r === null ? 'Not enough data'
  : r >= 0.7 ? 'Move closely together' : r >= 0.3 ? 'Tend to move together' : r > -0.3 ? 'Mostly independent' : r > -0.7 ? 'Tend to move oppositely' : 'Move in opposite directions');

// Change between two pinned points on a series of {t, value}.
export function pinSummary(a, b) {
  const [p, q] = a.t <= b.t ? [a, b] : [b, a];
  return { delta: q.value - p.value, pct: p.value ? ((q.value - p.value) / p.value) * 100 : 0, ms: q.t - p.t, from: p, to: q };
}

export function analyze(candles, indicators = {}) {
  if (!candles.length) return null;
  const closes = candles.map((c) => c.close);
  const first = candles[0];
  const lastC = last(candles);
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i])).filter(finite);
  const mean = returns.reduce((s, v) => s + v, 0) / (returns.length || 1);
  const volatility = returns.length > 1
    ? Math.sqrt(returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1)) * 100
    : 0;
  const volumes = candles.map((c) => c.volume ?? 0);
  // Largest peak-to-trough fall inside the window.
  let peak = closes[0]; let drawdown = 0;
  for (const c of closes) { peak = Math.max(peak, c); drawdown = Math.min(drawdown, (c - peak) / peak); }
  const signals = signalsFrom(candles, indicators);
  const score = signals.reduce((s, x) => s + (x.tone === 'bull' ? 1 : x.tone === 'bear' ? -1 : 0), 0);
  return {
    change: lastC.close - first.open,
    changePct: ((lastC.close - first.open) / first.open) * 100,
    high, low,
    fromHighPct: ((lastC.close - high) / high) * 100,
    fromLowPct: ((lastC.close - low) / low) * 100,
    volatility,
    drawdownPct: drawdown * 100,
    avgVolume: volumes.reduce((s, v) => s + v, 0) / volumes.length,
    lastVolume: lastC.volume ?? 0,
    trend: trendOf(closes),
    levels: findLevels(candles),
    signals,
    bias: signals.length ? (score > 0 ? 'Bullish' : score < 0 ? 'Bearish' : 'Mixed') : null,
  };
}
