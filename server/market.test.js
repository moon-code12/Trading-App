import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { isOpen, marketStatus, nextChange } from './src/sessions.js';
import {
  ASSETS, categories, compareSeries, discover, getAsset, priceAt, searchAssets, snapshot, stats24h, volume24h,
} from './src/market.js';

const at = (iso) => Date.parse(iso);
const syms = (list) => list.map((a) => a.symbol);

// ------------------------------------------------------------------ market sessions
// 2026-03-09 is a Monday, 03-13 a Friday, 03-14 a Saturday and 03-15 a Sunday.

test('sessions: the dates used below fall on the weekdays the tests assume', () => {
  const day = (iso) => new Date(iso).getUTCDay();
  assert.deepEqual(['2026-03-09', '2026-03-13', '2026-03-14', '2026-03-15'].map(day), [1, 5, 6, 0]);
});

test('sessions: crypto is always open and never changes state', () => {
  for (const iso of ['2026-03-09T03:00:00Z', '2026-03-14T12:00:00Z', '2026-03-15T23:59:00Z']) assert.equal(isOpen('always', at(iso)), true);
  assert.equal(nextChange('always', at('2026-03-14T12:00:00Z')), null);
  const s = marketStatus('always', at('2026-03-14T12:00:00Z'));
  assert.deepEqual([s.open, s.label, s.nextChange], [true, 'Open', null]);
  assert.match(s.nextChangeLabel, /Always open/);
});

test('sessions: US equities trade 14:30-21:00 UTC on weekdays only', () => {
  const open = (iso) => isOpen('us-equities', at(iso));
  assert.equal(open('2026-03-09T14:29:00Z'), false);
  assert.equal(open('2026-03-09T14:30:00Z'), true);
  assert.equal(open('2026-03-09T20:59:00Z'), true);
  assert.equal(open('2026-03-09T21:00:00Z'), false);
  assert.equal(open('2026-03-13T16:00:00Z'), true); // Friday
  assert.equal(open('2026-03-14T16:00:00Z'), false); // Saturday
  assert.equal(open('2026-03-15T16:00:00Z'), false); // Sunday
  assert.equal(nextChange('us-equities', at('2026-03-09T15:00:00Z')), at('2026-03-09T21:00:00Z'));
  assert.equal(nextChange('us-equities', at('2026-03-09T22:00:00Z')), at('2026-03-10T14:30:00Z'));
  assert.equal(nextChange('us-equities', at('2026-03-13T22:00:00Z')), at('2026-03-16T14:30:00Z')); // over the weekend
});

test('sessions: forex runs Sunday 22:00 to Friday 22:00 UTC', () => {
  const open = (iso) => isOpen('forex', at(iso));
  assert.equal(open('2026-03-15T21:59:00Z'), false);
  assert.equal(open('2026-03-15T22:00:00Z'), true);
  assert.equal(open('2026-03-11T03:00:00Z'), true);
  assert.equal(open('2026-03-13T21:59:00Z'), true);
  assert.equal(open('2026-03-13T22:00:00Z'), false);
  assert.equal(open('2026-03-14T12:00:00Z'), false);
  assert.equal(nextChange('forex', at('2026-03-14T12:00:00Z')), at('2026-03-15T22:00:00Z'));
});

test('sessions: commodities have a daily 22:00-23:00 break and close for the weekend', () => {
  const open = (iso) => isOpen('commodities', at(iso));
  assert.equal(open('2026-03-11T21:59:00Z'), true);
  assert.equal(open('2026-03-11T22:30:00Z'), false);
  assert.equal(open('2026-03-11T23:00:00Z'), true);
  assert.equal(open('2026-03-13T22:00:00Z'), false);
  assert.equal(open('2026-03-14T12:00:00Z'), false);
  assert.equal(open('2026-03-15T22:59:00Z'), false);
  assert.equal(open('2026-03-15T23:00:00Z'), true);
  assert.equal(nextChange('commodities', at('2026-03-11T22:30:00Z')), at('2026-03-11T23:00:00Z'));
  const s = marketStatus('commodities', at('2026-03-11T22:30:00Z'));
  assert.deepEqual([s.open, s.label], [false, 'Closed']);
  assert.match(s.nextChangeLabel, /^Opens 2026-03-11 23:00 UTC$/);
});

test('sessions: unknown session is an error', () => {
  assert.throws(() => isOpen('mars'), /Unknown session/);
});

// ------------------------------------------------------------------ 24h statistics

test('24h stats: high and low bracket the price and the open, and change matches', () => {
  for (const t of [at('2026-03-09T10:00:00Z'), at('2026-03-12T17:25:00Z'), at('2026-06-01T00:00:00Z')]) {
    for (const asset of ASSETS) {
      const s = stats24h(asset, t);
      const p = priceAt(asset, t);
      assert.ok(s.low24h <= p && p <= s.high24h, `${asset.symbol} price inside the 24h range`);
      assert.ok(s.low24h <= s.open24h && s.open24h <= s.high24h, `${asset.symbol} open inside the 24h range`);
      assert.equal(s.open24h, priceAt(asset, t - 24 * 3600e3));
      assert.equal(s.change24h, Math.round(((p - s.open24h) / s.open24h) * 100 * 1e6) / 1e6);
    }
  }
});

test('24h stats: a price that is a fresh 24h extreme is reported as the high or low', () => {
  const eth = getAsset('ETH');
  const STEP = 5 * 60e3;
  const prior = (t) => Array.from({ length: 288 }, (_, i) => priceAt(eth, t - 24 * 3600e3 + i * STEP));
  let high; let low;
  for (let t = at('2026-03-10T00:00:00Z'); t < at('2026-03-20T00:00:00Z') && !(high && low); t += STEP) {
    const p = priceAt(eth, t);
    const before = prior(t);
    if (!high && p > Math.max(...before)) high = t;
    if (!low && p < Math.min(...before)) low = t;
  }
  assert.ok(high && low, 'the simulated price sets new highs and lows');
  assert.equal(stats24h(eth, high).high24h, priceAt(eth, high));
  assert.equal(stats24h(eth, low).low24h, priceAt(eth, low));
});

test('24h stats: volume is simulated, deterministic and close to the catalogue figure', () => {
  const t = at('2026-03-09T10:00:00Z');
  for (const asset of ASSETS) {
    const v = volume24h(asset, t);
    assert.equal(v, volume24h(asset, t));
    assert.ok(Number.isInteger(v));
    assert.ok(v >= asset.volume * 0.7 - 1 && v <= asset.volume * 1.3 + 1, `${asset.symbol} volume within +/-30%`);
    const s = stats24h(asset, t);
    assert.equal(s.volumeUsd24h, Math.round(v * priceAt(asset, t)));
  }
  assert.notEqual(volume24h(getAsset('BTC'), t), volume24h(getAsset('BTC'), t + 7 * 3600e3), 'volume moves over time');
});

test('snapshot: carries quote, stats and market status, without internal fields', () => {
  const s = snapshot(getAsset('AAPL'), at('2026-03-09T15:00:00Z'));
  assert.equal(s.symbol, 'AAPL');
  assert.equal(s.market.open, true);
  for (const k of ['price', 'change24h', 'high24h', 'low24h', 'volume24h', 'volumeUsd24h', 'open24h', 'risk', 'liquidity']) assert.ok(k in s, k);
  for (const k of ['base', 'volume', 'session']) assert.equal(k in s, false, `${k} stays internal`);
  assert.equal(snapshot(getAsset('AAPL'), at('2026-03-14T15:00:00Z')).market.open, false);
});

// ------------------------------------------------------------------ search and filters

test('search: matches symbol or name, any case, with surrounding spaces ignored', () => {
  assert.deepEqual(syms(searchAssets({ q: 'btc' })), ['BTC']);
  assert.deepEqual(syms(searchAssets({ q: 'BIT' })), ['BTC']); // name Bitcoin
  assert.deepEqual(syms(searchAssets({ q: 'apple' })), ['AAPL']);
  assert.deepEqual(syms(searchAssets({ q: 'gold' })), ['XAU']);
  assert.deepEqual(syms(searchAssets({ q: '  eth  ' })), ['ETH']);
  assert.deepEqual(syms(searchAssets({ q: 'inc' })), ['AAPL', 'TSLA']);
  assert.deepEqual(syms(searchAssets({ q: 'usd' })), ['EURUSD', 'GBPUSD']);
  assert.equal(searchAssets({ q: '' }).length, ASSETS.length);
  assert.equal(searchAssets({}).length, ASSETS.length);
});

test('search: no match, and special characters are treated as plain text', () => {
  for (const q of ['zzz', '.*', '(', '[a-z]', '%', "'; DROP TABLE users; --"]) assert.deepEqual(searchAssets({ q }), [], q);
});

test('search: combines with the category filter', () => {
  assert.deepEqual(syms(searchAssets({ category: 'crypto' })), ['BTC', 'ETH', 'SOL']);
  assert.deepEqual(syms(searchAssets({ q: 'o', category: 'crypto' })), ['BTC', 'SOL']);
  assert.deepEqual(syms(searchAssets({ q: 'apple', category: 'crypto' })), []);
  assert.deepEqual(searchAssets({ category: 'bonds' }), []);
  assert.deepEqual(categories(), ['crypto', 'stocks', 'forex', 'commodities']);
});

// ------------------------------------------------------------------ discovery

test('discovery: gainers and losers are ordered and sign-filtered, active ranks by traded value', () => {
  const rows = ASSETS.map((a) => snapshot(a, at('2026-03-10T09:30:00Z')));
  const d = discover(rows, 3);
  assert.ok(d.gainers.every((r) => r.change24h > 0));
  assert.ok(d.losers.every((r) => r.change24h < 0));
  const positives = rows.filter((r) => r.change24h > 0).length;
  const negatives = rows.filter((r) => r.change24h < 0).length;
  assert.equal(d.gainers.length, Math.min(3, positives));
  assert.equal(d.losers.length, Math.min(3, negatives));
  for (let i = 1; i < d.gainers.length; i++) assert.ok(d.gainers[i - 1].change24h >= d.gainers[i].change24h);
  for (let i = 1; i < d.losers.length; i++) assert.ok(d.losers[i - 1].change24h <= d.losers[i].change24h);
  assert.equal(d.active.length, 3);
  for (let i = 1; i < d.active.length; i++) assert.ok(d.active[i - 1].volumeUsd24h >= d.active[i].volumeUsd24h);
  const best = [...rows].sort((a, b) => b.change24h - a.change24h)[0];
  if (best.change24h > 0) assert.equal(d.gainers[0].symbol, best.symbol);
  const mostActive = [...rows].sort((a, b) => b.volumeUsd24h - a.volumeUsd24h)[0];
  assert.equal(d.active[0].symbol, mostActive.symbol);
});

test('discovery: an all-flat or all-rising market yields empty lists, limits are honoured', () => {
  const row = (symbol, change24h, volumeUsd24h) => ({ symbol, change24h, volumeUsd24h });
  const rising = discover([row('A', 1, 5), row('B', 2, 9), row('C', 3, 1)], 2);
  assert.deepEqual(syms(rising.gainers), ['C', 'B']);
  assert.deepEqual(rising.losers, []);
  assert.deepEqual(syms(rising.active), ['B', 'A']);
  assert.deepEqual(discover([row('A', 0, 1)], 3).gainers, []);
  assert.deepEqual(discover([], 3), { gainers: [], losers: [], active: [] });
});

// ------------------------------------------------------------------ comparison

test('compare: both series start at 100 and the return matches the last point', () => {
  const t = at('2026-03-10T09:30:00Z');
  for (const range of ['1D', '1W', '1M']) {
    const c = compareSeries(getAsset('BTC'), getAsset('EURUSD'), range, t);
    assert.equal(c.range, range);
    for (const sym of ['BTC', 'EURUSD']) {
      const s = c.series[sym];
      assert.equal(s.length, 96);
      assert.equal(s[0].value, 100);
      assert.equal(s[s.length - 1].t, t);
      assert.equal(c.returnPct[sym], Math.round((s[s.length - 1].value - 100) * 1e6) / 1e6);
      assert.ok(s.every((p, i) => i === 0 || p.t > s[i - 1].t));
    }
  }
  const day = compareSeries(getAsset('BTC'), getAsset('ETH'), '1D', t);
  assert.equal(day.series.BTC[0].t, t - 24 * 3600e3);
  const month = compareSeries(getAsset('BTC'), getAsset('ETH'), '1M', t);
  assert.equal(month.series.BTC[0].t, t - 30 * 24 * 3600e3);
});

// ------------------------------------------------------------------ HTTP API

async function setup() {
  const db = openDb(':memory:');
  const server = createApp(db, { secret: 's', log: () => {} }).listen(0);
  const base = `http://localhost:${server.address().port}/api`;
  const make = async (email) => {
    const reg = await (await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'T', email, password: 'password1' }),
    })).json();
    return async (method, path, body) => {
      const res = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` }, body: body && JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
  };
  return { server, make };
}

test('API: markets list searches, filters, sorts and flags favourites', async () => {
  const { server, make } = await setup();
  try {
    const call = await make('a@x.com');
    const all = (await call('GET', '/markets')).body;
    assert.equal(all.assets.length, ASSETS.length);
    assert.deepEqual(all.categories, ['crypto', 'stocks', 'forex', 'commodities']);
    const first = all.assets[0];
    for (const k of ['symbol', 'name', 'category', 'price', 'change24h', 'high24h', 'low24h', 'volume24h', 'volumeUsd24h', 'market', 'favourite']) assert.ok(k in first, k);
    assert.equal(first.favourite, false);
    assert.equal('base' in first, false);

    assert.deepEqual(syms((await call('GET', '/markets?q=bit')).body.assets), ['BTC']);
    assert.deepEqual(syms((await call('GET', '/markets?q=%20GOLD%20')).body.assets), ['XAU']);
    assert.deepEqual(syms((await call('GET', '/markets?category=forex')).body.assets), ['EURUSD', 'GBPUSD']);
    assert.deepEqual(syms((await call('GET', '/markets?category=crypto&q=sol')).body.assets), ['SOL']);
    assert.deepEqual((await call('GET', '/markets?q=nothing-matches')).body.assets, []);
    assert.deepEqual((await call('GET', '/markets?category=bonds')).body.assets, []);

    const byChange = syms((await call('GET', '/markets?sort=change')).body.assets);
    const changes = (await call('GET', '/markets?sort=change')).body.assets.map((a) => a.change24h);
    assert.equal(byChange.length, ASSETS.length);
    for (let i = 1; i < changes.length; i++) assert.ok(changes[i - 1] >= changes[i] - 0.5, 'sorted by change, highest first (allowing for time drift between calls)');
    const names = (await call('GET', '/markets?sort=name')).body.assets.map((a) => a.name.toLowerCase());
    assert.deepEqual(names, [...names].sort());
    assert.deepEqual(syms((await call('GET', '/markets?sort=symbol&order=desc')).body.assets), [...syms(ASSETS)].sort().reverse());
    assert.equal((await call('GET', '/markets?sort=bogus')).status, 400);
    assert.equal((await call('GET', '/markets?order=sideways')).status, 400);

    await call('PUT', '/watchlist/ETH');
    const favs = (await call('GET', '/markets')).body.assets.filter((a) => a.favourite);
    assert.deepEqual(syms(favs), ['ETH']);
    await call('DELETE', '/watchlist/ETH');
    assert.equal((await call('GET', '/markets')).body.assets.some((a) => a.favourite), false);

    // Another user's favourites are not visible.
    const other = await make('b@x.com');
    await other('PUT', '/watchlist/BTC');
    assert.equal((await call('GET', '/markets')).body.assets.some((a) => a.favourite), false);
    assert.equal((await call('GET', '/markets/meta')).status, 200);
    assert.deepEqual((await call('GET', '/markets/meta')).body.categories.map((c) => [c.id, c.count]), [['crypto', 3], ['stocks', 3], ['forex', 2], ['commodities', 2]]);
    const detail = (await call('GET', '/markets/btc')).body;
    assert.equal(detail.asset.symbol, 'BTC');
    assert.ok(detail.asset.market.open && 'high24h' in detail.asset);
    assert.equal((await call('GET', '/markets/NOPE')).status, 404);
  } finally { server.close(); }
});

test('API: discovery returns ranked lists and validates the limit and category', async () => {
  const { server, make } = await setup();
  try {
    const call = await make('a@x.com');
    const d = (await call('GET', '/markets/discovery')).body;
    assert.ok(d.gainers.length <= 3 && d.losers.length <= 3);
    assert.equal(d.active.length, 3);
    assert.ok(d.gainers.every((a) => a.change24h > 0) && d.losers.every((a) => a.change24h < 0));
    assert.ok(d.asOf);
    assert.equal((await call('GET', '/markets/discovery?limit=1')).body.active.length, 1);
    assert.equal((await call('GET', '/markets/discovery?limit=10')).body.active.length, 10);
    for (const bad of ['0', '11', 'x', '1.5']) assert.equal((await call('GET', `/markets/discovery?limit=${bad}`)).status, 400, bad);
    const crypto = (await call('GET', '/markets/discovery?limit=10&category=crypto')).body;
    assert.deepEqual(syms(crypto.active).sort(), ['BTC', 'ETH', 'SOL']);
    assert.deepEqual((await call('GET', '/markets/discovery?category=bonds')).body.active, []);
  } finally { server.close(); }
});

test('API: compare two assets, with clear errors for bad input', async () => {
  const { server, make } = await setup();
  try {
    const call = await make('a@x.com');
    const ok = await call('GET', '/markets/compare?a=btc&b=ETH&range=1W');
    assert.equal(ok.status, 200);
    assert.deepEqual(syms(ok.body.assets), ['BTC', 'ETH']);
    assert.equal(ok.body.range, '1W');
    assert.equal(ok.body.series.BTC[0].value, 100);
    assert.equal(ok.body.series.ETH.length, 96);
    assert.ok('BTC' in ok.body.returnPct && 'ETH' in ok.body.returnPct);
    assert.equal((await call('GET', '/markets/compare?a=BTC&b=ETH')).body.range, '1D');
    assert.equal((await call('GET', '/markets/compare?a=BTC&b=BTC')).body.error, 'Choose two different assets');
    assert.equal((await call('GET', '/markets/compare?a=BTC&b=btc')).status, 400);
    assert.equal((await call('GET', '/markets/compare?a=BTC')).status, 400);
    assert.equal((await call('GET', '/markets/compare')).status, 400);
    assert.equal((await call('GET', '/markets/compare?a=BTC&b=NOPE')).status, 404);
    assert.equal((await call('GET', '/markets/compare?a=BTC&b=ETH&range=5Y')).status, 400);
  } finally { server.close(); }
});

test('API: recently viewed is newest first, de-duplicated, capped, private and clearable', async () => {
  const { server, make } = await setup();
  try {
    const call = await make('a@x.com');
    assert.deepEqual((await call('GET', '/recent')).body.assets, []);
    for (const s of ['BTC', 'ETH', 'SOL']) await call('PUT', `/recent/${s}`);
    assert.deepEqual(syms((await call('GET', '/recent')).body.assets), ['SOL', 'ETH', 'BTC']);
    await call('PUT', '/recent/btc'); // viewing again moves it to the front
    assert.deepEqual(syms((await call('GET', '/recent')).body.assets), ['BTC', 'SOL', 'ETH']);
    assert.ok('price' in (await call('GET', '/recent')).body.assets[0] && 'market' in (await call('GET', '/recent')).body.assets[0]);

    assert.equal((await call('PUT', '/recent/NOPE')).status, 404);
    for (const s of ['AAPL', 'TSLA', 'MSFT', 'EURUSD', 'GBPUSD', 'XAU', 'WTI']) await call('PUT', `/recent/${s}`);
    const capped = syms((await call('GET', '/recent')).body.assets);
    assert.equal(capped.length, 8, 'only the 8 most recent are kept');
    assert.deepEqual(capped.slice(0, 2), ['WTI', 'XAU']);
    assert.equal(capped.includes('ETH'), false, 'the oldest entries are dropped');

    const other = await make('b@x.com');
    assert.deepEqual((await other('GET', '/recent')).body.assets, []);
    await other('PUT', '/recent/ETH');
    assert.equal((await call('GET', '/recent')).body.assets.length, 8);
    assert.equal((await call('DELETE', '/recent')).status, 200);
    assert.deepEqual((await call('GET', '/recent')).body.assets, []);
    assert.deepEqual(syms((await other('GET', '/recent')).body.assets), ['ETH'], "clearing only affects your own history");
  } finally { server.close(); }
});

test('API: the markets endpoints require a login', async () => {
  const { server } = await setup();
  try {
    const base = `http://localhost:${server.address().port}/api`;
    for (const path of ['/markets', '/markets/discovery', '/markets/compare?a=BTC&b=ETH', '/recent', '/markets/meta']) {
      assert.equal((await fetch(base + path)).status, 401, path);
    }
  } finally { server.close(); }
});
