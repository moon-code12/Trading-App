// Administrator control over the simulated assets, kept in the database so it survives a restart.
//   active    normal
//   paused    still shown with its price, but nobody can place or fill orders in it
//   disabled  hidden from the markets screens and not tradable; existing holdings are still valued
// Assets added by an administrator are stored as definitions and re-created at start-up.
import { ASSETS, addAsset } from './market.js';
import { validateAsset } from './catalog.js';

export const ASSET_STATUSES = ['active', 'paused', 'disabled'];

// Brings the in-memory catalogue in line with this database. Safe to call for several databases in one process.
export async function loadAssetState(db) {
  for (const { symbol, definition } of await db.prepare('SELECT symbol, definition FROM custom_assets').all()) {
    if (!ASSETS.some((a) => a.symbol === symbol)) addAsset(JSON.parse(definition));
  }
  const saved = new Map((await db.prepare('SELECT symbol, status, spread_bps FROM asset_state').all()).map((r) => [r.symbol, r]));
  for (const a of ASSETS) {
    a.status = saved.get(a.symbol)?.status ?? 'active';
    const spread = saved.get(a.symbol)?.spread_bps;
    if (typeof spread === 'number') a.spreadBps = spread; else delete a.spreadBps;
  }
}

export async function setAssetStatus(db, asset, status, now, adminId) {
  if (!ASSET_STATUSES.includes(status)) throw new Error('Unknown status');
  await db.prepare('INSERT INTO asset_state (symbol, status, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .run(asset.symbol, status, now, adminId);
  asset.status = status;
}

// Sets (or, with null, clears) an asset's own spread in basis points, replacing the profile's default for it.
export async function setAssetSpread(db, asset, spreadBps, now, adminId) {
  await db.prepare("INSERT INTO asset_state (symbol, status, updated_at, updated_by, spread_bps) VALUES (?, ?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET spread_bps = excluded.spread_bps, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
    .run(asset.symbol, asset.status ?? 'active', now, adminId, spreadBps);
  if (spreadBps === null) delete asset.spreadBps; else asset.spreadBps = spreadBps;
}

// Validates, adds to the live catalogue and remembers the definition. Throws a readable Error if the definition is bad.
export async function createAsset(db, def, now, adminId) {
  validateAsset(def, ASSETS);
  const clean = { symbol: def.symbol, name: def.name.trim(), category: def.category, base: def.base, liquidity: def.liquidity, risk: def.risk, volume: def.volume, session: def.session };
  addAsset(clean);
  const asset = ASSETS.find((a) => a.symbol === clean.symbol);
  asset.status = 'active';
  await db.prepare('INSERT INTO custom_assets (symbol, definition, created_at, created_by) VALUES (?, ?, ?, ?)').run(clean.symbol, JSON.stringify(clean), now, adminId);
  return asset;
}

export const isTradable = (asset) => !!asset && (asset.status ?? 'active') === 'active';
