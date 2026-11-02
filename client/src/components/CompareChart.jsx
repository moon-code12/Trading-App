import { useState } from 'react';

// Two series rebased to 100. Colours are deliberately not green/red, which mean gain/loss elsewhere.
export const COMPARE_COLORS = ['#38bdf8', '#fbbf24'];

const W = 640;
const H = 240;
const PAD = { top: 12, right: 10, bottom: 22, left: 40 };

const fmtTime = (t, spanMs) => {
  const d = new Date(t);
  return spanMs <= 36 * 3600e3
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

export default function CompareChart({ symbols, series }) {
  const [hover, setHover] = useState(null);
  const lines = symbols.map((s) => series[s]);
  const values = lines.flatMap((l) => l.map((p) => p.value));
  const lo = Math.min(...values, 100);
  const hi = Math.max(...values, 100);
  const pad = (hi - lo) * 0.1 || 1;
  const t0 = lines[0][0].t;
  const span = Math.max(lines[0][lines[0].length - 1].t - t0, 1);
  const x = (t) => PAD.left + ((t - t0) / span) * (W - PAD.left - PAD.right);
  const y = (v) => PAD.top + (1 - (v - (lo - pad)) / (hi + pad - (lo - pad))) * (H - PAD.top - PAD.bottom);
  const path = (l) => l.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const move = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - r.left) / r.width) * W;
    const pts = lines[0];
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(x(p.t) - rel) < Math.abs(x(pts[best].t) - rel)) best = i; });
    setHover(best);
  };
  const ticks = [lo, 100, hi].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <div>
      <div className="mb-1 flex min-h-6 flex-wrap items-baseline justify-between gap-x-4 text-sm text-slate-400" data-testid="compare-readout">
        <span>{hover === null ? 'Both start at 100' : new Date(lines[0][hover].t).toLocaleString()}</span>
        <span className="flex gap-4">
          {symbols.map((s, i) => (
            <span key={s} style={{ color: COMPARE_COLORS[i] }}>{s} <b>{(hover === null ? lines[i][lines[i].length - 1] : lines[i][hover]).value.toFixed(2)}</b></span>
          ))}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full touch-none" role="img" aria-label={`Performance of ${symbols.join(' and ')}, both rebased to 100`}
        onPointerMove={move} onPointerLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={v === 100 ? '#64748b' : '#1e293b'} strokeDasharray={v === 100 ? '4 4' : undefined} />
            <text x={PAD.left - 6} y={y(v) + 4} fontSize="11" fill="#94a3b8" textAnchor="end">{v.toFixed(1)}</text>
          </g>
        ))}
        {lines.map((l, i) => <path key={symbols[i]} d={path(l)} fill="none" stroke={COMPARE_COLORS[i]} strokeWidth="2" strokeLinejoin="round" />)}
        {hover !== null && <>
          <line x1={x(lines[0][hover].t)} x2={x(lines[0][hover].t)} y1={PAD.top} y2={H - PAD.bottom} stroke="#475569" strokeDasharray="3 3" />
          {lines.map((l, i) => <circle key={symbols[i]} cx={x(l[hover].t)} cy={y(l[hover].value)} r="4" fill={COMPARE_COLORS[i]} />)}
        </>}
        <text x={PAD.left} y={H - 6} fontSize="11" fill="#94a3b8">{fmtTime(t0, span)}</text>
        <text x={W - PAD.right} y={H - 6} fontSize="11" fill="#94a3b8" textAnchor="end">{fmtTime(t0 + span, span)}</text>
      </svg>
    </div>
  );
}
