// A small in-memory fixed-window rate limiter for the authentication endpoints.
// State lives in this process only; put a shared store behind the same interface if the API is ever scaled out.

export function rateLimiter({ max, windowMs, now = Date.now, key = (req) => req.ip, message = 'Too many requests. Please try again later.' }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    const k = key(req);
    let h = hits.get(k);
    if (!h || h.resetAt <= t) { h = { count: 0, resetAt: t + windowMs }; hits.set(k, h); }
    h.count += 1;
    if (h.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((h.resetAt - t) / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: message, retryAfterSeconds });
    }
    next();
  };
}

export const DEFAULT_LIMITS = {
  login: { max: 20, windowMs: 15 * 60e3 },
  register: { max: 10, windowMs: 60 * 60e3 },
  forgotPassword: { max: 5, windowMs: 60 * 60e3 },
  resetPassword: { max: 10, windowMs: 60 * 60e3 },
};
