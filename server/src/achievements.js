// Beginner achievements. Each one is a plain rule over data the app already has, so they can be re-checked at any
// time and can never be earned twice. They are private to each user.
import { getAsset } from './market.js';
import { notify } from './db.js';
import { replayFills } from './analytics.js';

const one = (db, sql, ...args) => db.prepare(sql).get(...args);
const count = (db, sql, ...args) => one(db, sql, ...args).n;

export const ACHIEVEMENTS = [
  { key: 'first_trade', title: 'First trade', description: 'Make your first trade.',
    test: (db, u) => count(db, 'SELECT COUNT(*) n FROM fills WHERE user_id = ?', u) > 0 },
  { key: 'first_sale', title: 'Closed a position', description: 'Sell something you own.',
    test: (db, u) => count(db, "SELECT COUNT(*) n FROM fills WHERE user_id = ? AND side = 'sell'", u) > 0 },
  { key: 'first_profit', title: 'In the green', description: 'Sell something for more than you paid, after fees.',
    test: (db, u) => {
      if (!count(db, "SELECT COUNT(*) n FROM fills WHERE user_id = ? AND side = 'sell'", u)) return false;
      const fills = db.prepare('SELECT id, symbol, side, quantity, price, fee FROM fills WHERE user_id = ? ORDER BY filled_at, id').all(u);
      return [...replayFills(fills).realizedByOrder.values()].some((p) => p > 0);
    } },
  { key: 'limit_order', title: 'Patient trader', description: 'Place a limit order and let the price come to you.',
    test: (db, u) => count(db, "SELECT COUNT(*) n FROM orders WHERE user_id = ? AND type IN ('limit', 'stop_limit')", u) > 0 },
  { key: 'safety_net', title: 'Safety net', description: 'Protect yourself with a stop-loss, take-profit, trailing stop or OCO order, or set a daily loss limit.',
    test: (db, u) => count(db, "SELECT COUNT(*) n FROM orders WHERE user_id = ? AND (type IN ('stop_loss', 'take_profit', 'trailing_stop') OR oco_group IS NOT NULL)", u) > 0
      || count(db, 'SELECT COUNT(*) n FROM users WHERE id = ? AND daily_loss_limit IS NOT NULL', u) > 0 },
  { key: 'explorer', title: 'Explorer', description: 'Trade in three different markets (crypto, stocks, forex or commodities).',
    test: (db, u) => new Set(db.prepare('SELECT DISTINCT symbol FROM fills WHERE user_id = ?').all(u).map((r) => getAsset(r.symbol)?.category).filter(Boolean)).size >= 3 },
  { key: 'diversified', title: 'Spread your bets', description: 'Hold three or more different assets at the same time.',
    test: (db, u) => count(db, 'SELECT COUNT(*) n FROM holdings WHERE user_id = ?', u) >= 3 },
  { key: 'price_alert', title: 'Watching the market', description: 'Set a price alert.',
    test: (db, u) => count(db, 'SELECT COUNT(*) n FROM price_alerts WHERE user_id = ?', u) > 0 },
  { key: 'curator', title: 'Curator', description: 'Add three assets to your favourites.',
    test: (db, u) => count(db, 'SELECT COUNT(*) n FROM watchlist WHERE user_id = ?', u) >= 3 },
  { key: 'secured', title: 'Locked down', description: 'Turn on two-factor authentication.',
    test: (db, u) => count(db, 'SELECT COUNT(*) n FROM users WHERE id = ? AND totp_enabled = 1', u) > 0 },
  { key: 'fresh_start', title: 'Fresh start', description: 'Reset your practice account and begin again.',
    test: (db, u) => count(db, 'SELECT COUNT(*) n FROM practice_resets WHERE user_id = ?', u) > 0 },
  { key: 'challenger', title: 'Challenger', description: 'Join a trading challenge.',
    test: (db, u) => count(db, 'SELECT COUNT(*) n FROM challenge_entries WHERE user_id = ?', u) > 0 },
  { key: 'finisher', title: 'Finisher', description: 'Complete a challenge with at least one trade.',
    test: (db, u) => count(db, 'SELECT COUNT(*) n FROM challenge_entries WHERE user_id = ? AND final_eligible = 1', u) > 0 },
  { key: 'podium', title: 'Podium', description: 'Finish in the top three of a challenge with at least three ranked traders.',
    test: (db, u) => count(db, `SELECT COUNT(*) n FROM challenge_entries e WHERE e.user_id = ? AND e.final_eligible = 1 AND e.final_rank <= 3
      AND (SELECT COUNT(*) FROM challenge_entries x WHERE x.challenge_id = e.challenge_id AND x.final_eligible = 1) >= 3`, u) > 0 },
];

export const achievementList = (db, userId) => {
  const earned = new Map(db.prepare('SELECT key, earned_at FROM achievements WHERE user_id = ?').all(userId).map((r) => [r.key, r.earned_at]));
  return ACHIEVEMENTS.map(({ key, title, description }) => ({ key, title, description, earned: earned.has(key), earnedAt: earned.get(key) ?? null }));
};

// Awards anything newly earned and tells the user. Returns the keys awarded now. Cheap enough to call after any relevant action.
export function evaluateAchievements(db, userId, now = Date.now()) {
  const have = new Set(db.prepare('SELECT key FROM achievements WHERE user_id = ?').all(userId).map((r) => r.key));
  const awarded = [];
  for (const a of ACHIEVEMENTS) {
    if (have.has(a.key)) continue;
    let ok = false;
    try { ok = a.test(db, userId); } catch { ok = false; }
    if (!ok) continue;
    if (db.prepare('INSERT OR IGNORE INTO achievements (user_id, key, earned_at) VALUES (?, ?, ?)').run(userId, a.key, now).changes) {
      awarded.push(a.key);
      notify(db, userId, 'achievement', `Achievement unlocked: ${a.title}. ${a.description}`);
    }
  }
  return awarded;
}
