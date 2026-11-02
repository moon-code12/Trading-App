import bcrypt from 'bcryptjs';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { matchPending } from './trading.js';
import { ensureWeekly, settleChallenges } from './challenges.js';

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error('JWT_SECRET is required (e.g. JWT_SECRET=$(openssl rand -hex 32))');
  process.exit(1);
}
const db = openDb();

// Optional first admin: set ADMIN_EMAIL and ADMIN_PASSWORD.
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (ADMIN_EMAIL && ADMIN_PASSWORD && !db.prepare('SELECT 1 FROM users WHERE email = ?').get(ADMIN_EMAIL.toLowerCase())) {
  db.prepare("INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ('Admin', ?, ?, 'admin', 1)")
    .run(ADMIN_EMAIL.toLowerCase(), bcrypt.hashSync(ADMIN_PASSWORD, 10));
}

// Orders can take about a second to reach the simulated market, so check for work often.
setInterval(() => matchPending(db), 1000);
// Weekly challenges appear on schedule, and finished ones are frozen and announced.
setInterval(() => { const t = Date.now(); ensureWeekly(db, t); settleChallenges(db, t); }, 60e3);
const port = process.env.PORT || 4000;
createApp(db, { secret, simulation: process.env.SIM_PROFILE || 'realistic' }).listen(port, () => console.log(`API listening on :${port}`));
