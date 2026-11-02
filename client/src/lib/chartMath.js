// Small pure helpers for drawing charts.

// An SVG path through the values, lifting the pen wherever a value is missing so gaps are shown as gaps
// (and never joined up or filled in).
export function seriesPath(values, xOf, yOf) {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || v === undefined || !Number.isFinite(v)) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

// The smallest and largest real numbers across several series (nulls are ignored); null if there are none.
export function extent(...series) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) for (const v of s ?? []) if (typeof v === 'number' && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return lo === Infinity ? null : [lo, hi];
}

// The candle under a horizontal position, or null outside the plot.
export function indexAt(px, left, step, count) {
  const i = Math.floor((px - left) / step);
  return i >= 0 && i < count ? i : null;
}
