import { Link, useSearchParams } from 'react-router-dom';
import { api, compact, compactUsd, money } from '../api.js';
import CompareChart, { COMPARE_COLORS } from '../components/CompareChart.jsx';
import { Alert, Badge, Button, Card, Change, MarketBadge, Select, Table, useLoad } from '../components/ui.jsx';

const RANGES = ['1D', '1W', '1M'];
const RANGE_NAMES = { '1D': '24 hours', '1W': '7 days', '1M': '30 days' };

export default function Compare() {
  const [params, setParams] = useSearchParams();
  const all = useLoad(() => api('/markets'));
  const a = (params.get('a') || 'BTC').toUpperCase();
  const b = (params.get('b') || (a === 'ETH' ? 'BTC' : 'ETH')).toUpperCase();
  const range = RANGES.includes(params.get('range')) ? params.get('range') : '1D';
  const same = a === b;
  const set = (patch) => setParams({ a, b, range, ...patch }, { replace: true });
  const { data, error } = useLoad(() => (same ? Promise.resolve(null) : api(`/markets/compare?a=${a}&b=${b}&range=${range}`)), [a, b, range]);
  const options = all.data?.assets ?? [];
  const [x, y] = data?.assets ?? [];
  const shown = data && !same ? data : null; // the response may lag behind the URL while a new comparison loads

  const R = shown?.range;
  const rows = !shown ? [] : [
    ['Price', (s) => money(s.price)],
    ['24h change', (s) => <Change value={s.change24h} />],
    [`Return over ${RANGE_NAMES[R]}`, (s) => <Change value={shown.returnPct[s.symbol]} />],
    ['24h high', (s) => money(s.high24h)],
    ['24h low', (s) => money(s.low24h)],
    ['24h volume', (s) => `${compact(s.volume24h)} ${s.symbol}`],
    ['24h traded value', (s) => compactUsd(s.volumeUsd24h)],
    ['Category', (s) => <span className="capitalize">{s.category}</span>],
    ['Volatility', (s) => <span className="capitalize">{s.risk}</span>],
    ['Simulated liquidity', (s) => `${s.liquidity} per 5 s`],
    ['Market', (s) => <MarketBadge market={s.market} />],
  ];

  let verdict = '';
  if (shown) {
    const d = shown.returnPct[x.symbol] - shown.returnPct[y.symbol];
    verdict = Math.abs(d) < 0.005
      ? `${x.symbol} and ${y.symbol} performed about the same over ${RANGE_NAMES[R]}.`
      : `${d > 0 ? x.symbol : y.symbol} outperformed ${d > 0 ? y.symbol : x.symbol} by ${Math.abs(d).toFixed(2)} percentage points over ${RANGE_NAMES[R]}.`;
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Compare assets</h1>
        <Badge tone="amber">DEMO · simulated data</Badge>
      </div>
      <Card>
        <div className="grid items-end gap-3 md:grid-cols-[1fr_auto_1fr]">
          <Select label="First asset" value={a} onChange={(e) => set({ a: e.target.value })}>
            {options.map((o) => <option key={o.symbol} value={o.symbol}>{o.symbol} · {o.name}</option>)}
          </Select>
          <Button variant="ghost" type="button" onClick={() => set({ a: b, b: a })}>Swap</Button>
          <Select label="Second asset" value={b} onChange={(e) => set({ b: e.target.value })}>
            {options.map((o) => <option key={o.symbol} value={o.symbol}>{o.symbol} · {o.name}</option>)}
          </Select>
        </div>
        <div className="mt-4 flex gap-1" role="group" aria-label="Comparison period">
          {RANGES.map((r) => (
            <button key={r} onClick={() => set({ range: r })} aria-pressed={range === r}
              className={`rounded-full px-3 py-1 text-xs ${range === r ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}>{r}</button>
          ))}
        </div>
      </Card>
      {same && <Alert>Choose two different assets to compare.</Alert>}
      <Alert>{error}</Alert>
      {shown && (
        <>
          <Card title={`Performance over ${RANGE_NAMES[R]}, both rebased to 100`}>
            <p className="mb-3 text-sm text-slate-300" role="status">{verdict}</p>
            <CompareChart symbols={[x.symbol, y.symbol]} series={shown.series} />
            <div className="mt-3 flex gap-4 text-sm">
              {[x, y].map((s, i) => (
                <span key={s.symbol} className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm" style={{ background: COMPARE_COLORS[i] }} />{s.name}</span>
              ))}
            </div>
          </Card>
          <Card>
            <Table
              head={[{ label: 'Metric', cls: 'sr-only' }, x.symbol, y.symbol]}
              rows={[
                ...rows.map(([label, render]) => (
                  <tr key={label}>
                    <th scope="row" className="px-2 py-2 font-normal text-slate-400 md:px-3">{label}</th>
                    <td className="px-2 py-2 md:px-3">{render(x)}</td>
                    <td className="px-2 py-2 md:px-3">{render(y)}</td>
                  </tr>
                )),
                <tr key="links">
                  <th scope="row" className="px-2 py-2 font-normal text-slate-400 md:px-3">Open</th>
                  {[x, y].map((s) => (
                    <td key={s.symbol} className="px-2 py-2 md:px-3">
                      <Link to={`/markets/${s.symbol}`} className="text-emerald-400">Details</Link>{' · '}
                      <Link to={`/trade/${s.symbol}`} className="text-emerald-400">Trade</Link>
                    </td>
                  ))}
                </tr>,
              ]}
            />
          </Card>
        </>
      )}
      <p className="text-xs text-slate-500">All values are simulated demo data. Each simulated asset moves independently, so differences here say nothing about real markets.</p>
    </>
  );
}
