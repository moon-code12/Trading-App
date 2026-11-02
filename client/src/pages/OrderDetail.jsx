import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, money } from '../api.js';
import { Alert, Badge, Button, Card, ORDER_LABELS, statusTone, useLoad } from '../components/ui.jsx';
import PaperNotice from '../components/PaperNotice.jsx';

const POLL_MS = 3000;
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const Stat = ({ label, children }) => (
  <div><p className="text-sm text-slate-400">{label}</p><p className="text-lg font-semibold">{children}</p></div>
);

export default function OrderDetail() {
  const { id } = useParams();
  const { data, error, reload } = useLoad(() => api(`/orders/${id}`), [id]);
  const [cancelError, setCancelError] = useState('');
  const working = data?.summary.working;

  // Keep a working order fresh: fills, trailing level and price change while you watch.
  useEffect(() => {
    if (!working) return undefined;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, id]);

  if (error) return <><Link to="/orders" className="tap text-sm text-emerald-400">Back to orders</Link><Alert>{error}</Alert></>;
  if (!data) return <p className="text-slate-400">Loading…</p>;
  const { order: o, fills, summary: s, live, linked, explanation } = data;

  const cancel = async () => {
    setCancelError('');
    try { await api(`/orders/${o.id}`, { method: 'DELETE' }); reload(); } catch (e) { setCancelError(e.message); }
  };

  return (
    <>
      <Link to="/orders" className="tap text-sm text-emerald-400">Back to orders</Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Order #{o.id}</h1>
          <p className="text-slate-400">
            <Link to={`/markets/${o.symbol}`} className="font-medium text-slate-200 hover:text-emerald-400">{o.symbol}</Link>{' '}
            <span className={o.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{o.side}</span> · {ORDER_LABELS[o.type]} · {o.tif === 'day' ? 'Day order' : 'Good till cancelled'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="amber">DEMO</Badge>
          <Badge tone={statusTone(o.status)}>{o.status.replace('_', ' ')}</Badge>
          {s.working && <Button variant="danger" onClick={cancel}>Cancel order</Button>}
        </div>
      </div>
      <Alert>{cancelError}</Alert>

      <Card title="Progress">
        <div className="mb-3 h-3 overflow-hidden rounded-full bg-slate-800">
          <div role="progressbar" aria-label="Order progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.progressPct)}
            className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${s.progressPct}%` }} />
        </div>
        <p className="mb-4 text-sm text-slate-300">{s.filled} of {s.quantity} {o.symbol} filled ({s.progressPct.toFixed(1)}%)</p>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Filled">{s.filled}</Stat>
          <Stat label="Remaining">{s.remaining}</Stat>
          <Stat label="Average fill price">{s.avgFillPrice === null ? '-' : money(s.avgFillPrice)}</Stat>
          <Stat label="Value filled (demo)">{money(s.totalValue)}</Stat>
          {s.totalFees > 0 && <Stat label="Fees paid">{money(s.totalFees)}</Stat>}
        </div>
      </Card>

      <Card title="What is happening">
        <p role="status" className="text-sm text-slate-200">{explanation}</p>
        {live && (
          <dl className="mt-4 grid grid-cols-2 gap-4 text-sm lg:grid-cols-3">
            <div><dt className="text-slate-400">Price now</dt><dd className="font-semibold">{money(live.price)}</dd></div>
            <div><dt className="text-slate-400">Slices still to fill</dt><dd className="font-semibold">{live.slicesRemaining}</dd></div>
            <div><dt className="text-slate-400">Next fill possible</dt><dd className="font-semibold">{live.executesAt ? time(live.executesAt) : time(live.nextFillAt)}</dd></div>
            {live.marketOpen === false && <div><dt className="text-slate-400">Market</dt><dd className="font-semibold text-amber-300">Closed</dd></div>}
          </dl>
        )}
        {o.expires_at && s.working && <p className="mt-3 text-sm text-slate-400">Expires {new Date(o.expires_at).toLocaleString()}.</p>}
      </Card>

      <Card title="Fills">
        {fills.length === 0 ? <p className="text-sm text-slate-500">Nothing has filled yet.</p> : (
          <div className="overflow-x-auto">
            <table aria-label="Fills" className="w-full text-left text-sm">
              <thead className="text-slate-400">
                <tr>{['Time', 'Quantity', 'Price', 'Amount'].map((h) => <th key={h} className="px-2 py-2 font-medium md:px-3">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {fills.map((f) => (
                  <tr key={f.id}>
                    <td className="px-2 py-2 text-slate-400 md:px-3" title={new Date(f.filledAt).toLocaleString()}>{time(f.filledAt)}</td>
                    <td className="px-2 py-2 md:px-3">{f.quantity}</td>
                    <td className="px-2 py-2 md:px-3">
                      {money(f.price)}
                      {(f.fee > 0 || f.slippageBps > 0) && <span className="block text-xs text-slate-400">{f.fee > 0 ? `fee ${money(f.fee)}` : ''}{f.fee > 0 && f.slippageBps > 0 ? ' · ' : ''}{f.slippageBps > 0 ? `slippage ${Number(f.slippageBps.toFixed(2))} bps` : ''}</span>}
                    </td>
                    <td className="px-2 py-2 md:px-3">{money(f.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {linked.length > 0 && (
        <Card title="Linked OCO order">
          <p className="mb-2 text-sm text-slate-400">Only one of these two orders can fill. When one does, the other is cancelled.</p>
          <ul className="divide-y divide-slate-800">
            {linked.map((l) => (
              <li key={l.id} className="flex items-center justify-between py-2 text-sm">
                <Link to={`/orders/${l.id}`} className="text-emerald-400">Order #{l.id} · {ORDER_LABELS[l.type]}</Link>
                <Badge tone={statusTone(l.status)}>{l.status.replace('_', ' ')}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <PaperNotice />
    </>
  );
}
