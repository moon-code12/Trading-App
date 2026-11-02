// The asset catalogue. To add an asset, add one object to ASSET_DEFINITIONS (or call
// addAsset() from market.js at runtime). Everything else, including markets lists, search,
// categories, discovery, comparison, trading and market-hours indicators, is derived from it.
//
//   symbol     unique, upper-case letters and digits
//   name       display name (searchable)
//   category   any lower-case word; new categories appear in the filters automatically
//   base       reference price the simulated curve moves around
//   liquidity  quantity one order can fill per 5-second slot
//   risk       'low' | 'medium' | 'high' volatility rating
//   volume     typical simulated 24h traded volume, in units of the asset
//   session    a key of SESSIONS in sessions.js

import { SESSIONS } from './sessions.js';

export const RISK_LEVELS = ['low', 'medium', 'high'];

export const ASSET_DEFINITIONS = [
  { symbol: 'BTC', name: 'Bitcoin', category: 'crypto', base: 65000, liquidity: 0.5, risk: 'high', volume: 18000, session: 'always' },
  { symbol: 'ETH', name: 'Ethereum', category: 'crypto', base: 3400, liquidity: 5, risk: 'high', volume: 250000, session: 'always' },
  { symbol: 'SOL', name: 'Solana', category: 'crypto', base: 150, liquidity: 50, risk: 'high', volume: 4000000, session: 'always' },
  { symbol: 'AAPL', name: 'Apple Inc.', category: 'stocks', base: 190, liquidity: 25, risk: 'medium', volume: 55000000, session: 'us-equities' },
  { symbol: 'TSLA', name: 'Tesla Inc.', category: 'stocks', base: 240, liquidity: 25, risk: 'high', volume: 90000000, session: 'us-equities' },
  { symbol: 'MSFT', name: 'Microsoft Corp.', category: 'stocks', base: 420, liquidity: 20, risk: 'medium', volume: 22000000, session: 'us-equities' },
  { symbol: 'EURUSD', name: 'Euro / US Dollar', category: 'forex', base: 1.08, liquidity: 5000, risk: 'low', volume: 120e9, session: 'forex' },
  { symbol: 'GBPUSD', name: 'British Pound / US Dollar', category: 'forex', base: 1.27, liquidity: 5000, risk: 'low', volume: 60e9, session: 'forex' },
  { symbol: 'XAU', name: 'Gold', category: 'commodities', base: 2350, liquidity: 5, risk: 'medium', volume: 200000, session: 'commodities' },
  { symbol: 'WTI', name: 'Crude Oil', category: 'commodities', base: 78, liquidity: 100, risk: 'medium', volume: 30000000, session: 'commodities' },
];

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// Throws a descriptive error for anything that would break the markets code later.
export function validateAsset(def, existing = []) {
  const where = `Asset ${def?.symbol ?? '(no symbol)'}`;
  if (typeof def?.symbol !== 'string' || !/^[A-Z0-9]{2,12}$/.test(def.symbol)) throw new Error(`${where}: symbol must be 2-12 upper-case letters or digits`);
  if (existing.some((a) => a.symbol === def.symbol)) throw new Error(`${where}: symbol already exists`);
  if (typeof def.name !== 'string' || !def.name.trim()) throw new Error(`${where}: name is required`);
  if (typeof def.category !== 'string' || !/^[a-z][a-z-]*$/.test(def.category)) throw new Error(`${where}: category must be a lower-case word`);
  if (!positive(def.base)) throw new Error(`${where}: base price must be positive`);
  if (!positive(def.liquidity)) throw new Error(`${where}: liquidity must be positive`);
  if (!positive(def.volume)) throw new Error(`${where}: volume must be positive`);
  if (!RISK_LEVELS.includes(def.risk)) throw new Error(`${where}: risk must be one of ${RISK_LEVELS.join(', ')}`);
  if (!SESSIONS[def.session]) throw new Error(`${where}: unknown session "${def.session}" (known: ${Object.keys(SESSIONS).join(', ')})`);
  return def;
}
