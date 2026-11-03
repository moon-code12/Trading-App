import bcrypt from 'bcryptjs';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { matchPending } from './trading.js';
import { ensureWeekly, settleChallenges } from './challenges.js';

// Opens the database, creates the first admin if asked to, and builds the Express app.
// `jobs: 'lazy'` runs the background work on incoming requests (serverless); otherwise the caller schedules it.
export async function boot({ jobs, waitUntil } = {}) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required (e.g. JWT_SECRET=$(openssl rand -hex 32))');
  const db = await openDb();

  // Optional first admin: set ADMIN_EMAIL and ADMIN_PASSWORD.
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD && !(await db.prepare('SELECT 1 FROM users WHERE email = ?').get(ADMIN_EMAIL.toLowerCase()))) {
    await db.prepare("INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ('Admin', ?, ?, 'admin', 1)")
      .run(ADMIN_EMAIL.toLowerCase(), bcrypt.hashSync(ADMIN_PASSWORD, 10));
  }

  const runOrders = async () => await matchPending(db);
  const runChallenges = async () => { const t = Date.now(); await ensureWeekly(db, t); await settleChallenges(db, t); };
  const lazy = jobs === 'lazy' && throttled(runOrders, 1e3, runChallenges, 60e3);
  const app = createApp(db, { secret, simulation: process.env.SIM_PROFILE || 'realistic', jobs: lazy || undefined, waitUntil });
  return { app, db, runOrders, runChallenges };
}

// Serverless has no timers, so work that used to run on a timer runs when a request arrives, at most once per interval.
function throttled(orders, ordersMs, challenges, challengesMs) {
  let lastOrders = 0;
  let lastChallenges = 0;
  return async () => {
    const t = Date.now();
    if (t - lastOrders >= ordersMs) { lastOrders = t; await orders(); }
    if (t - lastChallenges >= challengesMs) { lastChallenges = t; await challenges(); }
  };
}
