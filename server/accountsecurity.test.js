import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { code } from './src/totp.js';
import { rateLimiter } from './src/rateLimit.js';
import { describeDevice } from './src/security.js';
import { consoleMailer, deliver } from './src/mail.js';

const MIN = 60e3;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';

// A running app with a controllable clock and a recording mailer.
async function setup(opts = {}) {
  const db = openDb(':memory:');
  const clock = { t: Date.UTC(2026, 0, 1, 12, 0, 0) };
  const mails = [];
  const server = createApp(db, { secret: 's', now: () => clock.t, mailer: { send: (m) => mails.push(m) }, ...opts }).listen(0);
  const base = `http://localhost:${server.address().port}/api/auth`;
  const call = async (method, path, body, { token, ua = CHROME, device } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json', 'user-agent': ua,
        ...(device && { 'x-device-id': device }), ...(token && { authorization: `Bearer ${token}` }),
      },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const register = async (email = 'a@x.com', password = 'password1') => (await call('POST', '/register', { name: 'A', email, password })).body.token;
  const lastMail = (kind) => [...mails].reverse().find((m) => m.kind === kind);
  return { db, server, clock, mails, call, register, lastMail };
}
const tokenOf = (link) => new URL(link).searchParams.get('token');
const login = (ctx, password = 'password1', extra = {}, opts) => ctx.call('POST', '/login', { email: 'a@x.com', password, ...extra }, opts);

// ------------------------------------------------------------------ password reset

test('password reset: the link works once, sets the new password and signs every device out', async () => {
  const ctx = await setup();
  try {
    const token = await ctx.register();
    const second = (await login(ctx, 'password1', {}, { device: 'laptop' })).body.token;
    assert.equal((await ctx.call('POST', '/forgot-password', { email: 'a@x.com' })).status, 200);
    const mail = ctx.lastMail('password-reset');
    assert.equal(mail.to, 'a@x.com');
    const reset = tokenOf(mail.link);

    assert.equal((await ctx.call('POST', '/reset-password', { token: reset, password: 'short' })).status, 400, 'weak password refused, token not spent');
    assert.equal((await ctx.call('POST', '/reset-password', { token: reset, password: 'brand-new-pass' })).status, 200);
    assert.equal((await ctx.call('POST', '/reset-password', { token: reset, password: 'another-pass-1' })).status, 400, 'single use');

    assert.equal((await login(ctx, 'password1')).status, 401, 'old password is gone');
    assert.equal((await login(ctx, 'brand-new-pass')).status, 200);
    for (const t of [token, second]) assert.equal((await ctx.call('GET', '/me', null, { token: t })).status, 401, 'old sessions are revoked');
    assert.ok(ctx.lastMail('password-changed'));
  } finally { ctx.server.close(); }
});

test('password reset: tokens expire after 30 minutes and a newer request replaces an older one', async () => {
  const ctx = await setup();
  try {
    await ctx.register();
    await ctx.call('POST', '/forgot-password', { email: 'a@x.com' });
    const first = tokenOf(ctx.lastMail('password-reset').link);
    ctx.clock.t += 31 * MIN;
    assert.equal((await ctx.call('POST', '/reset-password', { token: first, password: 'brand-new-pass' })).status, 400, 'expired');

    await ctx.call('POST', '/forgot-password', { email: 'a@x.com' });
    const older = tokenOf(ctx.lastMail('password-reset').link);
    await ctx.call('POST', '/forgot-password', { email: 'a@x.com' });
    const newer = tokenOf(ctx.lastMail('password-reset').link);
    assert.notEqual(older, newer);
    assert.equal((await ctx.call('POST', '/reset-password', { token: older, password: 'brand-new-pass' })).status, 400, 'replaced');
    ctx.clock.t += 29 * MIN;
    assert.equal((await ctx.call('POST', '/reset-password', { token: newer, password: 'brand-new-pass' })).status, 200, 'still valid just inside the limit');
  } finally { ctx.server.close(); }
});

test('password reset: tokens are stored hashed, and unknown emails get the same answer without any email', async () => {
  const ctx = await setup();
  try {
    await ctx.register();
    const known = await ctx.call('POST', '/forgot-password', { email: 'a@x.com' });
    const reset = tokenOf(ctx.lastMail('password-reset').link);
    const rows = ctx.db.prepare('SELECT * FROM password_resets').all();
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes(reset), 'the plain token is not in the database');
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);

    const before = ctx.mails.length;
    const unknown = await ctx.call('POST', '/forgot-password', { email: 'nobody@x.com' });
    assert.equal(unknown.status, known.status);
    assert.deepEqual(unknown.body, known.body);
    assert.equal(ctx.mails.length, before, 'nothing sent to an unknown address');
    assert.equal((await ctx.call('POST', '/reset-password', { token: 'made-up', password: 'brand-new-pass' })).status, 400);
    assert.equal((await ctx.call('POST', '/forgot-password', { email: 'not an email' })).status, 400);
  } finally { ctx.server.close(); }
});

test('password reset: also lifts an account lockout', async () => {
  const ctx = await setup({ lockout: { maxAttempts: 2 } });
  try {
    await ctx.register();
    await login(ctx, 'bad1'); await login(ctx, 'bad2');
    assert.equal((await login(ctx, 'password1')).status, 423);
    await ctx.call('POST', '/forgot-password', { email: 'a@x.com' });
    await ctx.call('POST', '/reset-password', { token: tokenOf(ctx.lastMail('password-reset').link), password: 'brand-new-pass' });
    assert.equal((await login(ctx, 'brand-new-pass')).status, 200);
  } finally { ctx.server.close(); }
});

// ------------------------------------------------------------------ sessions and devices

test('sessions: listed with device details, and one device can be logged out', async () => {
  const ctx = await setup();
  try {
    const desktop = await ctx.register();
    const phone = (await login(ctx, 'password1', {}, { ua: PHONE, device: 'phone' })).body.token;
    const list = (await ctx.call('GET', '/sessions', null, { token: desktop })).body.sessions;
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((s) => s.device).sort(), ['Chrome on Windows', 'Safari on iOS']);
    assert.equal(list.filter((s) => s.current).length, 1);
    assert.equal(list.find((s) => s.current).device, 'Chrome on Windows');

    const phoneId = list.find((s) => s.device === 'Safari on iOS').id;
    assert.equal((await ctx.call('DELETE', `/sessions/${phoneId}`, null, { token: desktop })).status, 200);
    assert.equal((await ctx.call('GET', '/me', null, { token: phone })).status, 401, 'that device is out immediately');
    assert.equal((await ctx.call('GET', '/me', null, { token: desktop })).status, 200, 'the other is untouched');
    assert.equal((await ctx.call('DELETE', `/sessions/${phoneId}`, null, { token: desktop })).status, 404, 'already revoked');
    assert.equal((await ctx.call('DELETE', '/sessions/abc', null, { token: desktop })).status, 404);
  } finally { ctx.server.close(); }
});

test('sessions: log out all other devices keeps only the current one', async () => {
  const ctx = await setup();
  try {
    const a = await ctx.register();
    const b = (await login(ctx)).body.token;
    const c = (await login(ctx)).body.token;
    const res = await ctx.call('POST', '/sessions/revoke-others', null, { token: b });
    assert.equal(res.body.revoked, 2);
    assert.equal((await ctx.call('GET', '/me', null, { token: a })).status, 401);
    assert.equal((await ctx.call('GET', '/me', null, { token: c })).status, 401);
    assert.equal((await ctx.call('GET', '/me', null, { token: b })).status, 200);
    assert.equal((await ctx.call('GET', '/sessions', null, { token: b })).body.sessions.length, 1);
  } finally { ctx.server.close(); }
});

test('sessions: users cannot see or end each other\'s sessions, and logout ends the current one', async () => {
  const ctx = await setup();
  try {
    const mine = await ctx.register('a@x.com');
    const theirs = await ctx.register('b@x.com');
    const theirId = (await ctx.call('GET', '/sessions', null, { token: theirs })).body.sessions[0].id;
    assert.equal((await ctx.call('DELETE', `/sessions/${theirId}`, null, { token: mine })).status, 404);
    assert.equal((await ctx.call('GET', '/me', null, { token: theirs })).status, 200);
    assert.equal((await ctx.call('POST', '/logout', null, { token: mine })).status, 200);
    assert.equal((await ctx.call('GET', '/me', null, { token: mine })).status, 401);
    assert.equal((await ctx.call('GET', '/sessions')).status, 401);
  } finally { ctx.server.close(); }
});

test('sessions: expire after seven days, and tokens without a live session are refused', async () => {
  const ctx = await setup();
  try {
    const token = await ctx.register();
    ctx.clock.t += 6 * 24 * 60 * MIN;
    assert.equal((await ctx.call('GET', '/me', null, { token })).status, 200);
    ctx.clock.t += 2 * 24 * 60 * MIN;
    assert.equal((await ctx.call('GET', '/me', null, { token })).status, 401);
    const jwt = (await import('jsonwebtoken')).default;
    assert.equal((await ctx.call('GET', '/me', null, { token: jwt.sign({ sub: 1 }, 's') })).status, 401, 'a signed token with no session is not enough');
  } finally { ctx.server.close(); }
});

test('sessions: changing the password signs out the other devices only', async () => {
  const ctx = await setup();
  try {
    const a = await ctx.register();
    const b = (await login(ctx)).body.token;
    assert.equal((await ctx.call('POST', '/change-password', { currentPassword: 'password1', newPassword: 'password2' }, { token: a })).status, 200);
    assert.equal((await ctx.call('GET', '/me', null, { token: b })).status, 401);
    assert.equal((await ctx.call('GET', '/me', null, { token: a })).status, 200);
  } finally { ctx.server.close(); }
});

// ------------------------------------------------------------------ login history and new devices

test('login history: successes and failures are recorded for the account owner only', async () => {
  const ctx = await setup();
  try {
    const token = await ctx.register();
    await login(ctx, 'wrong');
    await login(ctx, 'password1', {}, { ua: PHONE });
    const other = await ctx.register('b@x.com');
    const events = (await ctx.call('GET', '/login-history', null, { token })).body.events;
    assert.deepEqual(events.map((e) => [e.success, e.reason]), [[true, null], [false, 'bad_password'], [true, 'registered']], 'newest first');
    assert.equal(events[0].device, 'Safari on iOS');
    assert.equal((await ctx.call('GET', '/login-history', null, { token: other })).body.events.length, 1);
    assert.equal((await ctx.call('GET', '/login-history')).status, 401);
  } finally { ctx.server.close(); }
});

test('new-device notification: sent for an unfamiliar device only', async () => {
  const ctx = await setup();
  try {
    const token = await ctx.register();
    await login(ctx);
    assert.equal(ctx.lastMail('new-device'), undefined, 'the browser used to register is a known device');
    await login(ctx, 'password1', {}, { ua: PHONE, device: 'phone' });
    const mail = ctx.lastMail('new-device');
    assert.ok(mail && mail.to === 'a@x.com' && /Safari on iOS/.test(mail.text));
    const notes = ctx.db.prepare("SELECT message FROM notifications WHERE kind = 'security' AND message LIKE 'New sign-in%'").all();
    assert.equal(notes.length, 1);
    const count = ctx.mails.filter((m) => m.kind === 'new-device').length;
    await login(ctx, 'password1', {}, { ua: PHONE, device: 'phone' });
    assert.equal(ctx.mails.filter((m) => m.kind === 'new-device').length, count, 'no repeat for the same device');
    assert.ok(token);
  } finally { ctx.server.close(); }
});

// ------------------------------------------------------------------ lockout

test('lockout: five failed logins lock the account, even for the right password, until the time is up', async () => {
  const ctx = await setup();
  try {
    await ctx.register();
    for (let i = 0; i < 4; i++) assert.equal((await login(ctx, `wrong${i}`)).status, 401);
    const fifth = await login(ctx, 'wrong4');
    assert.equal(fifth.status, 423);
    assert.equal(fifth.body.locked, true);
    assert.equal(fifth.headers.get('retry-after'), String(15 * 60));
    assert.ok(ctx.lastMail('account-locked'));

    const blocked = await login(ctx, 'password1');
    assert.equal(blocked.status, 423, 'the right password does not get in while locked');
    ctx.clock.t += 10 * MIN;
    const stillBlocked = await login(ctx, 'password1');
    assert.equal(stillBlocked.status, 423);
    assert.equal(stillBlocked.body.retryAfterSeconds, 5 * 60);

    ctx.clock.t += 5 * MIN;
    assert.equal((await login(ctx, 'password1')).status, 200);
    const reasons = ctx.db.prepare('SELECT reason FROM login_events WHERE success = 0').all().map((r) => r.reason);
    assert.ok(reasons.includes('locked'));
  } finally { ctx.server.close(); }
});

test('lockout: a successful login resets the count, and failures are per account', async () => {
  const ctx = await setup();
  try {
    await ctx.register('a@x.com');
    await ctx.register('b@x.com');
    for (let i = 0; i < 4; i++) await login(ctx, 'wrong');
    assert.equal((await login(ctx, 'password1')).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await login(ctx, 'wrong')).status, 401, 'count started again from zero');
    assert.equal((await ctx.call('POST', '/login', { email: 'b@x.com', password: 'password1' })).status, 200, 'other accounts unaffected');
    assert.equal((await ctx.call('POST', '/login', { email: 'ghost@x.com', password: 'x' })).status, 401, 'unknown emails just fail');
  } finally { ctx.server.close(); }
});

test('lockout: wrong two-factor codes count too', async () => {
  const ctx = await setup({ lockout: { maxAttempts: 3 } });
  try {
    const token = await ctx.register();
    const { body } = await ctx.call('POST', '/2fa/setup', null, { token });
    await ctx.call('POST', '/2fa/enable', { code: code(body.secret, ctx.clock.t) }, { token });
    const first = await login(ctx, 'password1');
    assert.equal(first.body.twoFactorRequired, true, 'asking for the code is not a failure');
    assert.equal((await login(ctx, 'password1', { code: '000000' })).status, 401);
    assert.equal((await login(ctx, 'password1', { code: '000001' })).status, 401);
    assert.equal((await login(ctx, 'password1', { code: '000002' })).status, 423);
  } finally { ctx.server.close(); }
});

// ------------------------------------------------------------------ recovery codes

async function withTwoFactor(ctx) {
  const token = await ctx.register();
  const { body } = await ctx.call('POST', '/2fa/setup', null, { token });
  const enabled = await ctx.call('POST', '/2fa/enable', { code: code(body.secret, ctx.clock.t) }, { token });
  return { token, secret: body.secret, codes: enabled.body.recoveryCodes };
}

test('recovery codes: issued once when two-factor is enabled, stored only as hashes', async () => {
  const ctx = await setup();
  try {
    const { token, codes } = await withTwoFactor(ctx);
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const c of codes) assert.match(c, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const stored = JSON.stringify(ctx.db.prepare('SELECT * FROM recovery_codes').all());
    for (const c of codes) assert.ok(!stored.includes(c.replace('-', '')), 'no plain codes in the database');
    const status = await ctx.call('GET', '/2fa/recovery-codes', null, { token });
    assert.equal(status.body.remaining, 10);
    assert.ok(!JSON.stringify(status.body).includes(codes[0]), 'the codes are never returned again');
  } finally { ctx.server.close(); }
});

test('recovery codes: each works once in place of an authenticator code', async () => {
  const ctx = await setup();
  try {
    const { codes } = await withTwoFactor(ctx);
    const used = await login(ctx, 'password1', { recoveryCode: codes[0].toLowerCase() }); // case and dash are forgiven
    assert.equal(used.status, 200);
    assert.equal(used.body.recoveryCodesRemaining, 9);
    assert.ok(ctx.db.prepare("SELECT 1 FROM notifications WHERE message LIKE '%recovery code was used%'").get());
    assert.equal((await login(ctx, 'password1', { recoveryCode: codes[0] })).status, 401, 'already used');
    assert.equal((await login(ctx, 'password1', { recoveryCode: codes[1].replace('-', '') })).status, 200);
    assert.equal((await login(ctx, 'password1', { recoveryCode: 'AAAAA-BBBBB' })).status, 401);
    assert.equal((await login(ctx, 'wrongpass', { recoveryCode: codes[2] })).status, 401, 'the password is still required');
    assert.equal((await login(ctx, 'password1', { recoveryCode: codes[2] })).status, 200, 'and that code was not spent by the failed attempt');
  } finally { ctx.server.close(); }
});

test('recovery codes: expire after a year', async () => {
  const ctx = await setup();
  try {
    const { token, codes } = await withTwoFactor(ctx);
    ctx.clock.t += 364 * 24 * 60 * MIN;
    const inTime = await login(ctx, 'password1', { recoveryCode: codes[5] });
    assert.equal(inTime.status, 200, 'still valid a day before the year is up');
    assert.equal(inTime.body.recoveryCodesRemaining, 9);
    ctx.clock.t += 2 * 24 * 60 * MIN;
    assert.equal((await login(ctx, 'password1', { recoveryCode: codes[0] })).status, 401, 'expired');
    assert.ok(token);
  } finally { ctx.server.close(); }
});

test('recovery codes: regenerating needs a current code and replaces the old set', async () => {
  const ctx = await setup();
  try {
    const { token, secret, codes } = await withTwoFactor(ctx);
    assert.equal((await ctx.call('POST', '/2fa/recovery-codes', { code: '123456' }, { token })).status, 400);
    assert.equal((await ctx.call('POST', '/2fa/recovery-codes', {}, { token })).status, 400);
    const fresh = await ctx.call('POST', '/2fa/recovery-codes', { code: code(secret, ctx.clock.t) }, { token });
    assert.equal(fresh.body.recoveryCodes.length, 10);
    assert.equal((await login(ctx, 'password1', { recoveryCode: codes[0] })).status, 401, 'old codes stop working');
    assert.equal((await login(ctx, 'password1', { recoveryCode: fresh.body.recoveryCodes[0] })).status, 200);
  } finally { ctx.server.close(); }
});

test('recovery codes: can switch two-factor off, which also deletes them; none without two-factor', async () => {
  const ctx = await setup();
  try {
    const { token, codes } = await withTwoFactor(ctx);
    assert.equal((await ctx.call('POST', '/2fa/disable', { recoveryCode: 'AAAAA-BBBBB' }, { token })).status, 400);
    assert.equal((await ctx.call('POST', '/2fa/disable', { recoveryCode: codes[0] }, { token })).status, 200);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM recovery_codes').get().n, 0);
    assert.equal((await ctx.call('GET', '/2fa/recovery-codes', null, { token })).status, 409);
    assert.equal((await login(ctx)).status, 200, 'no second factor needed any more');
  } finally { ctx.server.close(); }
});

// ------------------------------------------------------------------ rate limiting

test('rate limiting: login attempts per address are capped, with a Retry-After header', async () => {
  const ctx = await setup({ limits: { login: { max: 3, windowMs: 10 * MIN } } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await ctx.call('POST', '/login', { email: `u${i}@x.com`, password: 'x' })).status, 401);
    const limited = await ctx.call('POST', '/login', { email: 'u9@x.com', password: 'x' });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), String(10 * 60));
    assert.equal(limited.body.retryAfterSeconds, 600);
    ctx.clock.t += 10 * MIN + 1;
    assert.equal((await ctx.call('POST', '/login', { email: 'u9@x.com', password: 'x' })).status, 401, 'the window reopens');
  } finally { ctx.server.close(); }
});

test('rate limiting: forgot-password, reset-password and register have their own limits', async () => {
  const ctx = await setup({ limits: { forgotPassword: { max: 2 }, resetPassword: { max: 1 }, register: { max: 1 } } });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await ctx.call('POST', '/forgot-password', { email: 'a@x.com' })).status, 200);
    assert.equal((await ctx.call('POST', '/forgot-password', { email: 'a@x.com' })).status, 429);
    assert.equal((await ctx.call('POST', '/reset-password', { token: 'x', password: 'password1' })).status, 400);
    assert.equal((await ctx.call('POST', '/reset-password', { token: 'x', password: 'password1' })).status, 429);
    await ctx.register();
    assert.equal((await ctx.call('POST', '/register', { name: 'B', email: 'b@x.com', password: 'password1' })).status, 429);
  } finally { ctx.server.close(); }
});

test('rate limiter: counts per key and forgets old windows', () => {
  let t = 0;
  const limiter = rateLimiter({ max: 2, windowMs: 1000, now: () => t, key: (req) => req.key });
  const hit = (key) => {
    const res = { code: 200, headers: {}, set(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json() { return this; } };
    let passed = false;
    limiter({ key }, res, () => { passed = true; });
    return passed;
  };
  assert.deepEqual([hit('a'), hit('a'), hit('a'), hit('b')], [true, true, false, true]);
  t = 1000;
  assert.equal(hit('a'), true);
});

// ------------------------------------------------------------------ secrets never leave the server

test('no response contains password hashes, TOTP secrets, reset-token hashes or recovery-code hashes', async () => {
  const ctx = await setup();
  try {
    const { token } = await withTwoFactor(ctx);
    await ctx.call('POST', '/forgot-password', { email: 'a@x.com' });
    const secrets = ctx.db.prepare('SELECT password_hash, totp_secret FROM users').get();
    const resetHash = ctx.db.prepare('SELECT token_hash FROM password_resets').get().token_hash;
    const codeHashes = ctx.db.prepare('SELECT code_hash FROM recovery_codes').all().map((r) => r.code_hash);
    const forbidden = [secrets.password_hash, secrets.totp_secret, resetHash, ...codeHashes];
    const responses = [
      await ctx.call('GET', '/me', null, { token }),
      await login(ctx, 'password1', { code: code(secrets.totp_secret, ctx.clock.t) }),
      await ctx.call('GET', '/sessions', null, { token }),
      await ctx.call('GET', '/login-history', null, { token }),
      await ctx.call('GET', '/2fa/recovery-codes', null, { token }),
      await ctx.call('POST', '/forgot-password', { email: 'a@x.com' }),
      await ctx.call('PATCH', '/profile', { name: 'New' }, { token }),
    ];
    for (const r of responses) {
      const text = JSON.stringify(r.body);
      for (const f of forbidden) assert.ok(!text.includes(f), `leaked ${f.slice(0, 8)}… in ${text.slice(0, 80)}`);
      assert.ok(!/password_hash|totp_secret|token_hash|code_hash/.test(text));
    }
  } finally { ctx.server.close(); }
});

// ------------------------------------------------------------------ mail interface and helpers

test('mail: the console mailer prints the link, and a failing provider never breaks the caller', async () => {
  const lines = [];
  consoleMailer((l) => lines.push(l)).send({ to: 'a@x.com', kind: 'password-reset', subject: 'Reset', text: 'Reset it', link: 'http://x/reset?token=abc' });
  assert.deepEqual(lines, ['[email] password-reset a@x.com: http://x/reset?token=abc']);

  const errors = [];
  deliver({ send() { throw new Error('sync boom'); } }, { kind: 'k' }, (...a) => errors.push(a));
  deliver({ send: async () => { throw new Error('async boom'); } }, { kind: 'k' }, (...a) => errors.push(a));
  await new Promise((r) => setImmediate(r));
  assert.equal(errors.length, 2);

  const ctx = await setup({ mailer: { send() { throw new Error('provider down'); } } });
  try {
    assert.equal((await ctx.call('POST', '/register', { name: 'A', email: 'a@x.com', password: 'password1' })).status, 201);
    assert.equal((await ctx.call('POST', '/forgot-password', { email: 'a@x.com' })).status, 200);
  } finally { ctx.server.close(); }
});

test('mail: with no mailer given, emails go to the log function', async () => {
  const logs = [];
  const server = createApp(openDb(':memory:'), { secret: 's', log: (m) => logs.push(m) }).listen(0);
  try {
    const base = `http://localhost:${server.address().port}/api/auth`;
    const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    await post('/register', { name: 'A', email: 'a@x.com', password: 'password1' });
    await post('/forgot-password', { email: 'a@x.com' });
    assert.ok(logs.some((l) => /^\[email\] verify a@x\.com: .*\/verify-email\?token=/.test(l)));
    assert.ok(logs.some((l) => /^\[email\] password-reset a@x\.com: .*\/reset-password\?token=[0-9a-f]{64}$/.test(l)));
  } finally { server.close(); }
});

test('describeDevice: readable labels from user agents', () => {
  assert.equal(describeDevice(CHROME), 'Chrome on Windows');
  assert.equal(describeDevice(PHONE), 'Safari on iOS');
  assert.equal(describeDevice('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0'), 'Firefox on Linux');
  assert.equal(describeDevice(''), 'Unknown device');
  assert.equal(describeDevice(undefined), 'Unknown device');
});
