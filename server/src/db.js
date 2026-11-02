import { DatabaseSync } from 'node:sqlite';

export function openDb(file = process.env.DB_FILE || 'trading.db') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      email_verified INTEGER NOT NULL DEFAULT 0,
      kyc_status TEXT NOT NULL DEFAULT 'none',
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      balance REAL NOT NULL DEFAULT 10000,
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS email_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kyc_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL,
      date_of_birth TEXT NOT NULL,
      country TEXT NOT NULL,
      document_type TEXT NOT NULL,
      document_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS holdings (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      quantity REAL NOT NULL,
      avg_cost REAL NOT NULL,
      PRIMARY KEY (user_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL,
      status TEXT NOT NULL,
      fill_price REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      filled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      filled_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      symbol TEXT,
      amount REAL NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      target REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      triggered_at TEXT
    );
    CREATE TABLE IF NOT EXISTS recent_views (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      viewed_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device TEXT NOT NULL,
      ip TEXT,
      device_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
    CREATE TABLE IF NOT EXISTS login_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      success INTEGER NOT NULL,
      reason TEXT,
      ip TEXT,
      device TEXT,
      device_key TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_events_user ON login_events (user_id, id);
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS recovery_codes_user ON recovery_codes (user_id);
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by INTEGER,
      decision_note TEXT
    );
    CREATE INDEX IF NOT EXISTS withdrawal_requests_status ON withdrawal_requests (status, id);
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS asset_state (
      symbol TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS custom_assets (
      symbol TEXT PRIMARY KEY,
      definition TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by INTEGER
    );
    -- Administrator actions. No foreign keys, so the record outlives anything it refers to, and the
    -- triggers make it append-only: rows can be added but never changed or removed.
    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      admin_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      ip TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_audit_time ON admin_audit (created_at, id);
    CREATE TRIGGER IF NOT EXISTS admin_audit_no_update BEFORE UPDATE ON admin_audit
      BEGIN SELECT RAISE(ABORT, 'The audit log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete BEFORE DELETE ON admin_audit
      BEGIN SELECT RAISE(ABORT, 'The audit log is append-only'); END;
    CREATE TABLE IF NOT EXISTS challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      code TEXT UNIQUE,
      owner_id INTEGER,
      week_key TEXT UNIQUE,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      join_deadline INTEGER NOT NULL,
      max_participants INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      settled_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS challenge_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at INTEGER NOT NULL,
      start_equity REAL NOT NULL,
      final_return_pct REAL,
      final_profit REAL,
      final_trades INTEGER,
      final_eligible INTEGER,
      final_rank INTEGER,
      final_reason TEXT,
      finalized_at INTEGER,
      UNIQUE (challenge_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS practice_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at INTEGER NOT NULL,
      previous_balance REAL NOT NULL,
      previous_equity REAL NOT NULL,
      new_balance REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS achievements (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      earned_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE IF NOT EXISTS watchlist (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      PRIMARY KEY (user_id, symbol)
    );
  `);
  migrate(db);
  return db;
}

// Additive migrations for databases created before a column existed.
function migrate(db) {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  if (!has('transactions', 'order_id')) {
    db.exec('ALTER TABLE transactions ADD COLUMN order_id INTEGER');
    // Link legacy trade rows to their orders via the note written at fill time.
    const filled = db.prepare("SELECT id, user_id, symbol, side, quantity, fill_price FROM orders WHERE status = 'filled' ORDER BY id").all();
    const find = db.prepare('SELECT id FROM transactions WHERE order_id IS NULL AND user_id = ? AND type = ? AND symbol = ? AND note = ? ORDER BY id LIMIT 1');
    const link = db.prepare('UPDATE transactions SET order_id = ? WHERE id = ?');
    for (const o of filled) {
      const t = find.get(o.user_id, o.side, o.symbol, `${o.quantity} ${o.symbol} @ ${o.fill_price}`);
      if (t) link.run(o.id, t.id);
    }
  }
  const addCol = (table, col, def) => { if (!has(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
  // Advanced orders: trigger state, partial fills, time in force and OCO grouping.
  const firstTime = !has('orders', 'filled_quantity');
  addCol('orders', 'limit_price', 'REAL');
  addCol('orders', 'trail_mode', 'TEXT');
  addCol('orders', 'trail_value', 'REAL');
  addCol('orders', 'peak_price', 'REAL');
  addCol('orders', 'triggered', 'INTEGER NOT NULL DEFAULT 0');
  addCol('orders', 'filled_quantity', 'REAL NOT NULL DEFAULT 0');
  addCol('orders', 'tif', "TEXT NOT NULL DEFAULT 'gtc'");
  addCol('orders', 'expires_at', 'INTEGER');
  addCol('orders', 'oco_group', 'INTEGER');
  addCol('orders', 'last_slot', 'INTEGER');
  addCol('orders', 'reserve_price', 'REAL');
  addCol('orders', 'note', 'TEXT');
  addCol('transactions', 'fill_id', 'INTEGER');
  // Account lockout after repeated failed logins.
  addCol('users', 'failed_logins', 'INTEGER NOT NULL DEFAULT 0');
  addCol('users', 'locked_until', 'INTEGER');
  // Realistic execution: when an order reaches the market, and what each fill cost.
  addCol('orders', 'execute_after', 'INTEGER');
  addCol('fills', 'fee', 'REAL NOT NULL DEFAULT 0');
  addCol('fills', 'mid', 'REAL');
  addCol('fills', 'slippage_bps', 'REAL NOT NULL DEFAULT 0');
  // An administrator's spread for one asset, in basis points (overrides the profile's default).
  addCol('asset_state', 'spread_bps', 'REAL');
  addCol('challenge_entries', 'final_reason', 'TEXT');
  // Public leaderboards: a made-up name instead of the real one, and a way out.
  addCol('users', 'display_name', 'TEXT');
  addCol('users', 'leaderboard_opt_out', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_display_name ON users (lower(display_name))');
  // Account suspension (set by administrators).
  addCol('users', 'suspended_at', 'INTEGER');
  addCol('users', 'suspended_reason', 'TEXT');
  // Risk controls (per user).
  addCol('users', 'daily_loss_limit', 'REAL');
  addCol('users', 'max_order_pct', 'REAL NOT NULL DEFAULT 25');
  addCol('users', 'large_order_pct', 'REAL NOT NULL DEFAULT 50');
  if (firstTime) {
    // Orders filled before partial fills existed become a single fill each.
    db.exec("UPDATE orders SET filled_quantity = quantity WHERE status = 'filled'");
    const legacy = db.prepare("SELECT id, user_id, symbol, side, quantity, fill_price, filled_at, created_at FROM orders WHERE status = 'filled' ORDER BY filled_at, id").all();
    const ins = db.prepare('INSERT INTO fills (order_id, user_id, symbol, side, quantity, price, filled_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const link = db.prepare('UPDATE transactions SET fill_id = ? WHERE order_id = ? AND fill_id IS NULL');
    for (const o of legacy) link.run(ins.run(o.id, o.user_id, o.symbol, o.side, o.quantity, o.fill_price, o.filled_at ?? o.created_at).lastInsertRowid, o.id);
  }
}

export function notify(db, userId, kind, message) {
  db.prepare('INSERT INTO notifications (user_id, kind, message) VALUES (?, ?, ?)').run(userId, kind, message);
}
