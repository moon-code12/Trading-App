import { Link } from 'react-router-dom';
import { api, money } from '../api.js';
import { Alert, Card, Change, Pnl, Table, useLoad } from '../components/ui.jsx';

const Stat = ({ label, children }) => (
  <Card><p className="text-sm text-slate-400">{label}</p><p className="mt-1 text-2xl font-bold">{children}</p></Card>
);

export default function Dashboard() {
  const { data, error, loading } = useLoad(() => api('/dashboard'));
  if (loading) return <p className="text-slate-400">Loading…</p>;
  if (error) return <Alert>{error}</Alert>;
  return (
    <>
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total value">{money(data.totalValue)}</Stat>
        <Stat label="Cash balance">{money(data.balance)}</Stat>
        <Stat label="Invested">{money(data.invested)}</Stat>
        <Stat label="Profit / loss"><Pnl value={data.pnl}>{money(data.pnl)}</Pnl></Stat>
      </div>
      <Card title="Favourites" action={<Link to="/markets" className="tap text-sm text-emerald-400">Browse markets</Link>}>
        <Table
          head={['Asset', 'Price', '24h']}
          empty="You have no favourites yet. Tap the star on an asset in the markets page."
          rows={data.watchlist.map((a) => (
            <tr key={a.symbol}>
              <td className="px-3 py-2"><Link to={`/markets/${a.symbol}`} className="font-medium hover:text-emerald-400">{a.symbol}</Link> <span className="text-slate-500">{a.name}</span></td>
              <td className="px-3 py-2">{money(a.price)}</td>
              <td className="px-3 py-2"><Change value={a.change24h} /></td>
            </tr>
          ))}
        />
      </Card>
      <Card title="Holdings">
        <Table
          head={['Asset', 'Quantity', 'Value', 'P/L']}
          empty="No holdings yet. Place your first order."
          rows={data.holdings.map((h) => (
            <tr key={h.symbol}>
              <td className="px-3 py-2 font-medium">{h.symbol}</td>
              <td className="px-3 py-2">{h.quantity}</td>
              <td className="px-3 py-2">{money(h.value)}</td>
              <td className="px-3 py-2"><Pnl value={h.pnl}>{money(h.pnl)}</Pnl></td>
            </tr>
          ))}
        />
      </Card>
    </>
  );
}
