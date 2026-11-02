import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { z } from 'zod';
import { newSecret, verify as verifyTotp, otpauthUrl } from './totp.js';
import { notify } from './db.js';
import { consoleMailer, deliver } from './mail.js';
import { evaluateAchievements } from './achievements.js';
import { DEFAULT_LIMITS, rateLimiter } from './rateLimit.js';
import {
  SESSION_MS, consumeRecoveryCode, consumeResetToken, createResetToken, createSession, generateRecoveryCodes, isNewDevice,
  listSessions, loginHistory, recordLogin, recoveryStatus, revokeOthers, revokeSession, describeDevice,
} from './security.js';

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
export const LOCKOUT = { maxAttempts: 5, durationMs: 15 * 60e3 };

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
});
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  code: z.string().optional(),
  recoveryCode: z.string().optional(),
});
const newPassword = z.string().min(8).max(128);

export const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role,
  emailVerified: !!u.email_verified, kycStatus: u.kyc_status,
  suspended: !!u.suspended_at, twoFactorEnabled: !!u.totp_enabled, balance: u.balance, currency: u.currency,
});

// A request is authenticated by a signed token that names a live session. Revoking the session
// (log out, "log out other devices", a password reset) therefore ends it immediately.
export function requireAuth(db, secret, now = Date.now) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    try {
      const { sub, sid } = jwt.verify(h.replace(/^Bearer /, ''), secret);
      const t = now();
      const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sid ?? -1, sub);
      if (!session || session.revoked_at !== null || session.expires_at <= t) throw new Error('no session');
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sub);
      if (!user) throw new Error('no user');
      if (t - session.last_seen_at > 60e3) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(t, session.id);
      req.user = user;
      req.sessionId = session.id;
      next();
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

export const requireAdmin = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });

export function authRouter(db, { secret, log = console.log, mailer = consoleMailer(log), now = Date.now, limits = {}, lockout = {} }) {
  const r = Router();
  const auth = requireAuth(db, secret, now);
  const lock = { ...LOCKOUT, ...lockout };
  const limit = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([k, v]) => [k, rateLimiter({ ...v, ...limits[k], now })]));
  const appUrl = () => process.env.APP_URL || 'http://localhost:5173';
  const sign = (u, sid) => jwt.sign({ sub: u.id, sid }, secret, { expiresIn: Math.round(SESSION_MS / 1000) });
  const fresh = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const mail = (to, kind, subject, text, link) => deliver(mailer, { to, kind, subject, text, link });
  // A new session for the user, with its token.
  const startSession = (req, user) => ({ token: sign(user, createSession(db, req, user.id, now)), user: publicUser(user) });

  r.post('/register', limit.register, (req, res) => {
    const p = registerSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Invalid input', details: p.error.flatten().fieldErrors });
    const { name, email, password } = p.data;
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
      return res.status(409).json({ error: 'Email already registered' });
    const hash = bcrypt.hashSync(password, 10);
    const { lastInsertRowid: id } = db
      .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run(name, email, hash);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO email_tokens (token, user_id, expires_at) VALUES (?, ?, ?)')
      .run(token, id, now() + 24 * 3600 * 1000);
    // No mail provider yet: the default mailer prints the verification link to the console.
    mail(email, 'verify', 'Verify your email address', `Verify your email address: ${appUrl()}/verify-email?token=${token}`, `${appUrl()}/verify-email?token=${token}`);
    notify(db, id, 'security', 'Welcome! Please verify your email address.');
    recordLogin(db, req, { userId: id, email, success: true, reason: 'registered', now });
    res.status(201).json(startSession(req, fresh(id)));
  });

  // Records a failed attempt against a known account and locks it after too many in a row.
  function failLogin(req, res, user, email, reason) {
    recordLogin(db, req, { userId: user?.id, email, success: false, reason, now });
    if (user) {
      const failed = user.failed_logins + 1;
      if (failed >= lock.maxAttempts) {
        db.prepare('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?').run(now() + lock.durationMs, user.id);
        notify(db, user.id, 'security', `Your account was locked for ${Math.round(lock.durationMs / 60e3)} minutes after ${lock.maxAttempts} failed sign-in attempts.`);
        mail(user.email, 'account-locked', 'Your account was temporarily locked', `Too many failed sign-in attempts. Your account is locked for ${Math.round(lock.durationMs / 60e3)} minutes. If this was not you, reset your password.`);
        return lockedResponse(res, lock.durationMs);
      }
      db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(failed, user.id);
    }
    return res.status(401).json({ error: reason === 'bad_2fa' ? 'Invalid two-factor code' : 'Invalid email or password', ...(reason === 'bad_2fa' && { twoFactorRequired: true }) });
  }
  function lockedResponse(res, ms) {
    const retryAfterSeconds = Math.max(1, Math.ceil(ms / 1000));
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(423).json({ error: 'Too many failed attempts. This account is temporarily locked; try again later or reset your password.', locked: true, retryAfterSeconds });
  }

  r.post('/login', limit.login, (req, res) => {
    const p = loginSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Invalid input' });
    const { email, password, code, recoveryCode } = p.data;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user && user.locked_until && user.locked_until > now()) {
      recordLogin(db, req, { userId: user.id, email, success: false, reason: 'locked', now });
      return lockedResponse(res, user.locked_until - now());
    }
    // Always compare against a hash so unknown emails take as long as wrong passwords.
    const passwordOk = bcrypt.compareSync(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !passwordOk) return failLogin(req, res, user, email, 'bad_password');

    let usedRecovery = false;
    if (user.totp_enabled) {
      if (!code && !recoveryCode) return res.status(401).json({ error: 'Two-factor code required', twoFactorRequired: true });
      if (recoveryCode) {
        if (!consumeRecoveryCode(db, secret, user.id, recoveryCode, now)) return failLogin(req, res, user, email, 'bad_2fa');
        usedRecovery = true;
      } else if (!verifyTotp(user.totp_secret, code, now())) {
        return failLogin(req, res, user, email, 'bad_2fa');
      }
    }

    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
    const newDevice = isNewDevice(db, req, user.id);
    recordLogin(db, req, { userId: user.id, email, success: true, reason: usedRecovery ? 'recovery_code' : null, now });
    const session = startSession(req, fresh(user.id));
    if (newDevice) {
      const device = describeDevice(req.headers['user-agent']);
      notify(db, user.id, 'security', `New sign-in from ${device}. If this was not you, change your password and log out other devices.`);
      mail(user.email, 'new-device', 'New sign-in to your account', `We noticed a sign-in from a new device (${device}). If this was not you, reset your password: ${appUrl()}/forgot-password`);
    }
    let remaining;
    if (usedRecovery) {
      remaining = recoveryStatus(db, user.id, now).remaining;
      notify(db, user.id, 'security', `A two-factor recovery code was used to sign in. ${remaining} left.`);
    }
    res.json({ ...session, ...(usedRecovery && { recoveryCodesRemaining: remaining }) });
  });

  r.post('/logout', auth, (req, res) => {
    revokeSession(db, req.user.id, req.sessionId, now);
    res.json({ ok: true });
  });

  // ---- Forgotten password

  // Always answers the same way, so it cannot be used to find out which emails have accounts.
  r.post('/forgot-password', limit.forgotPassword, (req, res) => {
    const p = z.object({ email: z.string().trim().toLowerCase().email() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Invalid input' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(p.data.email);
    if (user) {
      const link = `${appUrl()}/reset-password?token=${createResetToken(db, user.id, now)}`;
      mail(user.email, 'password-reset', 'Reset your password', `Reset your password (this link works once and expires in 30 minutes): ${link}`, link);
    }
    res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.' });
  });

  r.post('/reset-password', limit.resetPassword, (req, res) => {
    const p = z.object({ token: z.string().min(1).max(200), password: newPassword }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Invalid input' });
    const userId = consumeResetToken(db, p.data.token, now);
    if (!userId) return res.status(400).json({ error: 'This reset link is invalid or has expired' });
    db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(bcrypt.hashSync(p.data.password, 10), userId);
    revokeOthers(db, userId, null, now); // everyone is signed out, including whoever may have had the old password
    notify(db, userId, 'security', 'Your password was reset and all devices were signed out.');
    mail(fresh(userId).email, 'password-changed', 'Your password was changed', 'Your password was just reset. If this was not you, contact support immediately.');
    res.json({ ok: true });
  });

  r.get('/verify-email', (req, res) => {
    const row = db.prepare('SELECT * FROM email_tokens WHERE token = ?').get(String(req.query.token || ''));
    if (!row || row.expires_at < now())
      return res.status(400).json({ error: 'Invalid or expired token' });
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
    db.prepare('DELETE FROM email_tokens WHERE user_id = ?').run(row.user_id);
    res.json({ ok: true });
  });

  r.get('/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  r.patch('/profile', auth, (req, res) => {
    const p = z.object({ name: z.string().trim().min(1).max(100), currency: z.enum(['USD', 'EUR', 'GBP']) })
      .partial().safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Invalid input' });
    const name = p.data.name ?? req.user.name;
    const currency = p.data.currency ?? req.user.currency;
    db.prepare('UPDATE users SET name = ?, currency = ? WHERE id = ?').run(name, currency, req.user.id);
    res.json({ user: publicUser(fresh(req.user.id)) });
  });

  r.post('/change-password', auth, (req, res) => {
    const p = z.object({ currentPassword: z.string(), newPassword }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Invalid input' });
    if (!bcrypt.compareSync(p.data.currentPassword, req.user.password_hash))
      return res.status(403).json({ error: 'Current password is incorrect' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(p.data.newPassword, 10), req.user.id);
    const out = revokeOthers(db, req.user.id, req.sessionId, now);
    notify(db, req.user.id, 'security', `Your password was changed${out ? ` and ${out} other device${out === 1 ? ' was' : 's were'} signed out` : ''}.`);
    res.json({ ok: true });
  });

  // ---- Active sessions and devices

  r.get('/sessions', auth, (req, res) => res.json({ sessions: listSessions(db, req.user.id, req.sessionId, now) }));

  r.post('/sessions/revoke-others', auth, (req, res) => res.json({ ok: true, revoked: revokeOthers(db, req.user.id, req.sessionId, now) }));

  r.delete('/sessions/:id', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !revokeSession(db, req.user.id, id, now)) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true, current: id === req.sessionId });
  });

  r.get('/login-history', auth, (req, res) => res.json({ events: loginHistory(db, req.user.id) }));

  // ---- Two-factor: setup stores a secret (not yet active); enable confirms with a code and issues recovery codes.
  r.post('/2fa/setup', auth, (req, res) => {
    if (req.user.totp_enabled) return res.status(409).json({ error: 'Two-factor already enabled' });
    const s = newSecret();
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(s, req.user.id);
    // The secret is shown once, here, so it can be added to an authenticator app. It is never returned again.
    res.json({ secret: s, otpauthUrl: otpauthUrl(s, req.user.email) });
  });

  r.post('/2fa/enable', auth, (req, res) => {
    if (!req.user.totp_secret || !verifyTotp(req.user.totp_secret, req.body?.code, now()))
      return res.status(400).json({ error: 'Invalid code' });
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.user.id);
    notify(db, req.user.id, 'security', 'Two-factor authentication enabled.');
    evaluateAchievements(db, req.user.id, now());
    res.json({ ok: true, recoveryCodes: generateRecoveryCodes(db, secret, req.user.id, now) });
  });

  // A current authenticator code or an unused recovery code proves possession of the second factor.
  const secondFactorOk = (user, body) =>
    verifyTotp(user.totp_secret, body?.code, now()) || (body?.recoveryCode && consumeRecoveryCode(db, secret, user.id, body.recoveryCode, now));

  r.post('/2fa/disable', auth, (req, res) => {
    if (!req.user.totp_enabled || !secondFactorOk(req.user, req.body)) return res.status(400).json({ error: 'Invalid code' });
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.user.id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.user.id);
    notify(db, req.user.id, 'security', 'Two-factor authentication disabled.');
    res.json({ ok: true });
  });

  r.get('/2fa/recovery-codes', auth, (req, res) => {
    if (!req.user.totp_enabled) return res.status(409).json({ error: 'Two-factor is not enabled' });
    res.json(recoveryStatus(db, req.user.id, now)); // counts only, never the codes
  });

  r.post('/2fa/recovery-codes', auth, (req, res) => {
    if (!req.user.totp_enabled) return res.status(409).json({ error: 'Two-factor is not enabled' });
    if (!verifyTotp(req.user.totp_secret, req.body?.code, now())) return res.status(400).json({ error: 'Invalid code' });
    notify(db, req.user.id, 'security', 'Your two-factor recovery codes were regenerated. Older codes no longer work.');
    res.json({ recoveryCodes: generateRecoveryCodes(db, secret, req.user.id, now) });
  });

  return r;
}
