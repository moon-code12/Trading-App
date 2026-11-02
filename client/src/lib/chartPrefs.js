// Chart preferences, remembered in the browser between visits. Anything missing, out of date or
// tampered with falls back to a safe default, so a bad stored value can never break the chart.

export const STORAGE_KEY = 'tradeapp.chartPrefs.v1';
export const TIMEFRAMES = ['1H', '1D', '1W', '1M', '3M'];
export const CHART_MODES = ['candles', 'line'];
export const PALETTE_NAMES = ['standard', 'accessible'];
export const SMA_PERIODS = [10, 20, 50];
export const EMA_PERIODS = [9, 12, 20, 26, 50];
export const INDICATOR_KEYS = ['volume', 'sma', 'ema', 'bb', 'rsi', 'macd'];

export const DEFAULT_PREFS = Object.freeze({
  tf: '1D',
  mode: 'candles',
  palette: 'standard',
  smaPeriod: 20,
  emaPeriod: 20,
  indicators: Object.freeze({ volume: true, sma: false, ema: false, bb: false, rsi: false, macd: false }),
});

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

// Turns whatever was stored into a complete, valid preferences object.
export function sanitizePrefs(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const stored = r.indicators && typeof r.indicators === 'object' && !Array.isArray(r.indicators) ? r.indicators : {};
  return {
    tf: pick(r.tf, TIMEFRAMES, DEFAULT_PREFS.tf),
    mode: pick(r.mode, CHART_MODES, DEFAULT_PREFS.mode),
    palette: pick(r.palette, PALETTE_NAMES, DEFAULT_PREFS.palette),
    smaPeriod: pick(r.smaPeriod, SMA_PERIODS, DEFAULT_PREFS.smaPeriod),
    emaPeriod: pick(r.emaPeriod, EMA_PERIODS, DEFAULT_PREFS.emaPeriod),
    indicators: Object.fromEntries(INDICATOR_KEYS.map((k) => [k, typeof stored[k] === 'boolean' ? stored[k] : DEFAULT_PREFS.indicators[k]])),
  };
}

const defaultStorage = () => { try { return globalThis.localStorage; } catch { return undefined; } };

export function loadPrefs(storage = defaultStorage()) {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    return sanitizePrefs(text ? JSON.parse(text) : null);
  } catch {
    return sanitizePrefs(null);
  }
}

// Returns false when the browser refuses (private mode, storage full), so the chart can carry on without saving.
export function savePrefs(prefs, storage = defaultStorage()) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(sanitizePrefs(prefs)));
    return true;
  } catch {
    return false;
  }
}

// The query string for the candles request. Volume is already part of every candle, so only
// the calculated indicators are requested; the periods are sent only when they matter.
export function candlesQuery(prefs) {
  const p = sanitizePrefs(prefs);
  const wanted = ['sma', 'ema', 'rsi', 'macd', 'bb'].filter((k) => p.indicators[k]);
  const parts = [`tf=${p.tf}`];
  if (wanted.length) parts.push(`indicators=${wanted.join(',')}`);
  if (p.indicators.sma) parts.push(`smaPeriod=${p.smaPeriod}`);
  if (p.indicators.ema) parts.push(`emaPeriod=${p.emaPeriod}`);
  return parts.join('&');
}
