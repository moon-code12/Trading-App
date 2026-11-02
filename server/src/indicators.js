// Technical indicators, calculated from closing prices using the standard textbook definitions.
// Every function returns an array the same length as its input, with null wherever there is not
// yet enough history for a value. Nothing is estimated or filled in.

const EPS = 1e-12;

function checkPeriod(period, name = 'period') {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`${name} must be a positive integer`);
}
const blank = (n) => Array(n).fill(null);

// Simple moving average: the mean of the last `period` values.
export function sma(values, period) {
  checkPeriod(period);
  const out = blank(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out[i] = sum / period;
  }
  return out;
}

// Exponential moving average with smoothing 2 / (period + 1). It starts from the simple
// average of the first `period` values (the usual convention), then
// EMA = value * k + previous EMA * (1 - k).
export function ema(values, period) {
  checkPeriod(period);
  const out = blank(values.length);
  if (values.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Relative Strength Index with Wilder's smoothing. The first average gain and loss are plain
// means of the first `period` price changes; after that avg = (previous avg * (period - 1) + current) / period.
// A series with no gains and no losses has no direction, so it reads a neutral 50.
export function rsi(values, period = 14) {
  checkPeriod(period);
  const out = blank(values.length);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  const toRsi = () => {
    if (gain < EPS && loss < EPS) return 50;
    if (loss < EPS) return 100;
    return 100 - 100 / (1 + gain / loss);
  };
  out[period] = toRsi();
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = toRsi();
  }
  return out;
}

// MACD: line = EMA(fast) - EMA(slow); signal = EMA of the line; histogram = line - signal.
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  checkPeriod(fast, 'fast period');
  checkPeriod(slow, 'slow period');
  checkPeriod(signalPeriod, 'signal period');
  if (fast >= slow) throw new RangeError('fast period must be shorter than slow period');
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => (f[i] === null || s[i] === null ? null : f[i] - s[i]));
  const signal = blank(values.length);
  const start = line.findIndex((v) => v !== null);
  if (start !== -1) {
    ema(line.slice(start), signalPeriod).forEach((v, i) => { signal[start + i] = v; });
  }
  const histogram = line.map((v, i) => (v === null || signal[i] === null ? null : v - signal[i]));
  return { macd: line, signal, histogram };
}

// Bollinger Bands: a simple moving average with bands `deviations` standard deviations either
// side. The deviation is the population standard deviation of the same window.
export function bollinger(values, period = 20, deviations = 2) {
  checkPeriod(period);
  if (!(deviations > 0)) throw new RangeError('deviations must be positive');
  const middle = sma(values, period);
  const upper = blank(values.length);
  const lower = blank(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j] - middle[i]) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = middle[i] + deviations * sd;
    lower[i] = middle[i] - deviations * sd;
  }
  return { upper, middle, lower };
}

// ---- Calculating a chart's indicators

export const INDICATORS = ['volume', 'sma', 'ema', 'rsi', 'macd', 'bb'];
export const DEFAULTS = { smaPeriod: 20, emaPeriod: 20, rsiPeriod: 14, macd: [12, 26, 9], bollinger: [20, 2] };
// Extra candles before the visible window, so the first visible candle already has settled values.
export const WARMUP = 150;

const round6 = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);
const tail = (series, count) => series.slice(series.length - count).map(round6);

// `closes` holds WARMUP candles of history followed by the `count` visible candles.
export function computeIndicators(closes, count, wanted, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const out = { warmup: closes.length - count };
  if (wanted.includes('sma')) out.sma = { period: o.smaPeriod, values: tail(sma(closes, o.smaPeriod), count) };
  if (wanted.includes('ema')) out.ema = { period: o.emaPeriod, values: tail(ema(closes, o.emaPeriod), count) };
  if (wanted.includes('rsi')) out.rsi = { period: o.rsiPeriod, values: tail(rsi(closes, o.rsiPeriod), count) };
  if (wanted.includes('macd')) {
    const [fast, slow, signal] = o.macd;
    const m = macd(closes, fast, slow, signal);
    out.macd = { fast, slow, signal, macd: tail(m.macd, count), signalLine: tail(m.signal, count), histogram: tail(m.histogram, count) };
  }
  if (wanted.includes('bb')) {
    const [period, deviations] = o.bollinger;
    const b = bollinger(closes, period, deviations);
    out.bollinger = { period, deviations, upper: tail(b.upper, count), middle: tail(b.middle, count), lower: tail(b.lower, count) };
  }
  return out;
}
