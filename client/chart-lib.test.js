import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKGROUND, GRID, INDICATOR_STYLES, PALETTES, TEXT, TEXT_STRONG, contrastRatio, deltaE, luminance, paletteFor, simulate, worstCaseDifference,
} from './src/lib/palette.js';
import {
  DEFAULT_PREFS, EMA_PERIODS, INDICATOR_KEYS, SMA_PERIODS, STORAGE_KEY, TIMEFRAMES, candlesQuery, loadPrefs, sanitizePrefs, savePrefs,
} from './src/lib/chartPrefs.js';
import { extent, indexAt, seriesPath } from './src/lib/chartMath.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// ------------------------------------------------------------------ colour maths

test('colour maths: known WCAG values', () => {
  near(luminance('#ffffff'), 1);
  near(luminance('#000000'), 0);
  near(contrastRatio('#ffffff', '#000000'), 21, 1e-9);
  near(contrastRatio('#777777', '#ffffff'), 4.48, 0.01); // the classic "just fails AA" grey
  near(contrastRatio('#767676', '#ffffff'), 4.54, 0.01); // and the lightest grey that passes AA
  assert.equal(contrastRatio('#336699', '#336699'), 1);
  assert.equal(contrastRatio('#123456', '#abcdef'), contrastRatio('#abcdef', '#123456'));
  assert.throws(() => luminance('red'), /Not a #rrggbb colour/);
  assert.throws(() => luminance('#fff'), /Not a #rrggbb colour/);
});

test('colour maths: colour difference and vision simulation behave sensibly', () => {
  near(deltaE('#336699', '#336699'), 0);
  near(deltaE('#000000', '#ffffff'), 100, 0.01); // lightness 0 to 100
  assert.ok(deltaE('#ff0000', '#ff0101') < 1);
  // Greys have no hue, so they look the same to everyone.
  for (const type of ['protanopia', 'deuteranopia', 'tritanopia']) assert.ok(deltaE('#808080', simulate('#808080', type)) < 2, type);
  // Red and green collapse towards each other for red-green colour blindness.
  assert.ok(deltaE('#ff0000', '#00cc00') > 80);
  assert.ok(deltaE(simulate('#ff0000', 'deuteranopia'), simulate('#00cc00', 'deuteranopia')) < 40);
  assert.ok(worstCaseDifference('#ff0000', '#00cc00') < 40);
  assert.equal(simulate('#000000', 'protanopia'), '#000000');
});

// ------------------------------------------------------------------ accessible colours

test('accessible colours: every chart colour clears the WCAG contrast minimum against the chart background', () => {
  const graphics = [
    ...Object.values(PALETTES).flatMap((p) => [p.up, p.down]),
    ...Object.values(INDICATOR_STYLES).map((s) => s.color),
  ];
  for (const c of graphics) assert.ok(contrastRatio(c, BACKGROUND) >= 3, `${c} needs 3:1 for graphics, has ${contrastRatio(c, BACKGROUND).toFixed(2)}`);
  for (const c of [TEXT, TEXT_STRONG]) assert.ok(contrastRatio(c, BACKGROUND) >= 4.5, `${c} needs 4.5:1 for text, has ${contrastRatio(c, BACKGROUND).toFixed(2)}`);
  assert.ok(contrastRatio(GRID, BACKGROUND) < 2, 'grid lines stay quiet');
});

test('accessible colours: the colour-blind palette keeps up and down apart for every kind of colour vision', () => {
  const { up, down } = PALETTES.accessible;
  assert.ok(worstCaseDifference(up, down) >= 40, `got ${worstCaseDifference(up, down).toFixed(1)}`);
});

test('accessible colours: the standard green and red are NOT safe, which is why the alternative exists', () => {
  const { up, down } = PALETTES.standard;
  assert.ok(deltaE(up, down) > 80, 'clearly different with normal vision');
  assert.ok(worstCaseDifference(up, down) < 20, 'but they collapse together for red-green colour blindness');
});

test('accessible colours: indicator lines stay distinguishable, and dash patterns back colour up', () => {
  const { sma, ema, bb } = INDICATOR_STYLES;
  for (const [a, b] of [[sma, ema], [sma, bb], [ema, bb]]) {
    assert.ok(worstCaseDifference(a.color, b.color) >= 15, `${a.label} vs ${b.label}: ${worstCaseDifference(a.color, b.color).toFixed(1)}`);
  }
  assert.equal(new Set([sma.dash, ema.dash, bb.dash]).size, 3, 'each overlay has its own line style');
  // The indicator lines also stay apart from the candle colours in the accessible palette.
  const { up, down } = PALETTES.accessible;
  assert.ok(worstCaseDifference(sma.color, up) >= 25 && worstCaseDifference(sma.color, down) >= 25);
  assert.ok(worstCaseDifference(ema.color, up) >= 15 && worstCaseDifference(ema.color, down) >= 15);
  assert.deepEqual(paletteFor('accessible'), PALETTES.accessible);
  assert.deepEqual(paletteFor('nonsense'), PALETTES.standard);
});

// ------------------------------------------------------------------ preferences

const fakeStorage = (initial = {}) => {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
};

test('prefs: defaults are complete and valid', () => {
  assert.deepEqual(sanitizePrefs(undefined), DEFAULT_PREFS);
  assert.deepEqual(sanitizePrefs({}), DEFAULT_PREFS);
  assert.ok(TIMEFRAMES.includes(DEFAULT_PREFS.tf));
  assert.ok(SMA_PERIODS.includes(DEFAULT_PREFS.smaPeriod) && EMA_PERIODS.includes(DEFAULT_PREFS.emaPeriod));
  assert.deepEqual(Object.keys(DEFAULT_PREFS.indicators), INDICATOR_KEYS);
});

test('prefs: valid choices are kept', () => {
  const chosen = {
    tf: '3M', mode: 'line', palette: 'accessible', smaPeriod: 50, emaPeriod: 12,
    indicators: { volume: false, sma: true, ema: true, bb: true, rsi: true, macd: true },
  };
  assert.deepEqual(sanitizePrefs(chosen), chosen);
});

test('prefs: anything invalid falls back to the default, field by field', () => {
  const messy = sanitizePrefs({
    tf: '10Y', mode: 'bars', palette: 'neon', smaPeriod: 7, emaPeriod: '12',
    indicators: { volume: 'yes', sma: true, ema: 1, bb: null, rsi: false, macd: true, hacker: true },
  });
  assert.deepEqual(messy, { ...DEFAULT_PREFS, indicators: { ...DEFAULT_PREFS.indicators, sma: true, rsi: false, macd: true } });
  assert.equal('hacker' in messy.indicators, false);
  for (const junk of [null, 'text', 42, [], [1, 2], true, { indicators: 'all' }, { indicators: [] }]) {
    assert.deepEqual(sanitizePrefs(junk), DEFAULT_PREFS, JSON.stringify(junk));
  }
});

test('prefs: the defaults object cannot be changed by accident, and results are independent copies', () => {
  assert.throws(() => { 'use strict'; DEFAULT_PREFS.tf = '1H'; }, TypeError);
  assert.throws(() => { 'use strict'; DEFAULT_PREFS.indicators.rsi = true; }, TypeError);
  const a = sanitizePrefs({});
  a.indicators.rsi = true;
  assert.equal(sanitizePrefs({}).indicators.rsi, false);
});

test('prefs: save then load returns the same choices', () => {
  const storage = fakeStorage();
  const prefs = sanitizePrefs({ tf: '1W', mode: 'line', palette: 'accessible', smaPeriod: 10, indicators: { rsi: true, macd: true } });
  assert.equal(savePrefs(prefs, storage), true);
  assert.ok(STORAGE_KEY in storage.data);
  assert.deepEqual(loadPrefs(storage), prefs);
  assert.deepEqual(loadPrefs(fakeStorage()), DEFAULT_PREFS, 'nothing stored yet');
});

test('prefs: corrupt or hostile stored data, and unavailable storage, never throw', () => {
  assert.deepEqual(loadPrefs(fakeStorage({ [STORAGE_KEY]: '{not json' })), DEFAULT_PREFS);
  assert.deepEqual(loadPrefs(fakeStorage({ [STORAGE_KEY]: 'null' })), DEFAULT_PREFS);
  assert.deepEqual(loadPrefs(fakeStorage({ [STORAGE_KEY]: '{"tf":"<script>","indicators":{"rsi":"true"}}' })), DEFAULT_PREFS);
  assert.deepEqual(loadPrefs(undefined), DEFAULT_PREFS);
  assert.deepEqual(loadPrefs({ getItem() { throw new Error('blocked'); } }), DEFAULT_PREFS);
  assert.equal(savePrefs(DEFAULT_PREFS, { setItem() { throw new Error('quota'); } }), false);
  assert.equal(savePrefs(DEFAULT_PREFS, undefined), false);
});

test('prefs: saving cleans the data first', () => {
  const storage = fakeStorage();
  savePrefs({ tf: 'nope', extra: 'x', indicators: { rsi: true, evil: true } }, storage);
  const stored = JSON.parse(storage.data[STORAGE_KEY]);
  assert.deepEqual(Object.keys(stored).sort(), ['emaPeriod', 'indicators', 'mode', 'palette', 'smaPeriod', 'tf']);
  assert.equal(stored.tf, '1D');
  assert.equal(stored.indicators.rsi, true);
  assert.equal('evil' in stored.indicators, false);
});

test('prefs: the candles request asks only for what is switched on', () => {
  assert.equal(candlesQuery(DEFAULT_PREFS), 'tf=1D'); // volume arrives with every candle
  assert.equal(candlesQuery({ ...DEFAULT_PREFS, tf: '1W', indicators: { ...DEFAULT_PREFS.indicators, rsi: true, bb: true } }), 'tf=1W&indicators=rsi,bb');
  assert.equal(
    candlesQuery({ ...DEFAULT_PREFS, smaPeriod: 50, emaPeriod: 9, indicators: { volume: true, sma: true, ema: true, bb: false, rsi: false, macd: true } }),
    'tf=1D&indicators=sma,ema,macd&smaPeriod=50&emaPeriod=9',
  );
  assert.equal(candlesQuery({ ...DEFAULT_PREFS, smaPeriod: 50 }), 'tf=1D', 'periods only matter when the indicator is on');
  assert.equal(candlesQuery({ tf: 'bad' }), 'tf=1D');
});

// ------------------------------------------------------------------ drawing helpers

test('seriesPath: draws a line through values and lifts the pen at gaps', () => {
  const x = (i) => i * 10;
  const y = (v) => 100 - v;
  assert.equal(seriesPath([10, 20, 30], x, y), 'M0.0,90.0L10.0,80.0L20.0,70.0');
  assert.equal(seriesPath([null, null, 30, 40], x, y), 'M20.0,70.0L30.0,60.0');
  assert.equal(seriesPath([10, null, 30], x, y), 'M0.0,90.0M20.0,70.0');
  assert.equal(seriesPath([null, NaN, undefined], x, y), '');
  assert.equal(seriesPath([], x, y), '');
  assert.equal(seriesPath([0], x, y), 'M0.0,100.0', 'zero is a real value');
});

test('extent: ignores gaps and handles empty input', () => {
  assert.deepEqual(extent([3, null, 9, 1], [5, 20]), [1, 20]);
  assert.deepEqual(extent([null, null]), null);
  assert.deepEqual(extent(), null);
  assert.deepEqual(extent(undefined, [2]), [2, 2]);
  assert.deepEqual(extent([-5, -1]), [-5, -1]);
});

test('indexAt: maps a horizontal position to a candle, or nothing outside the plot', () => {
  assert.equal(indexAt(8, 8, 10, 5), 0);
  assert.equal(indexAt(17.9, 8, 10, 5), 0);
  assert.equal(indexAt(18, 8, 10, 5), 1);
  assert.equal(indexAt(57.9, 8, 10, 5), 4);
  assert.equal(indexAt(58, 8, 10, 5), null);
  assert.equal(indexAt(7.9, 8, 10, 5), null);
  assert.equal(indexAt(5, 8, 10, 0), null);
});
