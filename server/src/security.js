// Account security helpers: sessions and devices, login history, password-reset tokens and 2FA recovery codes.
// Secrets (reset tokens, recovery codes) are only ever stored as hashes, and are never read back out.
import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('hex');

export const SESSION_MS = 7 * 24 * 3600e3;
export const RESET_TOKEN_MS = 30 * 60e3;
export const RECOVERY_CODE_MS = 365 * 24 * 3600e3;
export const RECOVERY_CODE_COUNT = 10;

// ---- Devices

// A readable "Chrome on Windows" from a user-agent string (best effort; it is only a label).
export function describeDevice(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return browser && os ? `${browser} on ${os}` : browser || os || 'Unknown device';
}

// Identifies a browser across logins: the id the app stores in the browser, else a hash of the user agent.
export const deviceKey = (req) => {
  const id = String(req.headers['x-device-id'] || '').slice(0, 64);
  return sha256(id ? `id:${id}` : `ua:${req.headers['user-agent'] || ''}`);
};

const clientIp = (req) => String(req.ip || '').replace(/^::ffff:/, '');

// ---- Sessions

export async function createSession(db, req, userId, now) {
  const t = now();
  return Number((await db.prepare(
    'INSERT INTO sessions (user_id, device, ip, device_key, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(userId, describeDevice(req.headers['user-agent']), clientIp(req), deviceKey(req), t, t, t + SESSION_MS)).lastInsertRowid);
}

export async function listSessions(db, userId, currentId, now) {
  return (await db.prepare('SELECT id, device, ip, created_at, last_seen_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC, id DESC')
    .all(userId, now()))
    .map((s) => ({ id: s.id, device: s.device, ip: s.ip, createdAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.id === currentId }));
}

export const revokeSession = async (db, userId, id, now) =>
  (await db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(now(), id, userId)).changes > 0;

// Revokes every session of the user except `keepId` (pass null to revoke them all).
export const revokeOthers = async (db, userId, keepId, now) =>
  Number((await db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?').run(now(), userId, keepId ?? null)).changes);

// ---- Login history

export async function recordLogin(db, req, { userId, email, success, reason = null, now }) {
  await db.prepare('INSERT INTO login_events (user_id, email, success, reason, ip, device, device_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId ?? null, email, success ? 1 : 0, reason, clientIp(req), describeDevice(req.headers['user-agent']), deviceKey(req), now());
}

export const loginHistory = async (db, userId, limit = 50) =>
  (await db.prepare('SELECT id, success, reason, ip, device, created_at FROM login_events WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit))
    .map((e) => ({ id: e.id, success: !!e.success, reason: e.reason, ip: e.ip, device: e.device, at: e.created_at }));

// True when this user has signed in before, but never from this device.
export async function isNewDevice(db, req, userId) {
  const prior = await db.prepare('SELECT COUNT(*) AS n, SUM(device_key = ?) AS same FROM login_events WHERE user_id = ? AND success = 1').get(deviceKey(req), userId);
  return prior.n > 0 && !prior.same;
}

// ---- Password-reset tokens (stored hashed, single use, time limited)

export async function createResetToken(db, userId, now) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId); // a new request replaces any earlier link
  await db.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now(), now() + RESET_TOKEN_MS);
  return token;
}

// Returns the user id and marks the token used, or null if it is unknown, expired or already used.
export async function consumeResetToken(db, token, now) {
  const hash = sha256(String(token || ''));
  const row = await db.prepare('SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?').get(hash);
  if (!row || row.used_at !== null || row.expires_at <= now()) return null;
  const claimed = (await db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(now(), hash)).changes;
  return claimed ? row.user_id : null;
}

// ---- Two-factor recovery codes

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
const normalise = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Replaces all of the user's codes with a fresh set and returns the plain codes. This is the only time they are visible.
export async function generateRecoveryCodes(db, secret, userId, now) {
  await db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)');
  const codes = [];
  while (codes.length < RECOVERY_CODE_COUNT) {
    const raw = Array.from(crypto.randomBytes(10), (b) => CODE_ALPHABET[b % 32]).join('');
    if (codes.some((c) => normalise(c) === raw)) continue;
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
    await ins.run(userId, hmac(secret, raw), now(), now() + RECOVERY_CODE_MS);
  }
  return codes;
}

// Uses up one code. False if it is wrong, expired or already used.
export async function consumeRecoveryCode(db, secret, userId, code, now) {
  const n = normalise(code);
  if (n.length !== 10) return false;
  return (await db.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?')
    .run(now(), userId, hmac(secret, n), now())).changes > 0;
}

export async function recoveryStatus(db, userId, now) {
  const r = await db.prepare('SELECT COUNT(*) AS remaining, MIN(expires_at) AS expires FROM recovery_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > ?').get(userId, now());
  return { remaining: r.remaining, expiresAt: r.expires ?? null };
}
