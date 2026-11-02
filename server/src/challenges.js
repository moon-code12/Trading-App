// Trading challenges, leaderboards, the practice-account reset and achievements endpoints.
//
// How a challenge is scored (the fairness rules):
//   * Ranking is by percentage return, a time-weighted return that deposits and withdrawals cannot change. A second
//     view ranks by profit in money, which favours bigger accounts, so the percentage ranking is the default.
//   * Measurement starts when the challenge starts (or when you join, if later) and stops when it ends. Joining early
//     gives no head start, and anything done after the end does not count: results are frozen when it ends.
//   * To be ranked you need at least one trade and at least $1,000 of equity when measurement starts, so tiny or idle
//     accounts cannot post silly percentages.
//   * Public boards show only a made-up display name, never an email, real name or account id. People can opt out.
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { timeWeightedPerformance } from './analytics.js';
import { atomic } from './trading.js';
import { notify } from './db.js';
import { achievementList, evaluateAchievements } from './achievements.js';
import { rateLimiter } from './rateLimit.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONDAY_OFFSET = 4 * DAY; // 1 January 1970 was a Thursday, so the first Monday is four days in

export const RULES = Object.freeze({
  minStartEquity: 1000,
  minTrades: 1,
  weeklyJoinHours: 48,
  privateJoinHours: 24,
  maxPrivateParticipants: 50,
  maxWeeklyParticipants: 5000,
  maxActivePrivateOwned: 5,
  maxPrivateDays: 30,
  maxStartAheadDays: 14,
});
export const START_BALANCES = [1000, 10000, 100000];

export class ChallengeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const statusOf = (ch, now) => (now < ch.starts_at ? 'upcoming' : now < ch.ends_at ? 'running' : 'ended');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

// ------------------------------------------------------------------ display names

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9 _-]{1,18}[A-Za-z0-9]$/;

export function validateAlias(name) {
  const n = String(name ?? '').trim();
  if (!ALIAS.test(n)) return 'Use 3 to 20 letters, numbers, spaces, dashes or underscores, starting and ending with a letter or number';
  if (/^trader-/i.test(n)) return '"Trader-" names are handed out automatically; pick something of your own';
  return null;
}

// The name shown on leaderboards. Everyone gets a made-up one automatically so nobody is ever shown by real name.
export function aliasFor(db, userId) {
  const row = one(db, 'SELECT display_name FROM users WHERE id = ?', userId);
  if (row?.display_name) return row.display_name;
  for (let attempt = 0; attempt < 50; attempt++) {
    const hex = crypto.createHash('sha256').update(`alias:${userId}:${attempt}`).digest('hex').slice(0, 4 + Math.floor(attempt / 10)).toUpperCase();
    const name = `Trader-${hex}`;
    if (!one(db, 'SELECT 1 FROM users WHERE lower(display_name) = lower(?)', name)) {
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, userId);
      return name;
    }
  }
  throw new Error('Could not assign a display name');
}

// ------------------------------------------------------------------ weekly challenges

export const weekStart = (now) => MONDAY_OFFSET + Math.floor((now - MONDAY_OFFSET) / WEEK) * WEEK;

// Makes sure this week's challenge, and next week's (so people can join ahead), exist.
export function ensureWeekly(db, now) {
  for (const offset of [0, 1]) {
    const start = weekStart(now) + offset * WEEK;
    const key = new Date(start).toISOString().slice(0, 10);
    db.prepare(`INSERT OR IGNORE INTO challenges (kind, name, week_key, starts_at, ends_at, join_deadline, max_participants, created_at)
      VALUES ('weekly', ?, ?, ?, ?, ?, ?, ?)`)
      .run(`Weekly challenge: week of ${key}`, key, start, start + WEEK, start + RULES.weeklyJoinHours * HOUR, RULES.maxWeeklyParticipants, now);
  }
}

// ------------------------------------------------------------------ private challenges and codes

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normaliseCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function newCode(db) {
  for (;;) {
    const raw = Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % 32]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (!one(db, 'SELECT 1 FROM challenges WHERE code = ?', code)) return code;
  }
}

// ------------------------------------------------------------------ standings

const entryOf = (db, challengeId, userId) => one(db, 'SELECT * FROM challenge_entries WHERE challenge_id = ? AND user_id = ?', challengeId, userId);

// Where one entry stands. Frozen results for ended challenges; live figures otherwise.
export function standing(db, entry, ch, now) {
  if (entry.finalized_at !== null) {
    return { returnPct: entry.final_return_pct, profit: entry.final_profit, trades: entry.final_trades, eligible: !!entry.final_eligible, reason: entry.final_reason };
  }
  if (now < ch.starts_at) return { returnPct: 0, profit: 0, trades: 0, eligible: false, reason: 'Not started yet' };
  const from = Math.max(entry.joined_at, ch.starts_at);
  const to = Math.min(now, ch.ends_at);
  const perf = timeWeightedPerformance(db, { id: entry.user_id }, from, to);
  const trades = one(db, 'SELECT COUNT(*) n FROM fills WHERE user_id = ? AND filled_at >= ? AND filled_at <= ?', entry.user_id, sqlTime(from), sqlTime(to)).n;
  const reason = reasonOf(trades, perf.startValue);
  return { returnPct: r4(perf.returnPct), profit: r2(perf.pnl), trades, eligible: reason === null, reason };
}

function reasonOf(trades, startEquity) {
  if (startEquity !== null && startEquity < RULES.minStartEquity) return `Needs at least $${RULES.minStartEquity.toLocaleString('en-US')} of equity when the challenge starts`;
  if (trades < RULES.minTrades) return 'Make a trade to be ranked';
  return null;
}

const byReturn = (a, b) => b.returnPct - a.returnPct || b.profit - a.profit || a.joinedAt - b.joinedAt || a.entryId - b.entryId;
const byProfit = (a, b) => b.profit - a.profit || b.returnPct - a.returnPct || a.joinedAt - b.joinedAt || a.entryId - b.entryId;

function allStandings(db, ch, now) {
  const entries = db.prepare(`SELECT e.*, u.leaderboard_opt_out AS opt_out, u.suspended_at AS suspended_at FROM challenge_entries e
    JOIN users u ON u.id = e.user_id WHERE e.challenge_id = ? ORDER BY e.id`).all(ch.id);
  return entries.map((e) => ({
    entryId: e.id, userId: e.user_id, joinedAt: e.joined_at, optOut: !!e.opt_out, suspended: !!e.suspended_at, finalRank: e.final_rank,
    ...standing(db, e, ch, now),
  }));
}

// The leaderboard a given person is allowed to see. Public (weekly) boards leave out people who opted out and suspended
// accounts; private boards show everyone who joined by code. Only display names ever leave this function.
export function leaderboard(db, ch, viewerId, now, sort = 'return') {
  const all = allStandings(db, ch, now);
  const visible = ch.kind === 'weekly' ? all.filter((s) => !s.optOut && !s.suspended) : all;
  const ranked = visible.filter((s) => s.eligible).sort(sort === 'profit' ? byProfit : byReturn);
  const row = (s, rank) => ({
    ...(rank ? { rank } : {}), name: aliasFor(db, s.userId), returnPct: s.returnPct, profit: s.profit, trades: s.trades, you: s.userId === viewerId,
  });
  const mine = all.find((s) => s.userId === viewerId);
  const myRank = mine && ranked.findIndex((s) => s.userId === viewerId);
  return {
    sort,
    ranked: ranked.map((s, i) => row(s, i + 1)),
    waiting: visible.filter((s) => !s.eligible).map((s) => ({ name: aliasFor(db, s.userId), reason: s.reason, you: s.userId === viewerId })),
    you: mine ? {
      joined: true, hidden: ch.kind === 'weekly' && (mine.optOut || mine.suspended), rank: myRank >= 0 ? myRank + 1 : null,
      returnPct: mine.returnPct, profit: mine.profit, trades: mine.trades, eligible: mine.eligible, reason: mine.reason,
    } : { joined: false },
  };
}

// ------------------------------------------------------------------ finishing challenges

// Freezes the result of every challenge that has ended and tells the participants. Safe to call as often as you like.
export function settleChallenges(db, now) {
  const due = db.prepare('SELECT * FROM challenges WHERE ends_at <= ? AND settled_at IS NULL').all(now);
  for (const ch of due) {
    atomic(db, () => {
      const all = allStandings(db, ch, ch.ends_at);
      const eligible = all.filter((s) => s.eligible).sort(byReturn);
      const rankOf = new Map(eligible.map((s, i) => [s.entryId, i + 1]));
      const save = db.prepare(`UPDATE challenge_entries SET final_return_pct = ?, final_profit = ?, final_trades = ?, final_eligible = ?,
        final_rank = ?, final_reason = ?, finalized_at = ? WHERE id = ?`);
      for (const s of all) save.run(s.returnPct, s.profit, s.trades, s.eligible ? 1 : 0, rankOf.get(s.entryId) ?? null, s.reason, now, s.entryId);
      db.prepare('UPDATE challenges SET settled_at = ? WHERE id = ?').run(now, ch.id);
      for (const s of all) {
        const rank = rankOf.get(s.entryId);
        notify(db, s.userId, 'challenge', rank
          ? `"${ch.name}" has ended. You finished #${rank} of ${eligible.length} with a return of ${s.returnPct.toFixed(2)}%.`
          : `"${ch.name}" has ended. You were not ranked: ${s.reason ?? 'no result'}.`);
      }
      for (const s of all) evaluateAchievements(db, s.userId, now);
    });
  }
  return due.length;
}

// ------------------------------------------------------------------ joining and leaving

const equityNow = (db, userId, now) => timeWeightedPerformance(db, { id: userId }, now, now).endValue;

function joinProblem(db, user, ch, now, equity) {
  const fresh = one(db, 'SELECT suspended_at, leaderboard_opt_out FROM users WHERE id = ?', user.id);
  if (now >= ch.ends_at) return 'This challenge has ended';
  if (now > ch.join_deadline) return 'Joining has closed for this challenge';
  if (entryOf(db, ch.id, user.id)) return 'You have already joined this challenge';
  if (fresh.suspended_at) return 'Your account is suspended';
  if (ch.kind === 'weekly' && fresh.leaderboard_opt_out) return 'You have opted out of public leaderboards. Turn that off in leaderboard settings to join public challenges';
  if (one(db, 'SELECT COUNT(*) n FROM challenge_entries WHERE challenge_id = ?', ch.id).n >= ch.max_participants) return 'This challenge is full';
  if (equity < RULES.minStartEquity) return `You need at least $${RULES.minStartEquity.toLocaleString('en-US')} of equity to enter`;
  return null;
}

function join(db, user, ch, now) {
  const equity = equityNow(db, user.id, now);
  const problem = joinProblem(db, user, ch, now, equity);
  if (problem) throw new ChallengeError(problem, problem.startsWith('You have already') ? 409 : 400);
  db.prepare('INSERT INTO challenge_entries (challenge_id, user_id, joined_at, start_equity) VALUES (?, ?, ?, ?)').run(ch.id, user.id, now, r2(equity));
  aliasFor(db, user.id);
  evaluateAchievements(db, user.id, now);
}

// ------------------------------------------------------------------ the practice account

// Why this person cannot reset right now, or null.
export function resetProblem(db, user, now) {
  const fresh = one(db, 'SELECT suspended_at FROM users WHERE id = ?', user.id);
  if (fresh.suspended_at) return 'Your account is suspended';
  const active = one(db, `SELECT c.name FROM challenge_entries e JOIN challenges c ON c.id = e.challenge_id
    WHERE e.user_id = ? AND c.ends_at > ? LIMIT 1`, user.id, now);
  if (active) return `You are in "${active.name}", which has not ended yet. Leave it first, or wait until it finishes, so nobody can reset in the middle of a challenge`;
  if (one(db, "SELECT COUNT(*) n FROM withdrawal_requests WHERE user_id = ? AND status = 'pending'", user.id).n) return 'You have a withdrawal request waiting for review';
  return null;
}

// Wipes the user's trading history and gives them a fresh balance. A record of the reset is kept.
export function resetPractice(db, user, startingBalance, now) {
  settleChallenges(db, now);
  const problem = resetProblem(db, user, now);
  if (problem) throw new ChallengeError(problem, 409);
  if (!START_BALANCES.includes(startingBalance)) throw new ChallengeError(`Choose a starting balance of ${START_BALANCES.join(', ')}`);
  const before = one(db, 'SELECT balance FROM users WHERE id = ?', user.id).balance;
  const equity = r2(equityNow(db, user.id, now));
  atomic(db, () => {
    db.prepare('DELETE FROM transactions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM fills WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM orders WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM holdings WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM price_alerts WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(startingBalance, user.id);
    db.prepare('INSERT INTO practice_resets (user_id, at, previous_balance, previous_equity, new_balance) VALUES (?, ?, ?, ?, ?)').run(user.id, now, r2(before), equity, startingBalance);
  });
  notify(db, user.id, 'wallet', `Your practice account was reset to ${startingBalance.toLocaleString('en-US')}.`);
  evaluateAchievements(db, user.id, now);
}

// ------------------------------------------------------------------ routes

export function challengesRouter(db, { now = Date.now }) {
  const r = Router();
  const guard = (fn) => (req, res) => {
    try { fn(req, res); } catch (e) {
      if (!(e instanceof ChallengeError)) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };
  const joinByCodeLimit = rateLimiter({
    max: 10, windowMs: 15 * 60e3, now, key: (req) => `challenge-code:${req.user.id}`, message: 'Too many invitation-code attempts. Try again in a few minutes.',
  });

  // A challenge by id, if this user may know it exists: weekly ones are public, private ones are for members only.
  const visible = (req) => {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : null;
    const ch = id === null ? undefined : one(db, 'SELECT * FROM challenges WHERE id = ?', id);
    if (!ch || (ch.kind === 'private' && !entryOf(db, ch.id, req.user.id))) throw new ChallengeError('Challenge not found', 404);
    return ch;
  };

  const describe = (ch, user, equity) => {
    const t = now();
    const entry = entryOf(db, ch.id, user.id);
    const participants = ch.kind === 'weekly'
      ? one(db, `SELECT COUNT(*) n FROM challenge_entries e JOIN users u ON u.id = e.user_id WHERE e.challenge_id = ? AND u.leaderboard_opt_out = 0 AND u.suspended_at IS NULL`, ch.id).n
      : one(db, 'SELECT COUNT(*) n FROM challenge_entries WHERE challenge_id = ?', ch.id).n;
    const problem = entry ? null : joinProblem(db, user, ch, t, equity);
    return {
      id: ch.id, kind: ch.kind, name: ch.name, status: statusOf(ch, t), startsAt: ch.starts_at, endsAt: ch.ends_at, joinDeadline: ch.join_deadline,
      participants, maxParticipants: ch.max_participants, joined: !!entry, owner: ch.owner_id === user.id,
      ...(ch.owner_id === user.id ? { code: ch.code } : {}),
      canJoin: !entry && problem === null, joinBlockedReason: entry ? null : problem,
    };
  };

  const settingsOf = (userId) => {
    const u = one(db, 'SELECT leaderboard_opt_out FROM users WHERE id = ?', userId);
    return { displayName: aliasFor(db, userId), optOut: !!u.leaderboard_opt_out };
  };

  const prepare = () => { const t = now(); ensureWeekly(db, t); settleChallenges(db, t); return t; };

  r.get('/challenges', (req, res) => {
    const t = prepare();
    const equity = equityNow(db, req.user.id, t);
    const weekly = db.prepare("SELECT * FROM challenges WHERE kind = 'weekly' AND ends_at > ? ORDER BY starts_at").all(t - 2 * WEEK);
    const past = db.prepare("SELECT * FROM challenges WHERE kind = 'weekly' AND ends_at <= ? ORDER BY starts_at DESC LIMIT 4").all(t);
    const mine = db.prepare(`SELECT c.* FROM challenges c JOIN challenge_entries e ON e.challenge_id = c.id
      WHERE c.kind = 'private' AND e.user_id = ? ORDER BY c.ends_at > ? DESC, c.id DESC LIMIT 30`).all(req.user.id, t);
    res.json({
      weekly: weekly.map((c) => describe(c, req.user, equity)),
      pastWeekly: past.map((c) => describe(c, req.user, equity)),
      private: mine.map((c) => describe(c, req.user, equity)),
      rules: RULES, settings: settingsOf(req.user.id),
    });
  });

  // The current weekly challenge's public leaderboard (or the next one, if the current one has not started).
  r.get('/leaderboard', guard((req, res) => {
    const sort = req.query.sort ?? 'return';
    if (!['return', 'profit'].includes(sort)) throw new ChallengeError('sort must be return or profit');
    const t = prepare();
    const ch = one(db, "SELECT * FROM challenges WHERE kind = 'weekly' AND ends_at > ? ORDER BY starts_at LIMIT 1", t);
    res.json({
      challenge: describe(ch, req.user, equityNow(db, req.user.id, t)), leaderboard: leaderboard(db, ch, req.user.id, t, sort), rules: RULES,
      note: sort === 'profit'
        ? 'Ranked by profit in money. Bigger accounts make bigger profits, so the percentage-return ranking is the fairer comparison.'
        : 'Ranked by percentage return, which deposits and withdrawals cannot change.',
    });
  }));

  r.get('/leaderboard/settings', (req, res) => res.json(settingsOf(req.user.id)));
  r.put('/leaderboard/settings', guard((req, res) => {
    const p = z.object({ displayName: z.string().optional(), optOut: z.boolean().optional() }).safeParse(req.body);
    if (!p.success || (p.data.displayName === undefined && p.data.optOut === undefined)) throw new ChallengeError('Send displayName and/or optOut');
    if (p.data.displayName !== undefined) {
      const name = p.data.displayName.trim();
      const bad = validateAlias(name);
      if (bad) throw new ChallengeError(bad);
      const taken = one(db, 'SELECT id FROM users WHERE lower(display_name) = lower(?)', name);
      if (taken && taken.id !== req.user.id) throw new ChallengeError('That name is already taken', 409);
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, req.user.id);
    }
    if (p.data.optOut !== undefined) db.prepare('UPDATE users SET leaderboard_opt_out = ? WHERE id = ?').run(p.data.optOut ? 1 : 0, req.user.id);
    res.json(settingsOf(req.user.id));
  }));

  const createSchema = z.object({
    name: z.string().trim().min(3).max(40),
    days: z.number().int().min(1).max(RULES.maxPrivateDays),
    startsAt: z.string().datetime({ offset: true }).optional(),
  });
  r.post('/challenges', guard((req, res) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) throw new ChallengeError(`Give the challenge a name (3 to 40 characters) and a length of 1 to ${RULES.maxPrivateDays} days`);
    const t = prepare();
    if (one(db, 'SELECT suspended_at FROM users WHERE id = ?', req.user.id).suspended_at) throw new ChallengeError('Your account is suspended', 403);
    const start = p.data.startsAt ? Date.parse(p.data.startsAt) : t;
    if (start < t - 60e3) throw new ChallengeError('The start time cannot be in the past');
    if (start > t + RULES.maxStartAheadDays * DAY) throw new ChallengeError(`The start time can be at most ${RULES.maxStartAheadDays} days ahead`);
    const owned = one(db, 'SELECT COUNT(*) n FROM challenges WHERE owner_id = ? AND ends_at > ?', req.user.id, t).n;
    if (owned >= RULES.maxActivePrivateOwned) throw new ChallengeError(`You can run at most ${RULES.maxActivePrivateOwned} private challenges at a time`, 409);
    const startsAt = Math.max(start, t);
    const id = Number(db.prepare(`INSERT INTO challenges (kind, name, code, owner_id, starts_at, ends_at, join_deadline, max_participants, created_at)
      VALUES ('private', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.data.name, newCode(db), req.user.id, startsAt, startsAt + p.data.days * DAY, startsAt + RULES.privateJoinHours * HOUR, RULES.maxPrivateParticipants, t).lastInsertRowid);
    const ch = one(db, 'SELECT * FROM challenges WHERE id = ?', id);
    join(db, req.user, ch, t);
    res.status(201).json({ challenge: describe(ch, req.user, equityNow(db, req.user.id, t)) });
  }));

  r.post('/challenges/join', joinByCodeLimit, guard((req, res) => {
    const p = z.object({ code: z.string().min(1).max(40) }).safeParse(req.body);
    if (!p.success) throw new ChallengeError('Enter an invitation code');
    const t = prepare();
    const n = normaliseCode(p.data.code);
    const ch = n.length === 8 ? one(db, "SELECT * FROM challenges WHERE kind = 'private' AND code = ?", `${n.slice(0, 4)}-${n.slice(4)}`) : undefined;
    if (!ch) throw new ChallengeError('No challenge matches that code', 404);
    join(db, req.user, ch, t);
    res.status(201).json({ challenge: describe(ch, req.user, equityNow(db, req.user.id, t)) });
  }));

  r.get('/challenges/:id', guard((req, res) => {
    const sort = req.query.sort ?? 'return';
    if (!['return', 'profit'].includes(sort)) throw new ChallengeError('sort must be return or profit');
    const t = prepare();
    const ch = visible(req);
    res.json({
      challenge: describe(ch, req.user, equityNow(db, req.user.id, t)), leaderboard: leaderboard(db, ch, req.user.id, t, sort), rules: RULES,
      note: sort === 'profit'
        ? 'Ranked by profit in money. Bigger accounts make bigger profits, so the percentage-return ranking is the fairer comparison.'
        : 'Ranked by percentage return, which deposits and withdrawals cannot change.',
    });
  }));

  r.post('/challenges/:id/join', guard((req, res) => {
    const t = prepare();
    const ch = visible(req);
    if (ch.kind !== 'weekly') throw new ChallengeError('Private challenges are joined with their invitation code', 400);
    join(db, req.user, ch, t);
    res.status(201).json({ challenge: describe(ch, req.user, equityNow(db, req.user.id, t)) });
  }));

  r.post('/challenges/:id/leave', guard((req, res) => {
    const t = prepare();
    const ch = visible(req);
    if (!entryOf(db, ch.id, req.user.id)) throw new ChallengeError('You have not joined this challenge', 409);
    if (t >= ch.ends_at) throw new ChallengeError('This challenge has ended, so your result is final', 409);
    db.prepare('DELETE FROM challenge_entries WHERE challenge_id = ? AND user_id = ?').run(ch.id, req.user.id);
    res.json({ ok: true });
  }));

  // Replaces the invitation code, so anyone who only had the old one can no longer join.
  r.post('/challenges/:id/rotate-code', guard((req, res) => {
    const ch = visible(req);
    if (ch.owner_id !== req.user.id) throw new ChallengeError('Only the person who created this challenge can change its code', 403);
    const code = newCode(db);
    db.prepare('UPDATE challenges SET code = ? WHERE id = ?').run(code, ch.id);
    res.json({ code });
  }));

  // ---- Practice account
  r.get('/practice', (req, res) => {
    const t = prepare();
    const last = one(db, 'SELECT at FROM practice_resets WHERE user_id = ? ORDER BY id DESC LIMIT 1', req.user.id);
    const problem = resetProblem(db, req.user, t);
    res.json({
      balances: START_BALANCES, canReset: problem === null, blockedReason: problem,
      resets: one(db, 'SELECT COUNT(*) n FROM practice_resets WHERE user_id = ?', req.user.id).n, lastResetAt: last?.at ?? null,
    });
  });
  r.post('/practice/reset', guard((req, res) => {
    const p = z.object({ startingBalance: z.number().optional() }).safeParse(req.body ?? {});
    if (!p.success) throw new ChallengeError('Invalid input');
    resetPractice(db, req.user, p.data.startingBalance ?? 10000, now());
    res.json({ ok: true, balance: one(db, 'SELECT balance FROM users WHERE id = ?', req.user.id).balance });
  }));

  // ---- Achievements
  r.get('/achievements', (req, res) => {
    evaluateAchievements(db, req.user.id, now());
    const list = achievementList(db, req.user.id);
    res.json({ achievements: list, earned: list.filter((a) => a.earned).length, total: list.length });
  });

  return r;
}
