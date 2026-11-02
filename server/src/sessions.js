// Simulated trading sessions, always evaluated in UTC. Prices keep moving in this demo even
// when a market is "closed"; the session only drives the open/closed indicator.
// Holidays are not modelled.

const HOUR = 60;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]; // 0 = Sunday

// A window is [weekday, fromMinute, toMinute) within that UTC day.
const windows = (days, from, to) => days.map((d) => [d, from, to]);

export const SESSIONS = {
  // Crypto never closes.
  always: { label: '24/7', windows: windows(ALL_DAYS, 0, 24 * HOUR) },
  // US equities, 14:30-21:00 UTC (9:30-16:00 New York, ignoring daylight saving), Monday to Friday.
  'us-equities': { label: 'US equities, Mon-Fri 14:30-21:00 UTC', windows: windows([1, 2, 3, 4, 5], 14 * HOUR + 30, 21 * HOUR) },
  // Forex trades around the clock from Sunday 22:00 UTC to Friday 22:00 UTC.
  forex: {
    label: 'Forex, Sun 22:00 - Fri 22:00 UTC',
    windows: [[0, 22 * HOUR, 24 * HOUR], ...windows([1, 2, 3, 4], 0, 24 * HOUR), [5, 0, 22 * HOUR]],
  },
  // Futures-style commodities: a one hour break at 22:00 UTC each day, closed from Friday 22:00 to Sunday 23:00.
  commodities: {
    label: 'Commodities, Sun 23:00 - Fri 22:00 UTC with a daily 22:00-23:00 break',
    windows: [
      [0, 23 * HOUR, 24 * HOUR],
      ...windows([1, 2, 3, 4], 0, 22 * HOUR), ...windows([1, 2, 3, 4], 23 * HOUR, 24 * HOUR),
      [5, 0, 22 * HOUR],
    ],
  },
};

const minuteOfWeek = (t) => {
  const d = new Date(t);
  return d.getUTCDay() * 24 * HOUR + d.getUTCHours() * HOUR + d.getUTCMinutes();
};

export function isOpen(sessionId, t = Date.now()) {
  const session = SESSIONS[sessionId];
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  const m = minuteOfWeek(t);
  const day = Math.floor(m / (24 * HOUR));
  const minute = m % (24 * HOUR);
  return session.windows.some(([d, from, to]) => d === day && minute >= from && minute < to);
}

// Next moment the open/closed state flips (minute resolution), or null for sessions that never change.
export function nextChange(sessionId, t = Date.now()) {
  const now = isOpen(sessionId, t);
  const start = Math.floor(t / 60e3) * 60e3;
  for (let i = 1; i <= 8 * 24 * HOUR; i++) {
    const at = start + i * 60e3;
    if (isOpen(sessionId, at) !== now) return at;
  }
  return null;
}

export function marketStatus(sessionId, t = Date.now()) {
  const open = isOpen(sessionId, t);
  const change = nextChange(sessionId, t);
  return {
    open,
    label: open ? 'Open' : 'Closed',
    session: SESSIONS[sessionId].label,
    nextChange: change === null ? null : new Date(change).toISOString(),
    nextChangeLabel: change === null ? 'Always open' : `${open ? 'Closes' : 'Opens'} ${new Date(change).toISOString().replace('T', ' ').slice(0, 16)} UTC`,
  };
}

// ---- Session intervals (used by the realistic price model)

const WEEK = 7 * 24 * HOUR;
const intervalCache = {};
// A session's windows joined end to end, as [startMinute, endMinute) within the UTC week (Sunday 00:00 = 0).
function intervals(sessionId) {
  if (intervalCache[sessionId]) return intervalCache[sessionId];
  const sorted = SESSIONS[sessionId].windows.map(([d, from, to]) => [d * 24 * HOUR + from, d * 24 * HOUR + to]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]); else out.push([...w]);
  }
  return (intervalCache[sessionId] = out);
}

const weekStartOf = (t) => Math.floor(t / 60e3) * 60e3 - minuteOfWeek(t) * 60e3;

// Is the market open, and when did the current (or most recent) continuous trading period start and end?
// `end` is the close for a closed market, or the coming close for an open one.
export function sessionState(sessionId, t = Date.now()) {
  if (!SESSIONS[sessionId]) throw new Error(`Unknown session: ${sessionId}`);
  const m = minuteOfWeek(t);
  const base = weekStartOf(t);
  const iv = intervals(sessionId);
  for (const [s, e] of iv) if (m >= s && m < e) return { open: true, start: base + s * 60e3, end: base + e * 60e3 };
  let best = null;
  for (const [s, e] of iv) if (e <= m && (!best || e > best[1])) best = [s, e, 0];
  if (!best) best = [...iv[iv.length - 1], -WEEK];
  return { open: false, start: base + (best[0] + best[2]) * 60e3, end: base + (best[1] + best[2]) * 60e3 };
}

// The next moment the market opens (now, if it is open already).
export function nextOpen(sessionId, t = Date.now()) {
  const st = sessionState(sessionId, t);
  if (st.open) return Math.floor(t / 60e3) * 60e3;
  const m = minuteOfWeek(t);
  const base = weekStartOf(t);
  const later = intervals(sessionId).find(([s]) => s > m);
  return later ? base + later[0] * 60e3 : base + (intervals(sessionId)[0][0] + WEEK) * 60e3;
}
