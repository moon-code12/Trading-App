import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, money } from '../api.js';
import { Alert, Badge, Button, Card, Field, Select, Table, useLoad } from '../components/ui.jsx';

const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const day = (ms) => new Date(ms).toLocaleDateString([], { dateStyle: 'medium' });
const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const tone = { running: 'green', upcoming: 'amber', ended: 'slate' };
const td = 'px-2 py-2 md:px-3';

function useAction() {
  const [msg, setMsg] = useState({ kind: 'ok', text: '' });
  const run = async (fn, ok) => {
    setMsg({ kind: 'ok', text: '' });
    try { await fn(); setMsg({ kind: 'ok', text: ok }); return true; } catch (e) { setMsg({ kind: 'error', text: e.message }); return false; }
  };
  return [msg, run];
}

function ChallengeRow({ c, onJoin }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div>
        <p className="font-medium">
          <Link to={`/challenges/${c.id}`} className="text-emerald-400">{c.name}</Link>{' '}
          <Badge tone={tone[c.status]}>{c.status}</Badge> {c.joined && <Badge tone="green">you are in</Badge>}
        </p>
        <p className="text-xs text-slate-400">
          {day(c.startsAt)} to {day(c.endsAt - 1)} · {c.participants} {c.kind === 'weekly' ? 'on the public board' : 'taking part'}
          {c.status !== 'ended' && ` · joining closes ${when(c.joinDeadline)}`}
        </p>
        {!c.joined && c.status !== 'ended' && c.joinBlockedReason && <p className="text-xs text-amber-300">{c.joinBlockedReason}.</p>}
        {c.owner && c.code && <p className="mt-1 text-xs text-slate-300">Invitation code: <b className="font-mono text-slate-100" data-testid="invite-code">{c.code}</b></p>}
      </div>
      {onJoin && c.canJoin && <Button aria-label={`Join ${c.name}`} onClick={() => onJoin(c)}>Join</Button>}
    </li>
  );
}

export function Challenges() {
  const nav = useNavigate();
  const { data, error, reload } = useLoad(() => api('/challenges'));
  const practice = useLoad(() => api('/practice'));
  const [msg, run] = useAction();
  const [create, setCreate] = useState({ name: '', days: '7' });
  const [code, setCode] = useState('');
  const [alias, setAlias] = useState(null);
  const [optOut, setOptOut] = useState(null); // shown at once, then confirmed by the server
  const [balance, setBalance] = useState('10000');
  const [sure, setSure] = useState(false);

  const settings = data?.settings;
  const join = (c) => run(async () => { await api(`/challenges/${c.id}/join`, { method: 'POST' }); reload(); practice.reload(); }, `You joined ${c.name}.`);

  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">Challenges</h1>
        <Link to="/achievements" className="tap text-sm text-emerald-400">Your achievements</Link>
      </div>
      <p className="text-sm text-slate-400">Compete with demo money. Everyone is ranked by <b>percentage return</b>, so a small account can beat a big one, and money you add or take out during a challenge never counts as profit.</p>
      <Alert>{error}</Alert>
      <Alert kind={msg.kind}>{msg.text}</Alert>

      <Card title="Weekly challenges">
        <ul className="divide-y divide-slate-800" aria-label="Weekly challenges">
          {(data?.weekly ?? []).map((c) => <ChallengeRow key={c.id} c={c} onJoin={join} />)}
        </ul>
        {(data?.pastWeekly?.length ?? 0) > 0 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-slate-400">Past weeks</summary>
            <ul className="divide-y divide-slate-800">{data.pastWeekly.map((c) => <ChallengeRow key={c.id} c={c} />)}</ul>
          </details>
        )}
        {data && (
          <p className="mt-3 text-xs text-slate-500">
            To be ranked you need at least {money(data.rules.minStartEquity)} of equity when the challenge starts and at least one trade. Joining closes {data.rules.weeklyJoinHours} hours after it starts.
          </p>
        )}
      </Card>

      <Card title="Private challenges">
        <ul className="divide-y divide-slate-800" aria-label="Private challenges">
          {(data?.private ?? []).map((c) => <ChallengeRow key={c.id} c={c} />)}
        </ul>
        {data && data.private.length === 0 && <p className="text-sm text-slate-500">You are not in any private challenges yet.</p>}
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api('/challenges', { method: 'POST', body: { name: create.name, days: Number(create.days) } }); setCreate({ name: '', days: '7' }); reload(); nav(`/challenges/${r.challenge.id}`); }, 'Challenge created.'); }}>
            <h3 className="font-semibold">Start a private challenge</h3>
            <Field label="Name" required minLength={3} maxLength={40} value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} />
            <Select label="Length" value={create.days} onChange={(e) => setCreate({ ...create, days: e.target.value })}>
              {[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>)}
            </Select>
            <div><Button>Create and get a code</Button></div>
          </form>
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api('/challenges/join', { method: 'POST', body: { code } }); setCode(''); reload(); nav(`/challenges/${r.challenge.id}`); }, 'You joined the challenge.'); }}>
            <h3 className="font-semibold">Join with an invitation code</h3>
            <Field label="Invitation code" required autoComplete="off" placeholder="ABCD-EFGH" value={code} onChange={(e) => setCode(e.target.value)} />
            <div><Button variant="ghost">Join</Button></div>
          </form>
        </div>
      </Card>

      <Card title="Leaderboard privacy">
        {settings && (
          <div className="grid max-w-md gap-4">
            <p className="text-sm text-slate-400">Leaderboards only ever show your display name, never your email, real name or balance.</p>
            <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/leaderboard/settings', { method: 'PUT', body: { displayName: alias ?? settings.displayName } }); setAlias(null); reload(); }, 'Display name saved.'); }}>
              <div className="flex-1"><Field label="Display name" maxLength={20} value={alias ?? settings.displayName} onChange={(e) => setAlias(e.target.value)} /></div>
              <Button variant="ghost" disabled={alias === null || alias === settings.displayName}>Save</Button>
            </form>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={optOut ?? settings.optOut}
                onChange={async (e) => {
                  const value = e.target.checked;
                  setOptOut(value);
                  const ok = await run(async () => { await api('/leaderboard/settings', { method: 'PUT', body: { optOut: value } }); reload(); }, value ? 'You are hidden from public leaderboards.' : 'You can appear on public leaderboards again.');
                  if (!ok) setOptOut(null); // the server said no: go back to what it has
                }} />
              <span>Hide me from public leaderboards. I can still join private challenges with an invitation code.</span>
            </label>
          </div>
        )}
      </Card>

      <Card title="Practice account">
        <div className="grid max-w-md gap-3">
          <p className="text-sm text-slate-400">Start again with a fresh balance. This erases your orders, holdings, alerts and transaction history (a record of the reset is kept). It is not possible during a challenge you are in.</p>
          {practice.data && (
            <>
              <Select label="New starting balance" value={balance} onChange={(e) => setBalance(e.target.value)}>
                {practice.data.balances.map((b) => <option key={b} value={b}>{money(b)}</option>)}
              </Select>
              {practice.data.blockedReason && <p className="text-sm text-amber-300">{practice.data.blockedReason}.</p>}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={sure} onChange={(e) => setSure(e.target.checked)} />
                <span>I understand this deletes my trading history.</span>
              </label>
              <div>
                <Button variant="danger" disabled={!practice.data.canReset || !sure}
                  onClick={() => run(async () => { await api('/practice/reset', { method: 'POST', body: { startingBalance: Number(balance) } }); setSure(false); reload(); practice.reload(); }, 'Practice account reset.')}>Reset practice account</Button>
              </div>
              {practice.data.resets > 0 && <p className="text-xs text-slate-500">Reset {practice.data.resets} time{practice.data.resets === 1 ? '' : 's'} so far.</p>}
            </>
          )}
        </div>
      </Card>
    </>
  );
}

export function ChallengeDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [sort, setSort] = useState('return');
  const { data, error, reload } = useLoad(() => api(`/challenges/${id}?sort=${sort}`), [id, sort]);
  const [msg, run] = useAction();
  if (error) return <><Link to="/challenges" className="tap text-sm text-emerald-400">Back to challenges</Link><Alert>{error}</Alert></>;
  if (!data) return <p className="text-slate-400">Loading…</p>;
  const { challenge: c, leaderboard: lb, rules, note } = data;
  const you = lb.you;
  return (
    <>
      <Link to="/challenges" className="tap text-sm text-emerald-400">Back to challenges</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{c.name}</h1><Badge tone={tone[c.status]}>{c.status}</Badge>
      </div>
      <p className="text-sm text-slate-400">
        {when(c.startsAt)} to {when(c.endsAt)} · {c.participants} {c.kind === 'weekly' ? 'on the public board' : 'taking part'}
      </p>
      <Alert kind={msg.kind}>{msg.text}</Alert>

      <Card title="Your standing">
        {!you.joined && (c.canJoin
          ? <Button onClick={() => run(async () => { await api(`/challenges/${c.id}/join`, { method: 'POST' }); reload(); }, 'You joined.')}>Join this challenge</Button>
          : <p className="text-sm text-slate-400">{c.joinBlockedReason ?? 'You have not joined.'}</p>)}
        {you.joined && (
          <div className="space-y-2 text-sm">
            {you.hidden && <p className="text-amber-300">You are hidden from this public leaderboard because you opted out (or your account is suspended).</p>}
            {you.eligible
              ? <p>Rank <b>{you.rank ?? '–'}</b> · return <b>{pct(you.returnPct)}</b> · profit <b>{money(you.profit)}</b> · {you.trades} trade{you.trades === 1 ? '' : 's'}</p>
              : <p className="text-slate-300">Not ranked yet: {you.reason}.</p>}
            {c.status !== 'ended' && (
              <Button variant="ghost" onClick={() => run(async () => { await api(`/challenges/${c.id}/leave`, { method: 'POST' }); if (c.kind === 'private') nav('/challenges'); else reload(); }, 'You left the challenge.')}>Leave challenge</Button>
            )}
          </div>
        )}
        {c.owner && c.code && (
          <div className="mt-4 border-t border-slate-800 pt-3 text-sm">
            <p>Invitation code: <b className="font-mono text-base" data-testid="invite-code">{c.code}</b></p>
            <p className="text-xs text-slate-400">Share it only with people you want to compete against. Joining closes {when(c.joinDeadline)}.</p>
            <Button variant="ghost" className="mt-2" onClick={() => run(async () => { await api(`/challenges/${c.id}/rotate-code`, { method: 'POST' }); reload(); }, 'New code created. The old one no longer works.')}>Make a new code</Button>
          </div>
        )}
      </Card>

      <Card title="Leaderboard" action={
        <div className="flex gap-1" role="group" aria-label="Rank by">
          {[['return', 'Return %'], ['profit', 'Profit']].map(([k, label]) => (
            <button key={k} onClick={() => setSort(k)} aria-pressed={sort === k} className={`rounded-md px-3 py-1 text-sm ${sort === k ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>{label}</button>
          ))}
        </div>}>
        <p className="mb-3 text-sm text-slate-400">{note}</p>
        <Table
          head={['#', 'Trader', 'Return', 'Profit']}
          empty={c.status === 'upcoming' ? 'The challenge has not started yet.' : 'Nobody is ranked yet. Make a trade to get on the board.'}
          rows={lb.ranked.map((r) => (
            <tr key={r.rank} className={r.you ? 'bg-emerald-500/10' : ''}>
              <td className={`${td} text-slate-400`}>{r.rank}</td>
              <td className={`${td} font-medium`}>{r.name}{r.you && <span className="ml-1 text-xs text-emerald-300">(you)</span>}<span className="block text-xs font-normal text-slate-400">{r.trades} trade{r.trades === 1 ? '' : 's'}</span></td>
              <td className={td}><span className={r.returnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{pct(r.returnPct)}</span></td>
              <td className={td}><span className={r.profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{money(r.profit)}</span></td>
            </tr>
          ))}
        />
        {lb.waiting.length > 0 && (
          <p className="mt-3 text-xs text-slate-400">Not ranked yet ({lb.waiting.length}): {lb.waiting.map((w) => w.name).join(', ')}</p>
        )}
      </Card>

      <Card title="How ranking works">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
          <li>Ranked by <b>percentage return</b>. Money you deposit or withdraw during the challenge is never counted as profit, and the return is worked out period by period around those moments.</li>
          <li>Measuring starts when the challenge starts, or when you join if that is later, and stops when it ends. Results are frozen at the end.</li>
          <li>You need at least one trade and {money(rules.minStartEquity)} of equity at the start to be ranked.</li>
          <li>Leaderboards show display names only. Anyone can opt out of public leaderboards.</li>
        </ul>
      </Card>
    </>
  );
}

export function Achievements() {
  const { data, error } = useLoad(() => api('/achievements'));
  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">Achievements</h1>
        <Link to="/challenges" className="tap text-sm text-emerald-400">Challenges</Link>
      </div>
      <Alert>{error}</Alert>
      {data && <p className="text-sm text-slate-400" data-testid="achievement-count">{data.earned} of {data.total} earned. Only you can see these.</p>}
      <ul className="grid gap-3 md:grid-cols-2" aria-label="Achievements">
        {(data?.achievements ?? []).map((a) => (
          <li key={a.key} className={`rounded-xl border p-4 ${a.earned ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-slate-800 bg-slate-900'}`}>
            <p className="flex items-center justify-between font-semibold">
              {a.title}
              <Badge tone={a.earned ? 'green' : 'slate'}>{a.earned ? 'Earned' : 'Not yet'}</Badge>
            </p>
            <p className="mt-1 text-sm text-slate-400">{a.description}</p>
            {a.earned && <p className="mt-1 text-xs text-slate-500">Earned {new Date(a.earnedAt).toLocaleDateString()}</p>}
          </li>
        ))}
      </ul>
    </>
  );
}
