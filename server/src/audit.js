// The administrator audit log: who did what, to whom, when, and the non-sensitive details.
// Rows are only ever added (the table refuses updates and deletes). Anything that looks like a secret is
// replaced before it is written, so a careless caller cannot leak passwords, tokens, TOTP secrets or identity documents.

const SENSITIVE = /pass(word|wd)?|token|secret|totp|otp|hash|document|recovery|dob|birth|authorization|cookie|national/i;
const MAX_TEXT = 300;

export function sanitizeDetails(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (typeof value !== 'object') return value;
  if (depth > 3) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeDetails(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : sanitizeDetails(v, depth + 1)]));
}

// Records one action by the signed-in administrator (req.user) against a target.
export async function recordAudit(db, req, now, { action, targetType = null, targetId = null, details = null }) {
  await db.prepare('INSERT INTO admin_audit (admin_id, admin_email, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, req.user.email, action, targetType, targetId === null ? null : String(targetId),
      details === null ? null : JSON.stringify(sanitizeDetails(details)), String(req.ip || '').replace(/^::ffff:/, ''), now);
}

const shape = (r) => ({
  id: r.id, at: r.created_at, admin: { id: r.admin_id, email: r.admin_email }, action: r.action,
  targetType: r.target_type, targetId: r.target_id, details: r.details ? JSON.parse(r.details) : null, ip: r.ip,
});

// Filters: admin (id), action (exact, or a prefix ending in '.'), targetType, targetId, from, to (ms). Newest first.
export async function queryAudit(db, { admin, action, targetType, targetId, from, to, limit = 100, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (admin !== undefined) { where.push('admin_id = ?'); args.push(admin); }
  if (action) {
    if (action.endsWith('.')) { where.push("substr(action, 1, ?) = ?"); args.push(action.length, action); } else { where.push('action = ?'); args.push(action); }
  }
  if (targetType) { where.push('target_type = ?'); args.push(targetType); }
  if (targetId !== undefined) { where.push('target_id = ?'); args.push(String(targetId)); }
  if (from !== undefined) { where.push('created_at >= ?'); args.push(from); }
  if (to !== undefined) { where.push('created_at <= ?'); args.push(to); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM admin_audit ${clause}`).get(...args)).n;
  const rows = await db.prepare(`SELECT * FROM admin_audit ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { total, entries: rows.map(shape) };
}
