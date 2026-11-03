import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { TIMEFRAMES, candleCloses, candles, getAsset, priceAt, volume24h, volumeBetween } from './src/market.js';
import { WARMUP, bollinger, ema, macd, rsi, sma } from './src/indicators.js';

const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} != ${b}`);
const DAY = 24 * 3600e3;
const T = Date.parse('2026-03-10T09:30:30Z');
const ETH = getAsset('ETH');

// ------------------------------------------------------------------ volume model

test('volume: adds up across any split, is positive and is repeatable', () => {
  const a = Date.parse('2026-03-10T00:00:00Z');
  const whole = volumeBetween(ETH, a, a + 6 * 3600e3);
  const parts = volumeBetween(ETH, a, a + 2 * 3600e3 + 13 * 1000) + volumeBetween(ETH, a + 2 * 3600e3 + 13 * 1000, a + 6 * 3600e3);
  near(whole, parts, 1e-6 * whole);
  assert.equal(volumeBetween(ETH, a, a + 3600e3), volumeBetween(ETH, a, a + 3600e3));
  assert.equal(volumeBetween(ETH, a, a), 0);
  assert.equal(volumeBetween(ETH, a + 1000, a), 0);
  for (let i = 0; i < 50; i++) assert.ok(volumeBetween(ETH, a + i * 60e3, a + (i + 1) * 60e3) > 0);
});

test('volume: the 24h figure is the sum of the last 24 hours, and a day of volume is close to the catalogue volume', () => {
  for (const sym of ['BTC', 'ETH', 'EURUSD', 'AAPL']) {
    const asset = getAsset(sym);
    assert.equal(volume24h(asset, T), Math.round(volumeBetween(asset, T - DAY, T)));
    const v = volume24h(asset, T);
    assert.ok(v > asset.volume * 0.6 && v < asset.volume * 1.4, `${sym} volume ${v} vs ${asset.volume}`);
  }
});

test('volume: each candle carries exactly the volume of its own time span', () => {
  for (const tf of Object.keys(TIMEFRAMES)) {
    const { bucketMs } = TIMEFRAMES[tf];
    const list = candles(ETH, tf, T);
    list.forEach((c, i) => {
      const end = Math.min(c.t + bucketMs, T);
      near(c.volume, volumeBetween(ETH, c.t, end), 0.0006, `${tf} candle ${i}:`);
      assert.ok(c.volume > 0);
    });
  }
});

test('volume: finer candles add up to coarser ones, so every timeframe tells the same story', () => {
  const now = Date.parse('2026-03-10T12:00:30Z');
  const at = (iso) => Date.parse(iso);
  const quarter = candles(ETH, '1D', now); // 15 minute candles
  const hourly = candles(ETH, '1W', now); // 1 hour candles
  const sixHour = candles(ETH, '1M', now); // 6 hour candles
  const sum = (list, from, to) => list.filter((c) => c.t >= from && c.t < to).reduce((s, c) => s + c.volume, 0);

  const hour = hourly.find((c) => c.t === at('2026-03-10T10:00:00Z'));
  near(hour.volume, sum(quarter, at('2026-03-10T10:00:00Z'), at('2026-03-10T11:00:00Z')), 0.003);
  assert.equal(quarter.filter((c) => c.t >= at('2026-03-10T10:00:00Z') && c.t < at('2026-03-10T11:00:00Z')).length, 4);

  const six = sixHour.find((c) => c.t === at('2026-03-10T06:00:00Z'));
  near(six.volume, sum(hourly, at('2026-03-10T06:00:00Z'), at('2026-03-10T12:00:00Z')), 0.004);
  assert.equal(hourly.filter((c) => c.t >= at('2026-03-10T06:00:00Z') && c.t < at('2026-03-10T12:00:00Z')).length, 6);

  const day = candles(ETH, '3M', at('2026-03-12T05:00:00Z')).find((c) => c.t === at('2026-03-10T00:00:00Z'));
  near(day.volume, sum(hourly, at('2026-03-10T00:00:00Z'), at('2026-03-10T12:00:00Z')) + volumeBetween(ETH, at('2026-03-10T12:00:00Z'), at('2026-03-11T00:00:00Z')), 0.01);
});

test('volume: a candle that is still forming only counts the time that has passed', () => {
  const now = Date.parse('2026-03-10T09:37:00Z'); // 7 minutes into a 15 minute candle
  const forming = candles(ETH, '1D', now).at(-1);
  assert.equal(forming.t, Date.parse('2026-03-10T09:30:00Z'));
  near(forming.volume, volumeBetween(ETH, forming.t, now), 0.0006);
  assert.ok(forming.volume < volumeBetween(ETH, forming.t, forming.t + 15 * 60e3));
});

test('volume: a finished candle keeps the same volume whenever it is asked for', () => {
  const a = candles(ETH, '1D', T)[20];
  const b = candles(ETH, '1D', T + 90 * 60e3).find((c) => c.t === a.t);
  assert.equal(a.volume, b.volume);
  near(a.volume, volumeBetween(ETH, a.t, a.t + 15 * 60e3), 0.0006);
});

// ------------------------------------------------------------------ closes used for indicators

test('closes: the visible part equals the candles\' own closes and the history before it is real prices', () => {
  for (const tf of Object.keys(TIMEFRAMES)) {
    const { count, bucketMs } = TIMEFRAMES[tf];
    const list = candles(ETH, tf, T);
    const closes = candleCloses(ETH, tf, T, WARMUP);
    assert.equal(closes.length, count + WARMUP);
    assert.deepEqual(closes.slice(WARMUP), list.map((c) => c.close));
    const lastStart = Math.floor(T / bucketMs) * bucketMs;
    for (const j of [0, 1, 77, WARMUP - 1]) {
      const start = lastStart - (count - 1 + (WARMUP - j)) * bucketMs; // the (WARMUP - j)th candle before the window
      assert.equal(closes[j], priceAt(ETH, start + bucketMs), `${tf} warm-up candle ${j}`);
    }
  }
  assert.deepEqual(candleCloses(ETH, '1D', T, 0), candles(ETH, '1D', T).map((c) => c.close));
});

// ------------------------------------------------------------------ HTTP: candles and indicators

async function setup() {
  const db = await openDb(':memory:');
  const server = createApp(db, { secret: 's', log: () => {} }).listen(0);
  const base = `http://localhost:${server.address().port}/api`;
  const reg = await (await fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'T', email: 't@x.com', password: 'password1' }),
  })).json();
  const get = async (path) => {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${reg.token}` } });
    return { status: res.status, body: await res.json() };
  };
  return { server, get, base };
}

test('API: candles always include simulated volume, and no indicators unless asked', async () => {
  const { server, get } = await setup();
  try {
    for (const tf of Object.keys(TIMEFRAMES)) {
      const { status, body } = await get(`/markets/eth/candles?tf=${tf}`);
      assert.equal(status, 200);
      assert.equal(body.candles.length, TIMEFRAMES[tf].count);
      assert.ok(body.candles.every((c) => c.volume > 0 && c.high >= c.low));
      assert.equal('indicators' in body, false, tf);
    }
    const onlyVolume = (await get('/markets/eth/candles?tf=1D&indicators=volume')).body;
    assert.equal('indicators' in onlyVolume, false, 'volume comes with the candles');
    assert.equal('indicators' in (await get('/markets/eth/candles?tf=1D&indicators=')).body, false);
    assert.equal((await get('/markets/eth/candles?tf=3M')).body.candles.length, 90);
  } finally { server.close(); }
});

test('API: indicator values equal an independent calculation from the real closing prices', async () => {
  const { server, get } = await setup();
  try {
    const tf = '1W'; // hourly candles, so the request and this check land in the same candle
    const { body } = await get(`/markets/ETH/candles?tf=${tf}&indicators=sma,ema,rsi,macd,bb`);
    const ind = body.indicators;
    const count = TIMEFRAMES[tf].count;
    assert.equal(body.candles.length, count);
    assert.equal(ind.warmup, WARMUP);
    const closes = candleCloses(ETH, tf, Date.now(), WARMUP); // history is fixed; only the forming candle moves
    const lastSettled = count - 2; // everything before the forming candle
    const at = (series, i) => series[closes.length - count + i];

    const expectations = [
      [ind.sma.values, sma(closes, 20)], [ind.ema.values, ema(closes, 20)], [ind.rsi.values, rsi(closes, 14)],
      [ind.macd.macd, macd(closes).macd], [ind.macd.signalLine, macd(closes).signal], [ind.macd.histogram, macd(closes).histogram],
      [ind.bollinger.upper, bollinger(closes).upper], [ind.bollinger.middle, bollinger(closes).middle], [ind.bollinger.lower, bollinger(closes).lower],
    ];
    for (const [got, full] of expectations) {
      assert.equal(got.length, count);
      for (const i of [0, 1, 40, lastSettled]) near(got[i], at(full, i), 2e-6, `index ${i}:`);
    }
    assert.deepEqual([ind.sma.period, ind.ema.period, ind.rsi.period], [20, 20, 14]);
    assert.deepEqual([ind.macd.fast, ind.macd.slow, ind.macd.signal], [12, 26, 9]);
    assert.deepEqual([ind.bollinger.period, ind.bollinger.deviations], [20, 2]);
  } finally { server.close(); }
});

test('API: warm-up history means every visible indicator value exists, and the values are sensible', async () => {
  const { server, get } = await setup();
  try {
    for (const tf of ['1H', '1D', '3M']) {
      const { body } = await get(`/markets/BTC/candles?tf=${tf}&indicators=sma,ema,rsi,macd,bb`);
      const i = body.indicators;
      const all = [i.sma.values, i.ema.values, i.rsi.values, i.macd.macd, i.macd.signalLine, i.macd.histogram, i.bollinger.upper, i.bollinger.middle, i.bollinger.lower];
      for (const series of all) assert.ok(series.every((v) => typeof v === 'number' && Number.isFinite(v)), `${tf}: no gaps`);
      assert.ok(i.rsi.values.every((v) => v >= 0 && v <= 100));
      i.bollinger.upper.forEach((u, k) => assert.ok(u >= i.bollinger.middle[k] && i.bollinger.middle[k] >= i.bollinger.lower[k]));
      i.macd.histogram.forEach((h, k) => near(h, i.macd.macd[k] - i.macd.signalLine[k], 3e-6));
      assert.deepEqual(i.bollinger.middle, i.sma.values, 'Bollinger middle band is the 20-period SMA');
    }
  } finally { server.close(); }
});

test('API: SMA and EMA periods are configurable and validated', async () => {
  const { server, get } = await setup();
  try {
    const { body } = await get('/markets/SOL/candles?tf=1D&indicators=sma,ema&smaPeriod=50&emaPeriod=9');
    assert.equal(body.indicators.sma.period, 50);
    assert.equal(body.indicators.ema.period, 9);
    const closes = candleCloses(getAsset('SOL'), '1D', Date.now(), WARMUP);
    near(body.indicators.sma.values[10], sma(closes, 50)[closes.length - 96 + 10], 2e-6);
    near(body.indicators.ema.values[10], ema(closes, 9)[closes.length - 96 + 10], 2e-6);
    for (const bad of ['1', '201', 'x', '2.5', '-5', '']) {
      assert.equal((await get(`/markets/SOL/candles?tf=1D&indicators=sma&smaPeriod=${bad}`)).status, 400, `smaPeriod=${bad}`);
    }
  } finally { server.close(); }
});

test('API: bad requests are refused with a clear status', async () => {
  const { server, get, base } = await setup();
  try {
    assert.equal((await get('/markets/ETH/candles?tf=9Y')).status, 400);
    assert.equal((await get('/markets/NOPE/candles?tf=1D')).status, 404);
    const unknown = await get('/markets/ETH/candles?tf=1D&indicators=sma,zigzag');
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /Indicators must be a list of/);
    assert.equal((await get('/markets/ETH/candles?tf=1D&indicators=sma,sma')).status, 400);
    assert.equal((await get('/markets/ETH/candles?tf=1D&indicators=SMA')).status, 400);
    assert.equal((await fetch(`${base}/markets/ETH/candles?tf=1D`)).status, 401);
  } finally { server.close(); }
});
