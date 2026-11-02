import { useEffect, useState } from 'react';
import { api, money } from '../api.js';
import { Alert, Badge, Button, Card, Field, Pnl, useLoad } from '../components/ui.jsx';

export default function Risk() {
  const { data, error, reload } = useLoad(() => api('/risk'));
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState({ kind: 'ok', text: '' });

  useEffect(() => {
    if (data) setForm({ dailyLossLimit: data.dailyLossLimit ?? '', maxOrderPct: data.maxOrderPct, largeOrderPct: data.largeOrderPct });
  }, [data]);

  if (error) return <Alert>{error}</Alert>;
  if (!data || !form) return <p className="text-slate-400">Loading…</p>;
  const set = (k) => ({ value: form[k], onChange: (e) => setForm({ ...form, [k]: e.target.value }) });

  const save = async (e) => {
    e.preventDefault();
    setMsg({ kind: 'ok', text: '' });
    try {
      await api('/risk', {
        method: 'PUT',
        body: {
          dailyLossLimit: form.dailyLossLimit === '' ? null : Number(form.dailyLossLimit),
          maxOrderPct: Number(form.maxOrderPct),
          largeOrderPct: Number(form.largeOrderPct),
        },
      });
      setMsg({ kind: 'ok', text: 'Risk limits saved.' });
      reload();
    } catch (err) { setMsg({ kind: 'error', text: err.message }); }
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Risk limits</h1>
        <Badge tone="amber">DEMO · simulated funds</Badge>
      </div>

      <Card title="Today (UTC day, demo values)">
        <p className="text-sm text-slate-400">Result so far today, excluding deposits and withdrawals</p>
        <p className="text-2xl font-bold"><Pnl value={data.todayPnl}>{money(data.todayPnl)}</Pnl></p>
        {data.dailyLossLimit === null ? (
          <p className="mt-2 text-sm text-slate-400">No daily loss limit is set.</p>
        ) : data.limitReached ? (
          <p role="status" className="mt-2 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            Daily loss limit reached ({money(data.todayLoss)} of {money(data.dailyLossLimit)}). New buy orders are paused until {new Date(data.resetsAt).toLocaleString()}. You can still sell.
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-400">Lost {money(data.todayLoss)} of your {money(data.dailyLossLimit)} limit today.</p>
        )}
      </Card>

      <Card title="Your limits">
        <form className="grid max-w-md gap-4" onSubmit={save}>
          <Field label="Daily demo-loss limit" type="number" step="any" min="0" placeholder="No limit" {...set('dailyLossLimit')} />
          <Field label="Maximum order size (% of portfolio)" type="number" step="any" min="1" max="100" required {...set('maxOrderPct')} />
          <Field label="Large-order confirmation above (% of portfolio)" type="number" step="any" min="1" max="100" required {...set('largeOrderPct')} />
          <Alert kind={msg.kind}>{msg.text}</Alert>
          <div><Button>Save limits</Button></div>
        </form>
        <ul className="mt-5 list-disc space-y-1 pl-5 text-sm text-slate-400">
          <li>Once your losses for the day reach the daily limit, new buy orders are paused. Selling stays available so you can reduce risk.</li>
          <li>Orders above the maximum size show a warning before you confirm.</li>
          <li>Orders above the large-order threshold also need an explicit confirmation.</li>
          <li>All limits apply to simulated demo funds.</li>
        </ul>
      </Card>
    </>
  );
}
