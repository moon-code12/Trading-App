import { useState } from 'react';
import { correlation, describeCorrelation, pinSummary, seriesStats } from '../lib/chartAnalysis.js';
import { StatGrid, Trend, fmtPct, spanText } from './SeriesInsights.jsx';

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
  const [pins, setPins] = useState([]); // up to two clicked points to measure between
  const lines = symbols.map((s) => series[s]);
  const values = lines.flatMap((l) => l.map((p) => p.value));
  const lo = Math.min(...values, 100);
  const hi = Math.max(...values, 100);
  const pad = (hi - lo) * 0.1 || 1;
  const t0 = lines[0][   0].t;
  const span = Math.max(lines[0][lines[0].length - 1].t - t0, 1);
  const x = (t) => PAD.left + ((t - t0) / span) * (W - PAD.left - PAD.right);
  const y = (v) => PAD.top + (1 - (v - (lo - pad)) / (hi + pad - (lo - pad))) * (H - PAD.top - PAD.bottom);
  const path = (l) => l.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const nearest = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - r.left) / r.width) * W;
    const pts = lines[0];
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(x(p.t) - rel) < Math.abs(x(pts[best].t) - rel)) best = i; });
    return best;
  };
  const move = (e) => setHover(nearest(e));
  // Click two points to measure the move between them; a third click starts again.
  const pin = (e) => { const i = nearest(e); setHover(i); setPins((p) => (p.length === 1 ? [p[0], i] : [i])); };
  const stats = lines.map((l) => seriesStats(l.map((p) => p.value)));
  const corr = correlation(lines[0].map((p) => p.value), lines[1] ? lines[1].map((p) => p.value) : []);
  const leader = lines.length > 1 && stats[0] && stats[1] ? stats[0].changePct - stats[1].changePct : null;
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
        onPointerMove={move} onPointerDown={pin} onPointerLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={v === 100 ? '#64748b' : '#1e293b'} strokeDasharray={v === 100 ? '4 4' : undefined} />
            <text x={PAD.left - 6} y={y(v) + 4} fontSize="11" fill="#94a3b8" textAnchor="end">{v.toFixed(1)}</text>
          </g>
        ))}
        {lines.map((l, i) => <path key={symbols[i]} d={path(l)} fill="none" stroke={COMPARE_COLORS[i]} strokeWidth="2" strokeLinejoin="round" />)}
        {pins.map((i) => <line key={i} x1={x(lines[0][i].t)} x2={x(lines[0][i].t)} y1={PAD.top} y2={H - PAD.bottom} stroke="#e2e8f0" strokeWidth="1.5" />)}
        {pins.length === 2 && <rect x={Math.min(...pins.map((i) => x(lines[0][i].t)))} y={PAD.top} width={Math.abs(x(lines[0][pins[1]].t) - x(lines[0][pins[0]].t))} height={H - PAD.top - PAD.bottom} fill="#e2e8f0" opacity="0.07" />}
        {hover !== null && <>
          <line x1={x(lines[0][hover].t)} x2={x(lines[0][hover].t)} y1={PAD.top} y2={H - PAD.bottom} stroke="#475569" strokeDasharray="3 3" />
          {lines.map((l, i) => <circle key={symbols[i]} cx={x(l[hover].t)} cy={y(l[hover].value)} r="4" fill={COMPARE_COLORS[i]} />)}
        </>}
        <text x={PAD.left} y={H - 6} fontSize="11" fill="#94a3b8">{fmtTime(t0, span)}</text>
        <text x={W - PAD.right} y={H - 6} fontSize="11" fill="#94a3b8" textAnchor="end">{fmtTime(t0 + span, span)}</text>
      </svg>
      <p className="mt-1 text-xs text-slate-500">Click two points on the chart to measure between them.</p>
      {pins.length === 2 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-slate-900 px-3 py-2 text-xs" data-testid="compare-pins">
          <span className="text-slate-400">Over {spanText(Math.abs(lines[0][pins[1]].t - lines[0][pins[0]].t))}:</span>
          {symbols.map((sym, i) => {
            const m = pinSummary(lines[i][pins[0]], lines[i][pins[1]]);
            return <span key={sym} style={{ color: COMPARE_COLORS[i] }}>{sym} <b>{m.delta >= 0 ? '+' : ''}{m.delta.toFixed(2)} pts ({fmtPct(m.pct)})</b></span>;
          })}
          <button type="button" onClick={() => setPins([])} className="ml-auto rounded bg-slate-800 px-2 py-0.5 text-slate-300 hover:bg-slate-700">Clear</button>
        </div>
      )}
      <section className="mt-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3" aria-label="Comparison analysis" data-testid="compare-analysis">
        <h3 className="mb-2 text-sm font-semibold text-slate-100">Analysis</h3>
        {symbols.map((sym, i) => stats[i] && (
          <div key={sym} className="mb-3">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
              <b style={{ color: COMPARE_COLORS[i] }}>{sym}</b><Trend trend={stats[i].trend} />
            </div>
            <StatGrid label={`${sym} statistics`} items={[
              ['Change', fmtPct(stats[i].changePct)],
              ['High / Low', `${stats[i].high.toFixed(1)} / ${stats[i].low.toFixed(1)}`],
              ['Volatility', `${stats[i].volatility.toFixed(2)}% per step`],
              ['Max drawdown', fmtPct(stats[i].drawdownPct)],
            ]} />
          </div>
        ))}
        {lines.length > 1 && (
          <ul className="space-y-0.5 text-xs text-slate-300">
            {leader !== null && <li>{Math.abs(leader) < 0.01 ? 'Both are level.' : `${symbols[leader > 0 ? 0 : 1]} is ahead by ${Math.abs(leader).toFixed(2)} percentage points.`}</li>}
            <li>Correlation of moves: <b>{corr === null ? '–' : corr.toFixed(2)}</b> · {describeCorrelation(corr)}.</li>
          </ul>
        )}
        <p className="mt-2 text-[11px] text-slate-500">Educational reading of simulated prices, not financial advice.</p>
      </section>
    </div>
  );
}
