import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, findLevels, trendOf } from './src/lib/chartAnalysis.js';
import {
  indexAtTime, loadDrawings, measure, sanitizeDrawings, saveDrawings, timeAtIndex, distToSegment,
} from './src/lib/drawings.js';

const candle = (i, close) => ({ t: 1000 + i * 60000, open: close, high: close + 1, low: close - 1, close, volume: 10 });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test('trendOf: reads rising, falling and flat closes', () => {
  assert.equal(trendOf([1, 2, 3, 4, 5, 6]).direction, 'Uptrend');
  assert.equal(trendOf([6, 5, 4, 3, 2, 1]).direction, 'Downtrend');
  assert.equal(trendOf([5, 5, 5, 5, 5]).direction, 'Sideways');
  assert.equal(trendOf([1]).direction, 'Sideways');
});

test('findLevels: groups repeated turning points into support and resistance', () => {
  const closes = [10, 12, 14, 12, 10, 12, 14, 12, 10, 12, 14, 12, 10, 11];
  const { support, resistance } = findLevels(closes.map((c, i) => candle(i, c)), { window: 1 });
  assert.ok(support.length && resistance.length);
  assert.ok(support.every((l) => l.price < 11.5));
  assert.ok(resistance.every((l) => l.price > 11.5));
});

test('analyze: summarises a window and tolerates no data', () => {
  assert.equal(analyze([]), null);
  const a = analyze([10, 11, 12, 11, 13].map((c, i) => candle(i, c)));
  assert.equal(a.change, 3);
  assert.equal(a.high, 14);
  assert.equal(a.low, 9);
  assert.ok(a.volatility > 0);
  assert.equal(a.bias, null);
});

test('analyze: turns indicators into signals', () => {
  const candles = [10, 11, 12, 13].map((c, i) => candle(i, c));
  const rsi = { period: 14, values: [null, 50, 60, 75] };
  const a = analyze(candles, { rsi });
  assert.equal(a.signals[0].tone, 'bear');
  assert.equal(a.bias, 'Bearish');
});

test('indexAtTime and timeAtIndex are inverses, inside and beyond the candles', () => {
  const c = [0, 1, 2, 3].map((i) => candle(i, 10));
  for (const i of [-2, 0, 1.5, 3, 5.25]) assert.ok(Math.abs(indexAtTime(c, timeAtIndex(c, i)) - i) < 1e-9);
});

test('measure and distToSegment', () => {
  const c = [0, 1, 2, 3].map((i) => candle(i, 10));
  const m = measure({ t: c[0].t, price: 100 }, { t: c[3].t, price: 110 }, c);
  assert.deepEqual(m, { delta: 10, pct: 10, bars: 3 });
  assert.equal(distToSegment(5, 3, 0, 0, 10, 0), 3);
});

test('drawings: bad stored data is dropped and good data round-trips per symbol and timeframe', () => {
  const good = { id: 'a', type: 'trend', color: '#38bdf8', points: [{ t: 1, price: 2 }, { t: 3, price: 4 }] };
  const bad = [{ id: 'b', type: 'trend', points: [{ t: 1, price: 2 }] }, { id: 'c', type: 'nope', points: [] }, null, 'x'];
  assert.deepEqual(sanitizeDrawings([good, ...bad]), [good]);
  assert.deepEqual(sanitizeDrawings('junk'), []);
  const s = memory();
  assert.equal(saveDrawings('BTC', '1D', [good], s), true);
  assert.deepEqual(loadDrawings('BTC', '1D', s), [good]);
  assert.deepEqual(loadDrawings('BTC', '1W', s), []);
  assert.deepEqual(loadDrawings('ETH', '1D', { getItem: () => '{not json' }), []);
});

test('seriesStats, correlation and pinSummary', async () => {
  const { seriesStats, correlation, pinSummary, describeCorrelation } = await import('./src/lib/chartAnalysis.js');
  assert.equal(seriesStats([]), null);
  const s = seriesStats([100, 110, 99, 120]);
  assert.equal(s.change, 20);
  assert.equal(s.high, 120);
  assert.ok(s.drawdownPct < -9.9 && s.drawdownPct > -10.1);
  near(correlation([1, 2, 3, 4, 5, 7], [2, 4, 6, 8, 10, 14]), 1, 1e-9);
  assert.ok(correlation([1, 2, 1, 2, 1, 2], [2, 1, 2, 1, 2, 1]) < -0.99);
  assert.equal(correlation([1, 2], [1, 2]), null);
  assert.equal(describeCorrelation(null), 'Not enough data');
  const m = pinSummary({ t: 20, value: 110 }, { t: 10, value: 100 });
  assert.deepEqual([m.delta, m.pct, m.ms], [10, 10, 10]);
});

test('drawings: notes and alerts keep their extras, and alerts fire from the side they were set on', async () => {
  const { sanitizeDrawings, alertHit } = await import('./src/lib/drawings.js');
  const pt = [{ t: 1, price: 50 }];
  const [note, alert] = sanitizeDrawings([
    { id: 'n', type: 'note', points: pt, text: 'x'.repeat(200) },
    { id: 'a', type: 'alert', points: pt, side: 'below' },
  ]);
  assert.equal(note.text.length, 80);
  assert.equal(alert.side, 'below');
  assert.equal(alertHit(alert, 49), true);
  assert.equal(alertHit(alert, 51), false);
  assert.equal(alertHit({ ...alert, side: 'above' }, 51), true);
  assert.equal(sanitizeDrawings([{ id: 'r', type: 'rect', points: [...pt, ...pt] }]).length, 1);
});
