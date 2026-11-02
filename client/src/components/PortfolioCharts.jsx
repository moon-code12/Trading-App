import { useState } from 'react';
import { money } from '../api.js';

const UP = '#34d399';
const DOWN = '#fb7185';
export const SLICE_COLORS = ['#38bdf8', '#a78bfa', '#fbbf24', '#f472b6', '#2dd4bf', '#fb923c', '#818cf8', '#a3e635', '#e879f9', '#f87171'];
export const CASH_COLOR = '#64748b';

const W = 640;
const H = 220;
const PAD = { top: 12, right: 8, bottom: 22, left: 8 };

const fmtTime = (t, spanMs) => {
  const d = new Date(t);
  return spanMs <= 36 * 3600e3
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

// Portfolio value over time. Colour follows whether the period ended up or down.
export function ValueChart({ points }) {
  const [hover, setHover] = useState(null);
  if (!points?.length) return null;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = (max - min) * 0.1 || Math.max(Math.abs(max) * 0.01, 1);
  const lo = min - pad;
  const hi = max + pad;
  const t0 = points[0].t;
  const span = Math.max(points[points.length - 1].t - t0, 1);
  const x = (t) => PAD.left + ((t - t0) / span) * (W - PAD.left - PAD.right);
  const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
  const color = vals[vals.length - 1] >= vals[0] ? UP : DOWN;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = `${line}L${x(points[points.length - 1].t)},${H - PAD.bottom}L${x(t0)},${H - PAD.bottom}Z`;
  const move = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(x(p.t) - rel) < Math.abs(x(points[best].t) - rel)) best = i; });
    setHover(best);
  };
  const h = hover === null ? null : points[hover];
  return (
    <div>
      <div className="mb-1 flex min-h-6 items-baseline justify-between text-sm text-slate-400">
        <span>{h ? new Date(h.t).toLocaleString() : `${money(vals[0])} at start`}</span>
        <span className="font-semibold text-slate-100">{money(h ? h.value : vals[vals.length - 1])}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full touch-none" role="img" aria-label="Portfolio value over time (demo)"
        onPointerMove={move} onPointerLeave={() => setHover(null)}>
        <path d={area} fill={color} opacity="0.12" />
        <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {h && <>
          <line x1={x(h.t)} x2={x(h.t)} y1={PAD.top} y2={H - PAD.bottom} stroke="#475569" strokeDasharray="3 3" />
          <circle cx={x(h.t)} cy={y(h.value)} r="4" fill={color} />
        </>}
        <text x={PAD.left} y={H - 6} fontSize="11" fill="#94a3b8">{fmtTime(t0, span)}</text>
        <text x={W - PAD.right} y={H - 6} fontSize="11" fill="#94a3b8" textAnchor="end">{fmtTime(t0 + span, span)}</text>
      </svg>
    </div>
  );
}

// Asset allocation donut with a legend (the legend doubles as the accessible data view).
export function AllocationChart({ items }) {
  const slices = items.filter((i) => i.value > 0);
  const total = slices.reduce((s, i) => s + i.value, 0);
  const colorOf = (item, idx) => (item.symbol === null ? CASH_COLOR : SLICE_COLORS[idx % SLICE_COLORS.length]);
  const R = 70;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <svg viewBox="0 0 200 200" className="h-44 w-44 shrink-0 -rotate-90" role="img" aria-label="Asset allocation (demo)">
        <circle cx="100" cy="100" r={R} fill="none" stroke="#1e293b" strokeWidth="28" />
        {total > 0 && slices.map((s, i) => {
          const len = (s.value / total) * C;
          const el = (
            <circle key={s.label} cx="100" cy="100" r={R} fill="none" stroke={colorOf(s, i)} strokeWidth="28"
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />
          );
          offset += len;
          return el;
        })}
      </svg>
      <ul className="w-full space-y-1.5 text-sm">
        {slices.map((s, i) => (
          <li key={s.label} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-sm" style={{ background: colorOf(s, i) }} />{s.label}
            </span>
            <span className="text-slate-400">{money(s.value)} · <b className="text-slate-100">{s.pct.toFixed(2)}%</b></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
