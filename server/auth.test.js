import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';

test('register, verify, login, me', async () => {
  const logs = [];
  const server = createApp(await openDb(':memory:'), { secret: 's', log: (m) => logs.push(m) }).listen(0);
  const base = `http://localhost:${server.address().port}/api/auth`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  try {
    const reg = await post('/register', { name: 'A', email: 'A@x.com', password: 'password1' });
    assert.equal(reg.status, 201);
    const { token } = await reg.json();
    assert.equal((await post('/register', { name: 'A', email: 'a@x.com', password: 'password1' })).status, 409);
    assert.equal((await post('/login', { email: 'a@x.com', password: 'bad' })).status, 401);
    assert.equal((await post('/login', { email: 'a@x.com', password: 'password1' })).status, 200);
    const vt = logs[0].match(/token=(\w+)/)[1];
    assert.equal((await fetch(`${base}/verify-email?token=${vt}`)).status, 200);
    const me = await (await fetch(base + '/me', { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(me.user.emailVerified, true);
    assert.equal((await fetch(base + '/me')).status, 401);
  } finally { server.close(); }
});
