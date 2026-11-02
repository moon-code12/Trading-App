import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download, money, signedPct } from '../api.js';
import { AllocationChart, ValueChart } from '../components/PortfolioCharts.jsx';
import { useAuth } from '../auth.jsx';
import { Alert, Badge, Button, Card, Field, ORDER_LABELS, Pnl, Table, statusTone, useLoad } from '../components/ui.jsx';
import PaperNotice from '../components/PaperNotice.jsx';

const date = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString();

const PERIOD_LABELS = { '1D': '1D', '1W': '1W', '1M': '1M', ALL: 'All' };

const Stat = ({ label, children, hint }) => (
  <Card>
    <p className="text-sm text-slate-400">{label}</p>
    <p className="text-xl font-bold md:text-2xl">{children}</p>
    {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
  </Card>
);

const PnlText = ({ value, pct }) => (
  <Pnl value={value}>{money(value)}{pct !== undefined && <>{' '}<span className="text-sm">({signedPct(pct)})</span></>}</Pnl>
);

export function Portfolio() {
  const [range, setRange] = useState('1M');
  const { data, error } = useLoad(() => api('/portfolio/analytics'));
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <p className="text-slate-400">Loading…</p>;
  const { summary: s, performance, holdings, allocation, best, worst } = data;
  const perf = performance[range];
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Portfolio</h1>
        <Badge tone="amber">DEMO · simulated funds</Badge>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <Stat label="Total value (demo)">{money(s.totalValue)}</Stat>
        <Stat label="Cash (demo)">{money(s.cash)}</Stat>
        <Stat label="Daily return"><PnlText value={s.dailyPnl} pct={s.dailyReturnPct} /></Stat>
        <Stat label="Total return" hint={`Excludes ${money(s.netDeposits)} net deposits`}><PnlText value={s.totalPnl} pct={s.totalReturnPct} /></Stat>
        <Stat label="Invested (demo)">{money(s.invested)}</Stat>
        <Stat label="Realized P/L"><Pnl value={s.realizedPnl}>{money(s.realizedPnl)}</Pnl></Stat>
        <Stat label="Unrealized P/L"><Pnl value={s.unrealizedPnl}>{money(s.unrealizedPnl)}</Pnl></Stat>
        <Stat label="Starting balance">{money(s.startingBalance)}</Stat>
      </div>

      <Card title="Portfolio value (demo)" action={
        <div className="flex gap-1" role="group" aria-label="Performance period">
          {Object.entries(PERIOD_LABELS).map(([k, label]) => (
            <button key={k} onClick={() => setRange(k)} aria-pressed={range === k}
              className={`rounded-full px-3 py-1 text-xs ${range === k ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}>{label}</button>
          ))}
        </div>
      }>
        <p className="mb-3 break-words text-sm text-slate-400">
          {PERIOD_LABELS[range]} performance: <PnlText value={perf.pnl} pct={perf.returnPct} />
          <span className="ml-2 text-xs text-slate-500">since {new Date(perf.since).toLocaleDateString()}, deposits and withdrawals excluded</span>
        </p>
        <ValueChart points={perf.history} />
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Asset allocation"><AllocationChart items={allocation} /></Card>
        <Card title="Best and worst holdings">
          {!best ? <p className="py-6 text-center text-slate-500">Buy an asset to see performance rankings.</p> : (
            <ul className="space-y-3 text-sm">
              {[['Best performer', best], ['Worst performer', worst]].map(([label, h]) => h && (
                <li key={label} className="flex items-center justify-between rounded-lg bg-slate-950 px-3 py-2">
                  <span><span className="block text-xs text-slate-400">{label}</span><Link to={`/markets/${h.symbol}`} className="font-semibold hover:text-emerald-400">{h.symbol}</Link></span>
                  <span className="text-right"><PnlText value={h.unrealizedPnl} /><span className="block text-xs"><Pnl value={h.unrealizedPct}>{signedPct(h.unrealizedPct)}</Pnl></span></span>
                </li>
              ))}
              {!worst && <li className="text-xs text-slate-500">Only one holding, so there is nothing to compare it with.</li>}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Holdings (demo values)">
        <Table
          head={['Asset', { label: 'Quantity', cls: 'hidden md:table-cell' }, { label: 'Avg price', cls: 'md:hidden' }, { label: 'Avg purchase price', cls: 'hidden md:table-cell' }, { label: 'Price', cls: 'hidden md:table-cell' }, 'Value', 'Unrealized P/L', { label: 'Realized P/L', cls: 'hidden md:table-cell' }]}
          empty="You do not own any assets yet."
          rows={holdings.map((h) => (
            <tr key={h.symbol}>
              <td className="px-2 py-2 md:px-3">
                <Link to={`/markets/${h.symbol}`} className="font-medium hover:text-emerald-400">{h.symbol}</Link>
                <span className="block text-xs text-slate-500 md:hidden">{h.quantity}</span>
              </td>
              <td className="hidden px-3 py-2 md:table-cell">{h.quantity}</td>
              <td className="px-2 py-2 md:hidden">{money(h.avgCost)}</td>
              <td className="hidden px-3 py-2 md:table-cell">{money(h.avgCost)}</td>
              <td className="hidden px-3 py-2 md:table-cell">{money(h.price)}</td>
              <td className="px-2 py-2 md:px-3">{money(h.value)}</td>
              <td className="px-2 py-2 md:px-3">
                <Pnl value={h.unrealizedPnl}>{money(h.unrealizedPnl)}<span className="block text-xs md:ml-1 md:inline md:text-sm">({signedPct(h.unrealizedPct)})</span></Pnl>
              </td>
              <td className="hidden px-3 py-2 md:table-cell"><Pnl value={h.realizedPnl}>{money(h.realizedPnl)}</Pnl></td>
            </tr>
          ))}
        />
      </Card>
      <p className="text-xs text-slate-500">{data.note} Returns exclude deposits and withdrawals. Average purchase price uses weighted-average cost, including trading fees.</p>
      <PaperNotice />
    </>
  );
}

const TABS = { all: 'all', pending: 'pending', filled: 'filled', cancelled: 'cancelled', expired: 'expired', rejected: 'rejected' };
const inTab = (o, tab) => tab === 'all' || (tab === 'pending' ? ['pending', 'partially_filled'].includes(o.status) : o.status === tab);

// What the "price" column should say for each order type.
function priceText(o) {
  if (o.fill_price) return money(o.fill_price);
  switch (o.type) {
    case 'market': return 'Market';
    case 'stop_limit': return `${money(o.price)} → ${money(o.limit_price)}`;
    case 'trailing_stop': return `Stop ${money(o.price)}`;
    default: return money(o.price ?? 0);
  }
}
const qtyText = (o) => (o.filled_quantity > 0 && o.filled_quantity < o.quantity ? `${o.filled_quantity} / ${o.quantity}` : String(o.quantity));
const statusText = (s) => s.replace('_', ' ');
const detailsLabel = (o) => (o.status === 'partially_filled' ? 'View fills' : 'Details');

// Secondary line: time in force, expiry, trailing distance, OCO link, and why an order ended.
function detailText(o) {
  const bits = [o.tif === 'day' ? 'Day order' : 'GTC'];
  if (['pending', 'partially_filled'].includes(o.status) && o.expires_at) bits.push(`expires ${new Date(o.expires_at).toLocaleString()}`);
  if (o.type === 'trailing_stop') bits.push(`trails ${o.trail_mode === 'percent' ? `${o.trail_value}%` : money(o.trail_value)}`);
  if (o.oco_group !== null) bits.push(`OCO #${o.oco_group}`);
  if (o.note && !['cancelled', 'filled'].includes(o.status)) bits.push(o.note);
  return bits.join(' · ');
}

export function Orders() {
  const [tab, setTab] = useState('all');
  const { data, error, reload } = useLoad(() => api('/orders'));
  const cancel = async (id) => { await api(`/orders/${id}`, { method: 'DELETE' }); reload(); };
  const rows = (data?.orders ?? []).filter((o) => inTab(o, tab));
  const working = (o) => ['pending', 'partially_filled'].includes(o.status);
  return (
    <>
      <h1 className="text-2xl font-bold">Orders</h1>
      <PaperNotice />
      <div className="flex flex-wrap gap-2">
        {Object.keys(TABS).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-sm capitalize ${tab === t ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}>{t}</button>
        ))}
      </div>
      <Alert>{error}</Alert>
      <Card>
        {rows.length === 0 && <p className="py-6 text-center text-slate-500">No orders in this view.</p>}
        <ul className="divide-y divide-slate-800 lg:hidden">
          {rows.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3 py-3">
              <div>
                <p className="font-medium">
                  {o.symbol}{' '}
                  <span className={`text-sm capitalize ${o.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>{o.side}</span>
                  <span className="text-sm text-slate-400"> · {ORDER_LABELS[o.type]}</span>
                </p>
                <p className="text-sm text-slate-400">{qtyText(o)} @ {priceText(o)}</p>
                <p className="text-xs text-slate-500">{detailText(o)}</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Badge tone={statusTone(o.status)}>{statusText(o.status)}</Badge>
                <Link to={`/orders/${o.id}`} className="tap text-sm text-emerald-400">{detailsLabel(o)}</Link>
                {working(o) && <button onClick={() => cancel(o.id)} className="text-sm text-rose-400">Cancel</button>}
              </div>
            </li>
          ))}
        </ul>
        <div className="hidden lg:block">
          <Table
            head={['#', 'Asset', 'Side', 'Type', 'Qty', 'Price', 'Status', 'Placed', { label: 'Action', cls: 'sr-only' }]}
            empty=""
            rows={rows.map((o) => (
              <tr key={o.id}>
                <td className="px-3 py-2 text-slate-500">{o.id}</td>
                <td className="px-3 py-2 font-medium">{o.symbol}</td>
                <td className={`px-3 py-2 capitalize ${o.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>{o.side}</td>
                <td className="px-3 py-2">{ORDER_LABELS[o.type]}<span className="block text-xs text-slate-500">{detailText(o)}</span></td>
                <td className="px-3 py-2">{qtyText(o)}</td>
                <td className="px-3 py-2">{priceText(o)}</td>
                <td className="px-3 py-2"><Badge tone={statusTone(o.status)}>{statusText(o.status)}</Badge></td>
                <td className="px-3 py-2 text-slate-400">{date(o.created_at)}</td>
                <td className="space-x-3 whitespace-nowrap px-3 py-2">
                  <Link to={`/orders/${o.id}`} className="text-emerald-400">{detailsLabel(o)}</Link>
                  {working(o) && <button onClick={() => cancel(o.id)} className="text-rose-400">Cancel</button>}
                </td>
              </tr>
            ))}
          />
        </div>
      </Card>
    </>
  );
}

export function Transactions() {
  const { data, error } = useLoad(() => api('/transactions'));
  const [dlError, setDlError] = useState('');
  const exportCsv = () => download('/transactions/export', 'demo-statement.csv').then(() => setDlError(''), (e) => setDlError(e.message));
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Transaction history</h1>
        <Button variant="ghost" onClick={exportCsv}>Download CSV statement</Button>
      </div>
      <Alert>{error || dlError}</Alert>
      <Card>
        <Table
          head={['Date', 'Type', { label: 'Details', cls: 'hidden md:table-cell' }, 'Amount']}
          empty="No transactions yet."
          rows={(data?.transactions ?? []).map((t) => (
            <tr key={t.id}>
              <td className="px-3 py-2 text-slate-400">{date(t.created_at)}</td>
              <td className="px-3 py-2 capitalize">{t.type}</td>
              <td className="hidden px-3 py-2 text-slate-400 md:table-cell">{t.note}</td>
              <td className="px-3 py-2"><Pnl value={t.amount}>{money(t.amount)}</Pnl></td>
            </tr>
          ))}
        />
      </Card>
    </>
  );
}

export function Wallet() {
  const { refresh, user } = useAuth();
  const { data, reload } = useLoad(() => api('/wallet'));
  const requests = useLoad(() => api('/wallet/withdrawals'));
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState({ kind: 'ok', text: '' });
  const act = async (kind) => {
    setMsg({ kind: 'ok', text: '' });
    try {
      await api(`/wallet/${kind}`, { method: 'POST', body: { amount: Number(amount) } });
      setAmount('');
      setMsg({ kind: 'ok', text: kind === 'deposit' ? 'Demo funds added.' : 'Withdrawal requested. The amount is set aside until it is reviewed.' });
      reload(); refresh(); requests.reload();
    } catch (e) { setMsg({ kind: 'error', text: e.message }); }
  };
  return (
    <>
      <h1 className="text-2xl font-bold">Wallet</h1>
      <Card title="Demo balance">
        <p className="text-3xl font-bold">{data ? money(data.balance) : '…'}</p>
        <p className="mt-1 text-sm text-slate-400">Demo mode. Real-money balances will appear here once live trading is enabled.</p>
      </Card>
      <Card title="Add or remove funds">
        <div className="flex max-w-md items-end gap-3">
          <div className="flex-1"><Field label="Amount" type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <Button disabled={!(Number(amount) > 0)} onClick={() => act('deposit')}>Deposit</Button>
          <Button variant="ghost" disabled={!(Number(amount) > 0)} onClick={() => act('withdraw')}>Withdraw</Button>
        </div>
        {user.kycStatus !== 'approved' && <p className="mt-3 text-sm text-slate-400">Withdrawals need <Link to="/kyc" className="text-emerald-400">identity verification</Link>.</p>}
        {user.suspended && <p className="mt-3 text-sm text-amber-300">Your account is suspended, so you cannot deposit or withdraw. Contact support for help.</p>}
        <div className="mt-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>
      </Card>
      <Card title="Withdrawal requests">
        <Table
          head={['Requested', 'Amount', 'Status']}
          empty="No withdrawal requests."
          rows={(requests.data?.withdrawals ?? []).map((w) => (
            <tr key={w.id}>
              <td className="px-2 py-2 md:px-3">{new Date(w.createdAt).toLocaleDateString()}</td>
              <td className="px-2 py-2 md:px-3">{money(w.amount)}</td>
              <td className="px-2 py-2 md:px-3">
                <Badge tone={w.status === 'approved' ? 'green' : w.status === 'rejected' ? 'red' : 'amber'}>{w.status}</Badge>
                {w.note && <span className="mt-1 block break-words text-xs text-slate-400">{w.note}</span>}
              </td>
            </tr>
          ))}
        />
      </Card>
    </>
  );
}

export function Notifications() {
  const { data, error, reload } = useLoad(() => api('/notifications'));
  const markRead = async () => { await api('/notifications/read', { method: 'POST' }); reload(); };
  const list = data?.notifications ?? [];
  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Notifications</h1>
        {list.some((n) => !n.read) && <Button variant="ghost" onClick={markRead}>Mark all read</Button>}
      </div>
      <Alert>{error}</Alert>
      <Card>
        {list.length === 0 && <p className="py-6 text-center text-slate-500">No notifications.</p>}
        <ul className="divide-y divide-slate-800">
          {list.map((n) => (
            <li key={n.id} className="flex items-start gap-3 py-3">
              <Badge tone={n.kind === 'security' ? 'amber' : 'green'}>{n.kind}</Badge>
              <div className="flex-1">
                <p className={n.read ? 'text-slate-400' : 'font-medium'}>{n.message}</p>
                <p className="text-xs text-slate-500">{date(n.created_at)}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
