import { useEffect, useState } from 'react';

export const Card = ({ title, action, children, className = '' }) => (
  <section className={`rounded-xl border border-slate-800 bg-slate-900 p-5 ${className}`}>
    {(title || action) && (
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">{title}</h2>
        {action}
      </div>
    )}
    {children}
  </section>
);

export const Button = ({ variant = 'primary', className = '', ...p }) => {
  const v = {
    primary: 'bg-emerald-500 text-slate-950 hover:bg-emerald-400',
    danger: 'bg-rose-500 text-white hover:bg-rose-400',
    ghost: 'border border-slate-700 text-slate-200 hover:bg-slate-800',
  }[variant];
  return <button className={`rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${v} ${className}`} {...p} />;
};

const inputCls = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-emerald-500';

export const Field = ({ label, type, ...p }) => {
  const [show, setShow] = useState(false);
  if (type !== 'password') {
    return (
      <label className="block text-sm">
        <span className="mb-1 block text-slate-400">{label}</span>
        <input className={inputCls} type={type} {...p} />
      </label>
    );
  }
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-slate-400">{label}</span>
      <div className="relative">
        <input className={`${inputCls} pr-16`} type={show ? 'text' : 'password'} {...p} />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setShow((s) => !s)}
          className="absolute inset-y-0 right-0 px-3 text-xs text-slate-400 hover:text-slate-200"
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
    </label>
  );
};

export const Select = ({ label, children, ...p }) => (
  <label className="block text-sm">
    <span className="mb-1 block text-slate-400">{label}</span>
    <select className={inputCls} {...p}>{children}</select>
  </label>
);

export const Alert = ({ kind = 'error', children }) =>
  children ? (
    <div className={`rounded-lg px-3 py-2 text-sm ${kind === 'error' ? 'bg-rose-500/10 text-rose-300' : 'bg-emerald-500/10 text-emerald-300'}`}>{children}</div>
  ) : null;

export const Badge = ({ children, tone = 'slate' }) => {
  const t = {
    slate: 'bg-slate-700 text-slate-200',
    green: 'bg-emerald-500/15 text-emerald-300',
    red: 'bg-rose-500/15 text-rose-300',
    amber: 'bg-amber-500/15 text-amber-300',
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t}`}>{children}</span>;
};

export const statusTone = (s) =>
  ({ filled: 'green', approved: 'green', pending: 'amber', partially_filled: 'amber', cancelled: 'slate', expired: 'slate', rejected: 'red' }[s] || 'slate');

export const ORDER_LABELS = {
  market: 'Market', limit: 'Limit', stop: 'Stop', stop_loss: 'Stop-loss', take_profit: 'Take-profit',
  stop_limit: 'Stop-limit', trailing_stop: 'Trailing stop',
};

export const Change = ({ value }) => (
  <span className={value >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{value >= 0 ? '+' : ''}{value.toFixed(2)}%</span>
);

export const Pnl = ({ value, children }) => (
  <span className={value >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{children}</span>
);

export function Table({ head, rows, empty = 'Nothing here yet.' }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-slate-400">
          <tr>{head.map((h) => {
            const { label, cls = '' } = typeof h === 'string' ? { label: h } : h;
            return <th key={label} className={`px-2 py-2 font-medium md:px-3 ${cls}`}>{label}</th>;
          })}</tr>
        </thead>
        <tbody className="divide-y divide-slate-800">{rows}</tbody>
      </table>
      {rows.length === 0 && <p className="py-6 text-center text-slate-500">{empty}</p>}
    </div>
  );
}

export function Chart({ points, height = 220 }) {
  if (!points?.length) return null;
  const w = 800, pad = 6;
  const ys = points.map((p) => p.price);
  const min = Math.min(...ys), max = Math.max(...ys);
  const x = (i) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (v) => height - pad - ((v - min) / (max - min || 1)) * (height - pad * 2);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
  const color = ys[ys.length - 1] >= ys[0] ? '#34d399' : '#fb7185';
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full" preserveAspectRatio="none" role="img" aria-label="Price chart">
      <path d={`${line} L${x(points.length - 1)},${height} L${x(0)},${height} Z`} fill={color} opacity="0.1" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function useLoad(fn, deps = []) {
  const [state, set] = useState({ data: null, error: '', loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fn()
      .then((data) => live && set({ data, error: '', loading: false }))
      .catch((e) => live && set({ data: null, error: e.message, loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

// Simulated market session: open or closed, with the next change in the tooltip.
export const MarketBadge = ({ market }) => (
  <span title={`${market.session}. ${market.nextChangeLabel}`}
    className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${market.open ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700 text-slate-300'}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${market.open ? 'bg-emerald-400' : 'bg-slate-400'}`} aria-hidden="true" />
    {market.label}
  </span>
);

export const FavouriteButton = ({ symbol, active, onToggle }) => (
  <button type="button" onClick={onToggle} aria-pressed={active}
    aria-label={active ? `Remove ${symbol} from favourites` : `Add ${symbol} to favourites`}
    className={`text-lg leading-none ${active ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400'}`}>
    {active ? '★' : '☆'}
  </button>
);
