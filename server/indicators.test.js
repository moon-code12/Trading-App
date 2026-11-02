import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WARMUP, bollinger, computeIndicators, ema, macd, rsi, sma,
} from './src/indicators.js';

const near = (actual, expected, eps = 1e-9, msg = '') => assert.ok(Math.abs(actual - expected) <= eps, `${msg} ${actual} != ${expected}`);
const nearAll = (actual, expected, eps) => {
  assert.equal(actual.length, expected.length);
  expected.forEach((e, i) => (e === null ? assert.equal(actual[i], null, `index ${i} should be null`) : near(actual[i], e, eps, `index ${i}:`)));
};

// Public reference data (worked examples from StockCharts' technical-analysis guide). Their published
// tables round intermediate figures, so they can differ slightly from exact arithmetic. Each test checks
// the exact result (verified independently with rational arithmetic) and the published table within its rounding.
const EMA_CLOSES = [22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29, 22.15, 22.39, 22.38, 22.61, 23.36, 24.05, 23.75, 23.83, 23.95, 23.63, 23.82, 23.87, 23.65, 23.19, 23.10, 23.33, 22.68, 23.10, 22.40, 22.17];
const RSI_CLOSES = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13];
const BB_CLOSES = [86.16, 89.09, 88.78, 90.32, 89.07, 91.15, 89.44, 89.18, 86.93, 87.68, 86.96, 89.43, 89.32, 88.72, 87.45, 87.26, 89.50, 87.90, 89.13, 90.70, 92.90, 92.98, 91.80, 92.66, 92.68, 92.30, 92.77, 92.54, 92.95, 93.20, 91.07, 89.83, 89.74];

// ------------------------------------------------------------------ SMA

test('sma: averages the last N values and is null until there are N', () => {
  nearAll(sma([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3), [null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
  nearAll(sma([10, 20, 30], 1), [10, 20, 30]);
  nearAll(sma([5, 5, 5, 5], 4), [null, null, null, 5]);
});

test('sma: matches the published 10-day example', () => {
  const s = sma(EMA_CLOSES, 10);
  assert.equal(s.slice(0, 9).every((v) => v === null), true);
  near(s[9], 22.221, 1e-9); // mean of the first ten closes
  near(s[10], 22.209, 1e-9); // (22.19 + ... + 22.15) / 10
});

test('sma: too little data, empty input and bad periods', () => {
  assert.deepEqual(sma([1, 2], 3), [null, null]);
  assert.deepEqual(sma([], 3), []);
  for (const bad of [0, -2, 1.5, NaN, '3', undefined]) assert.throws(() => sma([1, 2, 3], bad), RangeError, String(bad));
});

// ------------------------------------------------------------------ EMA

test('ema: seeds with the simple average, then applies 2 / (N + 1)', () => {
  const e = ema([2, 4, 6, 8, 10], 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  near(e[2], 4); // mean of 2, 4, 6
  near(e[3], 8 * 0.5 + 4 * 0.5); // k = 2 / 4 = 0.5 -> 6
  near(e[4], 10 * 0.5 + 6 * 0.5); // 8
});

test('ema: matches the published 10-day example', () => {
  const e = ema(EMA_CLOSES, 10);
  const exact = [22.221, 22.208, 22.241, 22.266, 22.329, 22.516, 22.795, 22.969, 23.125, 23.275, 23.340, 23.427, 23.508, 23.534, 23.471, 23.404];
  exact.forEach((x, i) => near(e[9 + i], x, 0.0005, `EMA at day ${10 + i}:`));
  const published = [22.22, 22.21, 22.24, 22.27, 22.33, 22.52, 22.80, 22.97, 23.13, 23.28, 23.34, 23.43, 23.51, 23.54, 23.47, 23.40, 23.39, 23.26, 23.23, 23.08, 22.92];
  published.forEach((p, i) => near(e[9 + i], p, 0.011, `EMA at day ${10 + i} vs the published table:`));
  near(e[9], 22.221, 1e-9);
  near(e[10], 22.15 * (2 / 11) + 22.221 * (9 / 11), 1e-9);
});

test('ema: an independent recursive calculation agrees on random-looking data', () => {
  const data = Array.from({ length: 80 }, (_, i) => 100 + 10 * Math.sin(i / 3) + (i % 7));
  for (const period of [2, 5, 12, 26]) {
    const k = 2 / (period + 1);
    let expected = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const out = ema(data, period);
    near(out[period - 1], expected);
    for (let i = period; i < data.length; i++) {
      expected = k * data[i] + (1 - k) * expected;
      near(out[i], expected, 1e-9, `period ${period} index ${i}:`);
    }
  }
});

test('ema: period 1 follows the price, constant data stays constant, short input is all null', () => {
  nearAll(ema([3, 9, 4], 1), [3, 9, 4]);
  ema(Array(40).fill(7), 12).slice(11).forEach((v) => near(v, 7));
  assert.deepEqual(ema([1, 2, 3], 5), [null, null, null]);
  assert.throws(() => ema([1, 2, 3], 0), RangeError);
});

// ------------------------------------------------------------------ RSI

test('rsi: matches the published 14-day Wilder example', () => {
  const r = rsi(RSI_CLOSES, 14);
  assert.equal(r.slice(0, 14).every((v) => v === null), true);
  const exact = [70.46, 66.25, 66.48, 69.35, 66.29, 57.92, 62.88, 63.21, 56.01, 62.34, 54.67, 50.39, 40.02, 41.49, 41.90, 45.50, 37.32, 33.09, 37.79];
  exact.forEach((x, i) => near(r[14 + i], x, 0.005, `RSI at day ${15 + i}:`));
  near(r[14], 100 - 100 / (1 + 0.23857142857142857 / 0.1), 1e-9); // avg gain 3.34 / 14, avg loss 1.4 / 14
  const published = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.30, 33.08, 37.77];
  published.forEach((p, i) => near(r[14 + i], p, 0.08, `RSI at day ${15 + i} vs the published table:`));
});

test('rsi: hand-worked small example', () => {
  // period 3, closes 10, 11, 10, 12: changes +1, -1, +2. avg gain 1, avg loss 1/3 -> RS 3 -> RSI 75.
  const r = rsi([10, 11, 10, 12], 3);
  assert.deepEqual(r.slice(0, 3), [null, null, null]);
  near(r[3], 75);
  // next close 11: change -1 -> gain (1*2+0)/3, loss ((1/3)*2+1)/3 -> RS = (2/3)/(5/9) = 1.2 -> RSI 54.545...
  near(rsi([10, 11, 10, 12, 11], 3)[4], 100 - 100 / (1 + 1.2), 1e-9);
});

test('rsi: stays between 0 and 100, and reads the extremes', () => {
  near(rsi(Array.from({ length: 30 }, (_, i) => i), 14)[29], 100); // only gains
  near(rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14)[29], 0); // only losses
  rsi(Array(30).fill(50), 14).slice(14).forEach((v) => near(v, 50)); // no movement: neutral
  const wiggly = Array.from({ length: 200 }, (_, i) => 50 + 20 * Math.sin(i / 4) + (i % 5));
  rsi(wiggly, 14).filter((v) => v !== null).forEach((v) => assert.ok(v >= 0 && v <= 100));
});

test('rsi: needs period + 1 closes; other periods work', () => {
  assert.deepEqual(rsi([1, 2, 3], 3), [null, null, null]);
  assert.notEqual(rsi([1, 2, 3, 2], 3)[3], null);
  assert.equal(rsi(RSI_CLOSES, 5).filter((v) => v !== null).length, RSI_CLOSES.length - 5);
  assert.throws(() => rsi([1, 2, 3], 0), RangeError);
});

// ------------------------------------------------------------------ MACD

test('macd: the line, signal and histogram start where their inputs allow', () => {
  const data = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5 + 3 * Math.sin(i / 2));
  const m = macd(data, 12, 26, 9);
  assert.equal(m.macd.findIndex((v) => v !== null), 25); // needs the 26th close
  assert.equal(m.signal.findIndex((v) => v !== null), 33); // plus 8 more MACD values
  assert.equal(m.histogram.findIndex((v) => v !== null), 33);
  assert.ok([m.macd, m.signal, m.histogram].every((a) => a.length === data.length));
});

test('macd: equals EMA(fast) - EMA(slow), signal is the EMA of that line, histogram is the difference', () => {
  const data = Array.from({ length: 90 }, (_, i) => 50 + 8 * Math.sin(i / 5) + (i % 4) * 0.7 + i * 0.1);
  const m = macd(data);
  const f = ema(data, 12);
  const s = ema(data, 26);
  for (let i = 25; i < data.length; i++) near(m.macd[i], f[i] - s[i], 1e-9);
  const line = m.macd.slice(25);
  const sig = ema(line, 9);
  for (let i = 33; i < data.length; i++) {
    near(m.signal[i], sig[i - 25], 1e-9);
    near(m.histogram[i], m.macd[i] - m.signal[i], 1e-9);
  }
});

test('macd: flat data gives zeros, a steady climb gives a positive line, other periods work', () => {
  const flat = macd(Array(60).fill(10));
  flat.macd.filter((v) => v !== null).forEach((v) => near(v, 0));
  flat.histogram.filter((v) => v !== null).forEach((v) => near(v, 0));
  const climb = macd(Array.from({ length: 80 }, (_, i) => 100 + i));
  climb.macd.filter((v) => v !== null).forEach((v) => assert.ok(v > 0));
  const custom = macd(Array.from({ length: 40 }, (_, i) => i * i), 5, 10, 3);
  assert.equal(custom.macd.findIndex((v) => v !== null), 9);
  assert.equal(custom.signal.findIndex((v) => v !== null), 11);
  assert.throws(() => macd([1, 2, 3], 26, 12, 9), RangeError);
  assert.throws(() => macd([1, 2, 3], 12, 12, 9), RangeError);
  assert.throws(() => macd([1, 2, 3], 12, 26, 0), RangeError);
});

test('macd: too little data gives all null', () => {
  const m = macd(Array(20).fill(5));
  assert.ok(m.macd.every((v) => v === null) && m.signal.every((v) => v === null) && m.histogram.every((v) => v === null));
});

// ------------------------------------------------------------------ Bollinger Bands

test('bollinger: matches the published 20-day example', () => {
  const b = bollinger(BB_CLOSES, 20, 2);
  assert.equal(b.middle.slice(0, 19).every((v) => v === null), true);
  near(b.middle[19], 88.709, 0.0005);
  near(b.upper[19], 91.292, 0.0005);
  near(b.lower[19], 86.125, 0.0005);
  near(b.middle[20], 89.046, 0.0005);
  near(b.upper[20], 91.950, 0.0005);
  near(b.lower[20], 86.141, 0.0005);
  // The published table (88.71 / 91.29 / 86.13 and 89.05 / 91.99 / 86.12) agrees within its rounding.
  [[19, 88.71, 91.29, 86.13], [20, 89.05, 91.99, 86.12]].forEach(([i, m, u, l]) => {
    near(b.middle[i], m, 0.01);
    near(b.upper[i], u, 0.05);
    near(b.lower[i], l, 0.03);
  });
});

test('bollinger: population standard deviation of a small window, worked by hand', () => {
  // window 2, 4, 4, 4, 5, 5, 7, 9 has mean 5 and population sd exactly 2
  const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
  near(b.middle[7], 5);
  near(b.upper[7], 9);
  near(b.lower[7], 1);
  const wide = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 1.5);
  near(wide.upper[7], 8);
  near(wide.lower[7], 2);
});

test('bollinger: flat data collapses the bands, and the bands always straddle the middle', () => {
  const flat = bollinger(Array(25).fill(42), 20, 2);
  near(flat.upper[24], 42);
  near(flat.lower[24], 42);
  const data = Array.from({ length: 100 }, (_, i) => 100 + 10 * Math.sin(i / 6) + (i % 3));
  const b = bollinger(data, 20, 2);
  for (let i = 19; i < data.length; i++) {
    assert.ok(b.lower[i] <= b.middle[i] && b.middle[i] <= b.upper[i]);
    near(b.upper[i] - b.middle[i], b.middle[i] - b.lower[i], 1e-9);
  }
  assert.throws(() => bollinger([1, 2, 3], 20, 0), RangeError);
  assert.throws(() => bollinger([1, 2, 3], 0, 2), RangeError);
});

// ------------------------------------------------------------------ assembling a chart's indicators

test('computeIndicators: returns only what was asked for, trimmed to the visible window', () => {
  const closes = Array.from({ length: WARMUP + 40 }, (_, i) => 100 + 5 * Math.sin(i / 4) + i * 0.05);
  const out = computeIndicators(closes, 40, ['sma', 'rsi']);
  assert.deepEqual(Object.keys(out).sort(), ['rsi', 'sma', 'warmup']);
  assert.equal(out.warmup, WARMUP);
  assert.equal(out.sma.values.length, 40);
  assert.equal(out.rsi.values.length, 40);
  assert.equal(out.sma.period, 20);
  assert.equal(out.rsi.period, 14);
  // The warm-up history means every visible value exists, with no leading nulls.
  assert.ok(out.sma.values.every((v) => v !== null) && out.rsi.values.every((v) => v !== null));
  // The visible values are the tail of the full series, not recomputed from the window alone.
  const full = sma(closes, 20);
  near(out.sma.values[39], full[closes.length - 1], 1e-6);
  near(out.sma.values[0], full[WARMUP], 1e-6);
});

test('computeIndicators: all indicators, custom periods, values rounded to 6 places', () => {
  const closes = Array.from({ length: WARMUP + 30 }, (_, i) => 1.08 + 0.01 * Math.sin(i / 3));
  const out = computeIndicators(closes, 30, ['sma', 'ema', 'rsi', 'macd', 'bb'], { smaPeriod: 50, emaPeriod: 9 });
  assert.equal(out.sma.period, 50);
  assert.equal(out.ema.period, 9);
  assert.deepEqual([out.macd.fast, out.macd.slow, out.macd.signal], [12, 26, 9]);
  assert.deepEqual([out.bollinger.period, out.bollinger.deviations], [20, 2]);
  for (const series of [out.sma.values, out.ema.values, out.rsi.values, out.macd.macd, out.macd.signalLine, out.macd.histogram, out.bollinger.upper, out.bollinger.middle, out.bollinger.lower]) {
    assert.equal(series.length, 30);
    series.forEach((v) => assert.equal(v, Math.round(v * 1e6) / 1e6));
  }
  assert.deepEqual(Object.keys(computeIndicators(closes, 30, [])), ['warmup']);
  assert.deepEqual(Object.keys(computeIndicators(closes, 30, ['volume'])), ['warmup']); // volume comes with the candles
});

test('computeIndicators: without enough history the leading values stay null instead of being invented', () => {
  const out = computeIndicators(Array.from({ length: 30 }, (_, i) => 10 + i), 30, ['sma', 'macd']);
  assert.equal(out.sma.values.findIndex((v) => v !== null), 19);
  assert.equal(out.macd.macd.findIndex((v) => v !== null), 25);
  assert.equal(out.macd.signalLine.every((v) => v === null), true);
});
