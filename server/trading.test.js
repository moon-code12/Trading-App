import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { code } from './src/totp.js';

async function setup() {
  const db = await openDb(':memory:');
  const server = createApp(db, { secret: 's', log: () => {} }).listen(0);
  const base = `http://localhost:${server.address().port}/api`;
  let token;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const reg = await call('POST', '/auth/register', { name: 'T', email: 't@x.com', password: 'password1' });
  token = reg.body.token;
  return { db, server, call, setToken: (t) => (token = t) };
}

test('market buy/sell updates balance, holdings, transactions', async () => {
  const { server, call } = await setup();
  try {
    const buy = await call('POST', '/orders', { symbol: 'eth', side: 'buy', type: 'market', quantity: 1 });
    assert.equal(buy.status, 201);
    assert.equal(buy.body.order.status, 'filled');
    let pf = (await call('GET', '/portfolio')).body;
    assert.equal(pf.holdings.length, 1);
    assert.ok(pf.balance < 10000);
    assert.equal((await call('POST', '/orders', { symbol: 'BTC', side: 'buy', type: 'market', quantity: 100 })).status, 400);
    assert.equal((await call('POST', '/orders', { symbol: 'ETH', side: 'sell', type: 'market', quantity: 2 })).status, 400);
    assert.equal((await call('POST', '/orders', { symbol: 'ETH', side: 'sell', type: 'market', quantity: 1 })).status, 201);
    pf = (await call('GET', '/portfolio')).body;
    assert.equal(pf.holdings.length, 0);
    assert.equal((await call('GET', '/transactions')).body.transactions.length, 2);
  } finally { server.close(); }
});

test('limit orders stay pending, can be cancelled, and fill when triggered', async () => {
  const { server, call } = await setup();
  try {
    const far = await call('POST', '/orders', { symbol: 'AAPL', side: 'buy', type: 'limit', quantity: 1, price: 1 });
    assert.equal(far.body.order.status, 'pending');
    assert.equal((await call('DELETE', `/orders/${far.body.order.id}`)).status, 200);
    await call('POST', '/orders', { symbol: 'AAPL', side: 'buy', type: 'limit', quantity: 1, price: 1e6 });
    const list = (await call('GET', '/orders')).body.orders;
    assert.equal(list.find((o) => o.price === 1e6).status, 'filled');
    assert.equal((await call('POST', '/orders', { symbol: 'AAPL', side: 'buy', type: 'limit', quantity: 1 })).status, 400);
  } finally { server.close(); }
});

test('wallet, KYC and admin approval', async () => {
  const { db, server, call, setToken } = await setup();
  try {
    assert.equal((await call('POST', '/wallet/withdraw', { amount: 10 })).status, 403);
    assert.equal((await call('POST', '/wallet/deposit', { amount: 500 })).status, 200);
    const kyc = { fullName: 'Test User', dateOfBirth: '1990-01-01', country: 'US', documentType: 'passport', documentNumber: 'X1234567' };
    assert.equal((await call('POST', '/kyc', kyc)).status, 201);
    assert.equal((await call('POST', '/kyc', kyc)).status, 409);
    assert.equal((await call('GET', '/admin/stats')).status, 403);
    await db.prepare("UPDATE users SET role = 'admin'").run();
    const pending = (await call('GET', '/admin/kyc')).body.submissions;
    assert.equal((await call('POST', `/admin/kyc/${pending[0].id}/approve`)).status, 200);
    assert.equal((await call('POST', '/wallet/withdraw', { amount: 10 })).status, 202, 'a request, held until an administrator decides');
    assert.equal((await call('GET', '/wallet')).body.balance, 10490);
    assert.ok((await call('GET', '/notifications')).body.notifications.length >= 2);
  } finally { server.close(); }
});

test('password change and two-factor login', async () => {
  const { server, call } = await setup();
  try {
    assert.equal((await call('POST', '/auth/change-password', { currentPassword: 'nope', newPassword: 'newpassword1' })).status, 403);
    assert.equal((await call('POST', '/auth/change-password', { currentPassword: 'password1', newPassword: 'newpassword1' })).status, 200);
    const { body: { secret } } = await call('POST', '/auth/2fa/setup');
    assert.equal((await call('POST', '/auth/2fa/enable', { code: '000000' })).status, 400);
    assert.equal((await call('POST', '/auth/2fa/enable', { code: code(secret) })).status, 200);
    const noCode = await call('POST', '/auth/login', { email: 't@x.com', password: 'newpassword1' });
    assert.equal(noCode.status, 401);
    assert.equal(noCode.body.twoFactorRequired, true);
    const ok = await call('POST', '/auth/login', { email: 't@x.com', password: 'newpassword1', code: code(secret) });
    assert.equal(ok.status, 200);
  } finally { server.close(); }
});

test('candles endpoint returns consistent OHLC data per timeframe', async () => {
  const { server, call } = await setup();
  try {
    for (const [tf, n] of [['1H', 60], ['1D', 96], ['1W', 168], ['1M', 120]]) {
      const { status, body } = await call('GET', `/markets/btc/candles?tf=${tf}`);
      assert.equal(status, 200);
      assert.equal(body.candles.length, n);
      for (const c of body.candles) {
        assert.ok(c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close));
      }
      assert.ok(body.candles.every((c, i, a) => i === 0 || c.t > a[i - 1].t));
    }
    assert.equal((await call('GET', '/markets/btc/candles?tf=9Y')).status, 400);
    assert.equal((await call('GET', '/markets/nope/candles')).status, 404);
  } finally { server.close(); }
});

test('price alerts trigger once, notify, and can be deleted', async () => {
  const { server, call, db } = await setup();
  try {
    assert.equal((await call('POST', '/alerts', { symbol: 'BTC', direction: 'above', target: -1 })).status, 400);
    assert.equal((await call('POST', '/alerts', { symbol: 'NOPE', direction: 'above', target: 5 })).status, 400);
    const hit = await call('POST', '/alerts', { symbol: 'btc', direction: 'above', target: 1 });
    assert.equal(hit.status, 201);
    const miss = await call('POST', '/alerts', { symbol: 'BTC', direction: 'above', target: 1e9 });
    const list = (await call('GET', '/alerts')).body.alerts;
    assert.equal(list.find((a) => a.id === hit.body.alert.id).status, 'triggered');
    assert.equal(list.find((a) => a.id === miss.body.alert.id).status, 'active');
    const notes = (await call('GET', '/notifications')).body.notifications.filter((n) => n.kind === 'price');
    assert.equal(notes.length, 1);
    assert.equal((await call('DELETE', `/alerts/${hit.body.alert.id}`)).status, 404);
    assert.equal((await call('DELETE', `/alerts/${miss.body.alert.id}`)).status, 200);
  } finally { server.close(); }
});
