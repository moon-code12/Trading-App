// Small building blocks for the analysis shown under the portfolio and comparison charts.

export const fmtPct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

export function StatGrid({ items, label }) {
  return (
    <dl aria-label={label} className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      {items.map(([k, v, color]) => (
        <div key={k} className="rounded-md bg-slate-900 px-2 py-1.5">
          <dt className="text-slate-400">{k}</dt>
          <dd className="font-semibold tabular-nums" style={{ color: color ?? '#e2e8f0' }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export const spanText = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 90) return `${m} min`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
};

export const Trend = ({ trend }) => (
  <span className="rounded border border-slate-600 px-2 py-0.5 text-xs text-slate-200">
    {trend.direction} · fit {trend.r2.toFixed(2)}
  </span>
);
