import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { ASSET_DEFINITIONS, validateAsset } from './src/catalog.js';
import { ASSETS, addAsset, categories, getAsset, priceAt, searchAssets, snapshot } from './src/market.js';
import { placeOrder } from './src/trading.js';
import { SESSIONS } from './src/sessions.js';

const good = { symbol: 'NVDA', name: 'NVIDIA Corp.', category: 'stocks', base: 900, liquidity: 20, risk: 'high', volume: 40000000, session: 'us-equities' };

test('catalogue: every shipped asset is valid and uses a known session', () => {
  const seen = [];
  for (const def of ASSET_DEFINITIONS) {
    validateAsset(def, seen);
    seen.push(def);
    assert.ok(SESSIONS[def.session]);
  }
  assert.equal(ASSETS.length, ASSET_DEFINITIONS.length);
});

test('catalogue: bad definitions are rejected with a clear reason', () => {
  const bad = (patch, re) => assert.throws(() => validateAsset({ ...good, ...patch }, ASSETS), re);
  bad({ symbol: 'btc' }, /symbol must be/);
  bad({ symbol: 'X' }, /symbol must be/);
  bad({ symbol: 'TOO-LONG-SYMBOL' }, /symbol must be/);
  bad({ symbol: 'BTC' }, /already exists/);
  bad({ name: '  ' }, /name is required/);
  bad({ category: 'Stocks' }, /category must be/);
  bad({ category: '' }, /category must be/);
  bad({ base: 0 }, /base price/);
  bad({ base: -5 }, /base price/);
  bad({ base: NaN }, /base price/);
  bad({ liquidity: 0 }, /liquidity/);
  bad({ volume: 'lots' }, /volume/);
  bad({ risk: 'extreme' }, /risk must be/);
  bad({ session: 'mars' }, /unknown session "mars"/);
  assert.throws(() => validateAsset(null, []), /symbol must be/);
  assert.equal(ASSETS.length, ASSET_DEFINITIONS.length, 'nothing invalid was added');
});

test('catalogue: one new entry flows through search, categories, stats, status, the API and trading', async () => {
  addAsset(good);
  addAsset({ ...good, symbol: 'US10Y', name: 'US 10-Year Treasury', category: 'bonds', base: 98.4, risk: 'low', volume: 5e6, liquidity: 500, session: 'always' });
  assert.throws(() => addAsset(good), /already exists/);

  assert.ok(getAsset('NVDA'));
  assert.ok(priceAt(getAsset('NVDA')) > 0);
  assert.deepEqual(searchAssets({ q: 'nvidia' }).map((a) => a.symbol), ['NVDA']);
  assert.deepEqual(categories(), ['crypto', 'stocks', 'forex', 'commodities', 'bonds']);
  const snap = snapshot(getAsset('NVDA'), Date.parse('2026-03-09T15:00:00Z'));
  assert.equal(snap.market.open, true);
  assert.ok(snap.volume24h > 0 && snap.high24h >= snap.low24h);
  assert.equal(snapshot(getAsset('US10Y'), Date.parse('2026-03-14T12:00:00Z')).market.open, true);

  const db = await openDb(':memory:');
  const server = createApp(db, { secret: 's', log: () => {} }).listen(0);
  const base = `http://localhost:${server.address().port}/api`;
  try {
    const reg = await (await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'T', email: 't@x.com', password: 'password1' }),
    })).json();
    const get = async (path) => (await fetch(base + path, { headers: { authorization: `Bearer ${reg.token}` } })).json();
    const list = (await get('/markets')).assets.map((a) => a.symbol);
    assert.ok(list.includes('NVDA') && list.includes('US10Y'));
    assert.deepEqual((await get('/markets?category=bonds')).assets.map((a) => a.symbol), ['US10Y']);
    assert.deepEqual((await get('/markets?q=treasury')).assets.map((a) => a.symbol), ['US10Y']);
    assert.ok((await get('/markets/meta')).categories.some((c) => c.id === 'bonds' && c.count === 1));
    assert.equal((await get('/markets/compare?a=NVDA&b=AAPL')).assets.length, 2);
    assert.ok((await get('/markets/discovery?limit=10')).active.some((a) => a.symbol === 'NVDA' || a.symbol === 'US10Y' || a.symbol === 'AAPL'));
    const bought = await placeOrder(db, { id: reg.user.id }, { symbol: 'NVDA', side: 'buy', type: 'market', quantity: 2 }, Date.now(), { confirmLarge: true });
    assert.equal(bought.order.status, 'filled');
    const m = await get('/markets/NVDA');
    assert.equal(m.asset.symbol, 'NVDA');
  } finally { server.close(); }
});
