import { useState } from 'react';
import { api, download, money } from '../api.js';
import { Alert, Badge, Button, Card, Field, Select, Table, statusTone, useLoad } from '../components/ui.jsx';

const when = (ms) => (ms ? new Date(ms).toLocaleString() : '–');
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined)).toString();
const td = 'px-3 py-2';

// Runs an action and reports success or the error text.
function useAction() {
  const [msg, setMsg] = useState({ kind: 'ok', text: '' });
  const run = async (fn, ok) => {
    setMsg({ kind: 'ok', text: '' });
    try { await fn(); setMsg({ kind: 'ok', text: ok }); return true; } catch (e) { setMsg({ kind: 'error', text: e.message }); return false; }
  };
  return [msg, run];
}

// ------------------------------------------------------------------ users

export function Users() {
  const [f, setF] = useState({ q: '', role: '', kyc: '', status: '', verified: '', sort: 'id', order: 'desc' });
  const [applied, setApplied] = useState(f);
  const [selected, setSelected] = useState(null);
  const list = useLoad(() => api(`/admin/users?${qs(applied)}`), [JSON.stringify(applied)]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  if (selected) return <UserDetail id={selected} back={() => { setSelected(null); list.reload(); }} />;
  return (
    <Card title="Users">
      <form className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
        <Field label="Search name, email or ID" value={f.q} onChange={set('q')} />
        <Select label="Role" value={f.role} onChange={set('role')}><option value="">Any</option><option value="user">User</option><option value="admin">Admin</option></Select>
        <Select label="KYC" value={f.kyc} onChange={set('kyc')}>
          <option value="">Any</option>{['none', 'pending', 'approved', 'rejected'].map((k) => <option key={k}>{k}</option>)}
        </Select>
        <Select label="Status" value={f.status} onChange={set('status')}><option value="">Any</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="locked">Locked out</option></Select>
        <Select label="Email verified" value={f.verified} onChange={set('verified')}><option value="">Any</option><option value="true">Verified</option><option value="false">Not verified</option></Select>
        <Select label="Sort by" value={f.sort} onChange={set('sort')}><option value="id">ID</option><option value="name">Name</option><option value="email">Email</option><option value="balance">Balance</option><option value="created">Joined</option></Select>
        <Select label="Order" value={f.order} onChange={set('order')}><option value="desc">Descending</option><option value="asc">Ascending</option></Select>
        <div className="flex items-end"><Button>Search</Button></div>
      </form>
      <Alert>{list.error}</Alert>
      <p className="mb-2 text-sm text-slate-400">{list.data ? `${list.data.total} user${list.data.total === 1 ? '' : 's'}` : 'Loading…'}</p>
      <Table
        head={['ID', 'Name', 'Email', 'Role', 'Status', 'KYC', 'Balance', '']}
        rows={(list.data?.users ?? []).map((u) => (
          <tr key={u.id}>
            <td className={`${td} text-slate-500`}>{u.id}</td>
            <td className={`${td} font-medium`}>{u.name}</td>
            <td className={td}>{u.email}</td>
            <td className={td}>{u.role}</td>
            <td className={td}>{u.suspended ? <Badge tone="red">suspended</Badge> : u.lockedUntil ? <Badge tone="amber">locked</Badge> : <Badge tone="green">active</Badge>}</td>
            <td className={td}><Badge tone={statusTone(u.kycStatus)}>{u.kycStatus}</Badge></td>
            <td className={td}>{money(u.balance)}</td>
            <td className={td}><Button variant="ghost" aria-label={`View ${u.email}`} onClick={() => setSelected(u.id)}>View</Button></td>
          </tr>
        ))}
      />
    </Card>
  );
}

function UserDetail({ id, back }) {
  const detail = useLoad(() => api(`/admin/users/${id}`), [id]);
  const portfolio = useLoad(() => api(`/admin/users/${id}/portfolio`), [id]);
  const orders = useLoad(() => api(`/admin/users/${id}/orders`), [id]);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('10000');
  const [msg, run] = useAction();
  const reloadAll = () => { detail.reload(); portfolio.reload(); orders.reload(); };
  const u = detail.data?.user;
  const post = (path, body, ok) => run(async () => { await api(`/admin/users/${id}/${path}`, { method: 'POST', body }); setReason(''); reloadAll(); }, ok);
  return (
    <>
      <div><Button variant="ghost" onClick={back}>Back to users</Button></div>
      <Alert>{detail.error}</Alert>
      {u && (
        <Card title={`${u.name} (#${u.id})`} action={u.suspended ? <Badge tone="red">suspended</Badge> : <Badge tone="green">active</Badge>}>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div><dt className="text-slate-400">Email</dt><dd>{u.email} {u.emailVerified ? '(verified)' : '(not verified)'}</dd></div>
            <div><dt className="text-slate-400">Role</dt><dd>{u.role}</dd></div>
            <div><dt className="text-slate-400">KYC</dt><dd>{u.kycStatus}</dd></div>
            <div><dt className="text-slate-400">Balance</dt><dd>{money(u.balance)}</dd></div>
            <div><dt className="text-slate-400">Two-factor</dt><dd>{u.twoFactorEnabled ? 'on' : 'off'}</dd></div>
            <div><dt className="text-slate-400">Joined</dt><dd>{u.createdAt}</dd></div>
            <div><dt className="text-slate-400">Orders (open)</dt><dd>{detail.data.counts.orders} ({detail.data.counts.openOrders})</dd></div>
            <div><dt className="text-slate-400">Pending withdrawals</dt><dd>{detail.data.counts.pendingWithdrawals}</dd></div>
            <div><dt className="text-slate-400">Active sessions</dt><dd>{detail.data.counts.activeSessions}</dd></div>
          </dl>
          {u.suspended && <p className="mt-3 text-sm text-rose-300">Suspended {when(u.suspendedAt)}: {u.suspendedReason}</p>}
          {u.lockedUntil && <p className="mt-3 text-sm text-amber-300">Locked out after failed logins until {when(u.lockedUntil)}.</p>}
          <div className="mt-4 grid max-w-xl gap-3">
            <Field label="Reason (recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="flex flex-wrap items-end gap-3">
              {u.suspended
                ? <Button onClick={() => post('restore', undefined, 'Account restored.')}>Restore account</Button>
                : <Button variant="danger" disabled={u.role === 'admin' || reason.trim().length < 3} onClick={() => post('suspend', { reason }, 'Account suspended.')}>Suspend account</Button>}
              <div className="w-40"><Field label="Reset balance to" type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
              <Button variant="ghost" disabled={reason.trim().length < 3 || amount === ''} onClick={() => post('reset-balance', { amount: Number(amount), reason }, 'Balance reset.')}>Reset balance</Button>
            </div>
            <Alert kind={msg.kind}>{msg.text}</Alert>
          </div>
        </Card>
      )}
      <Card title="Portfolio">
        <Alert>{portfolio.error}</Alert>
        <Table
          head={['Asset', 'Quantity', 'Avg cost', 'Value']}
          empty="No holdings."
          rows={(portfolio.data?.holdings ?? []).map((h) => (
            <tr key={h.symbol}><td className={`${td} font-medium`}>{h.symbol}</td><td className={td}>{h.quantity}</td><td className={td}>{money(h.avg_cost ?? h.avgCost)}</td><td className={td}>{money(h.value)}</td></tr>
          ))}
        />
      </Card>
      <Card title="Orders">
        <Table
          head={['#', 'Asset', 'Side', 'Type', 'Qty', 'Status']}
          empty="No orders."
          rows={(orders.data?.orders ?? []).map((o) => (
            <tr key={o.id}><td className={`${td} text-slate-500`}>{o.id}</td><td className={`${td} font-medium`}>{o.symbol}</td><td className={`${td} capitalize`}>{o.side}</td><td className={`${td} capitalize`}>{o.type}</td><td className={td}>{o.quantity}</td><td className={td}><Badge tone={statusTone(o.status)}>{o.status}</Badge></td></tr>
          ))}
        />
      </Card>
      <Card title="Recent sign-ins">
        <Table
          head={['When', 'Result', 'Device', 'IP']}
          rows={(detail.data?.recentLogins ?? []).map((l, i) => (
            <tr key={i}><td className={td}>{when(l.at)}</td><td className={td}><Badge tone={l.success ? 'green' : 'red'}>{l.success ? 'success' : 'failed'}</Badge> <span className="text-xs text-slate-400">{l.reason || ''}</span></td><td className={td}>{l.device}</td><td className={td}>{l.ip || '–'}</td></tr>
          ))}
        />
      </Card>
      <Card title="Administrator actions on this user">
        <AuditTable entries={detail.data?.recentAdminActions ?? []} />
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ withdrawals

export function Withdrawals() {
  const [status, setStatus] = useState('pending');
  const list = useLoad(() => api(`/admin/withdrawals?${qs({ status })}`), [status]);
  const [notes, setNotes] = useState({});
  const [msg, run] = useAction();
  const decide = (w, d) => run(async () => { await api(`/admin/withdrawals/${w.id}/${d}`, { method: 'POST', body: { note: notes[w.id] || undefined } }); list.reload(); }, d === 'approve' ? 'Approved.' : 'Rejected and funds returned.');
  return (
    <Card title="Withdrawal requests">
      <div className="mb-3 max-w-xs"><Select label="Show" value={status} onChange={(e) => setStatus(e.target.value)}><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="">All</option></Select></div>
      <Alert>{list.error}</Alert>
      <Alert kind={msg.kind}>{msg.text}</Alert>
      <Table
        head={['#', 'User', 'Amount', 'Requested', 'KYC', 'Status', 'Note', '']}
        empty="No requests."
        rows={(list.data?.withdrawals ?? []).map((w) => (
          <tr key={w.id}>
            <td className={`${td} text-slate-500`}>{w.id}</td>
            <td className={td}>{w.email}{w.userSuspended && <Badge tone="red">suspended</Badge>}</td>
            <td className={td}>{money(w.amount)}</td>
            <td className={td}>{when(w.createdAt)}</td>
            <td className={td}>{w.kycStatus}</td>
            <td className={td}><Badge tone={w.status === 'approved' ? 'green' : w.status === 'rejected' ? 'red' : 'amber'}>{w.status}</Badge></td>
            <td className={td}>
              {w.status === 'pending'
                ? <input aria-label={`Note for withdrawal ${w.id}`} className="w-40 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm" placeholder="Note (needed to reject)" value={notes[w.id] || ''} onChange={(e) => setNotes({ ...notes, [w.id]: e.target.value })} />
                : w.decisionNote}
            </td>
            <td className={`${td} flex gap-2`}>
              {w.status === 'pending' && (
                <>
                  <Button disabled={w.userSuspended} aria-label={`Approve withdrawal ${w.id}`} onClick={() => decide(w, 'approve')}>Approve</Button>
                  <Button variant="danger" disabled={!(notes[w.id] || '').trim()} aria-label={`Reject withdrawal ${w.id}`} onClick={() => decide(w, 'reject')}>Reject</Button>
                </>
              )}
            </td>
          </tr>
        ))}
      />
    </Card>
  );
}

// ------------------------------------------------------------------ assets

const BLANK_ASSET = { symbol: '', name: '', category: 'crypto', base: '', liquidity: '', volume: '', risk: 'medium', session: 'always' };

export function Assets() {
  const list = useLoad(() => api('/admin/assets'));
  const [form, setForm] = useState(BLANK_ASSET);
  const [spreads, setSpreads] = useState({});
  const [msg, run] = useAction();
  const setSpread = (symbol, value) => run(async () => {
    await api(`/admin/assets/${symbol}`, { method: 'PATCH', body: { spreadBps: value } });
    setSpreads({ ...spreads, [symbol]: undefined });
    list.reload();
  }, value === null ? `${symbol} spread restored to the default.` : `${symbol} spread set.`);
  const setStatus = (symbol, status) => run(async () => { await api(`/admin/assets/${symbol}`, { method: 'PATCH', body: { status } }); list.reload(); }, `${symbol} is now ${status}.`);
  const add = (e) => {
    e.preventDefault();
    run(async () => {
      await api('/admin/assets', { method: 'POST', body: { ...form, base: Number(form.base), liquidity: Number(form.liquidity), volume: Number(form.volume) } });
      setForm(BLANK_ASSET); list.reload();
    }, 'Asset added.');
  };
  const f = (k) => ({ value: form[k], onChange: (e) => setForm({ ...form, [k]: e.target.value }) });
  return (
    <>
      <Card title="Simulated assets">
        <p className="mb-3 text-sm text-slate-400">The spread is the gap between the price you can buy at and the price you can sell at, in basis points (100 = 1%). Leave it at the default or set one per asset. <b>Paused</b> assets stay visible but cannot be traded. <b>Disabled</b> assets are hidden and cannot be traded; existing holdings are still valued.</p>
        <Alert>{list.error}</Alert>
        <Alert kind={msg.kind}>{msg.text}</Alert>
        <Table
          head={['Symbol', 'Name', 'Category', 'Risk', 'Spread (bps)', 'Status', '']}
          rows={(list.data?.assets ?? []).map((a) => (
            <tr key={a.symbol}>
              <td className={`${td} font-medium`}>{a.symbol}{a.custom && <span className="ml-1 text-xs text-slate-400">(added)</span>}</td>
              <td className={td}>{a.name}</td><td className={td}>{a.category}</td><td className={td}>{a.risk}</td>
              <td className={td}>
                <div className="flex items-center gap-1">
                  <input type="number" min="0" max="1000" step="any" aria-label={`Spread in basis points for ${a.symbol}`} className="w-20 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
                    value={spreads[a.symbol] ?? a.spreadBps} onChange={(e) => setSpreads({ ...spreads, [a.symbol]: e.target.value })} />
                  <Button variant="ghost" aria-label={`Set spread for ${a.symbol}`} disabled={spreads[a.symbol] === undefined || spreads[a.symbol] === ''} onClick={() => setSpread(a.symbol, Number(spreads[a.symbol]))}>Set</Button>
                  {a.spreadOverridden && <Button variant="ghost" aria-label={`Restore default spread for ${a.symbol}`} onClick={() => setSpread(a.symbol, null)}>Default ({Number(a.defaultSpreadBps.toFixed(2))})</Button>}
                </div>
              </td>
              <td className={td}><Badge tone={a.status === 'active' ? 'green' : a.status === 'paused' ? 'amber' : 'red'}>{a.status}</Badge></td>
              <td className={`${td} flex gap-2`}>
                {a.status !== 'active' && <Button aria-label={`Activate ${a.symbol}`} onClick={() => setStatus(a.symbol, 'active')}>Activate</Button>}
                {a.status !== 'paused' && <Button variant="ghost" aria-label={`Pause ${a.symbol}`} onClick={() => setStatus(a.symbol, 'paused')}>Pause</Button>}
                {a.status !== 'disabled' && <Button variant="danger" aria-label={`Disable ${a.symbol}`} onClick={() => setStatus(a.symbol, 'disabled')}>Disable</Button>}
              </td>
            </tr>
          ))}
        />
      </Card>
      <Card title="Add an asset">
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={add}>
          <Field label="Symbol" required maxLength={12} {...f('symbol')} />
          <Field label="Name" required {...f('name')} />
          <Field label="Category" required {...f('category')} />
          <Select label="Risk" {...f('risk')}>{(list.data?.risks ?? ['low', 'medium', 'high']).map((r) => <option key={r}>{r}</option>)}</Select>
          <Field label="Base price" type="number" min="0" step="any" required {...f('base')} />
          <Field label="Liquidity per slot" type="number" min="0" step="any" required {...f('liquidity')} />
          <Field label="Typical 24h volume" type="number" min="0" step="any" required {...f('volume')} />
          <Select label="Market session" {...f('session')}>{(list.data?.sessions ?? ['always']).map((s) => <option key={s}>{s}</option>)}</Select>
          <div><Button>Add asset</Button></div>
        </form>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ announcements

export function Announcements() {
  const list = useLoad(() => api('/admin/announcements'));
  const [form, setForm] = useState({ title: '', message: '', level: 'info', expiresAt: '' });
  const [msg, run] = useAction();
  const create = (e) => {
    e.preventDefault();
    run(async () => {
      await api('/admin/announcements', { method: 'POST', body: { title: form.title, message: form.message, level: form.level, ...(form.expiresAt && { expiresAt: new Date(form.expiresAt).toISOString() }) } });
      setForm({ title: '', message: '', level: 'info', expiresAt: '' }); list.reload();
    }, 'Announcement published.');
  };
  const toggle = (a) => run(async () => { await api(`/admin/announcements/${a.id}`, { method: 'PATCH', body: { active: !a.active } }); list.reload(); }, a.active ? 'Switched off.' : 'Switched on.');
  return (
    <>
      <Card title="New announcement">
        <form className="grid max-w-xl gap-3" onSubmit={create}>
          <Field label="Title" required maxLength={100} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <Field label="Message" required maxLength={500} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
          <Select label="Level" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option></Select>
          <Field label="Hide after (optional)" type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
          <Alert kind={msg.kind}>{msg.text}</Alert>
          <div><Button>Publish</Button></div>
        </form>
      </Card>
      <Card title="Announcements">
        <Table
          head={['Title', 'Message', 'Level', 'Expires', 'Status', '']}
          empty="No announcements yet."
          rows={(list.data?.announcements ?? []).map((a) => (
            <tr key={a.id}>
              <td className={`${td} font-medium`}>{a.title}</td><td className={td}>{a.message}</td><td className={td}>{a.level}</td><td className={td}>{when(a.expiresAt)}</td>
              <td className={td}><Badge tone={a.active ? 'green' : 'slate'}>{a.active ? 'live' : 'off'}</Badge></td>
              <td className={td}><Button variant="ghost" aria-label={`${a.active ? 'Switch off' : 'Switch on'} ${a.title}`} onClick={() => toggle(a)}>{a.active ? 'Switch off' : 'Switch on'}</Button></td>
            </tr>
          ))}
        />
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ failed logins

export function FailedLogins() {
  const [f, setF] = useState({ email: '', reason: '' });
  const [applied, setApplied] = useState(f);
  const list = useLoad(() => api(`/admin/failed-logins?${qs(applied)}`), [JSON.stringify(applied)]);
  const REASON = { bad_password: 'Wrong password', bad_2fa: 'Wrong two-factor code', locked: 'Blocked (locked)' };
  return (
    <Card title="Failed login attempts">
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
        <Field label="Email contains" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <Select label="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}><option value="">Any</option>{Object.entries(REASON).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Button>Filter</Button>
      </form>
      <Alert>{list.error}</Alert>
      <p className="mb-2 text-sm text-slate-400">{list.data ? `${list.data.total} attempt${list.data.total === 1 ? '' : 's'}` : 'Loading…'}</p>
      <Table
        head={['When', 'Email', 'Account', 'Reason', 'Device', 'IP']}
        rows={(list.data?.attempts ?? []).map((a) => (
          <tr key={a.id}>
            <td className={td}>{when(a.at)}</td><td className={td}>{a.email}</td>
            <td className={td}>{a.accountExists ? (a.lockedUntil ? <Badge tone="amber">locked</Badge> : 'exists') : <span className="text-slate-500">no account</span>}</td>
            <td className={td}>{REASON[a.reason] || a.reason}</td><td className={td}>{a.device}</td><td className={td}>{a.ip || '–'}</td>
          </tr>
        ))}
      />
    </Card>
  );
}

// ------------------------------------------------------------------ audit log

function AuditTable({ entries }) {
  return (
    <Table
      head={['When', 'Administrator', 'Action', 'Target', 'Details']}
      empty="Nothing recorded."
      rows={entries.map((e) => (
        <tr key={e.id}>
          <td className={td}>{when(e.at)}</td>
          <td className={td}>{e.admin.email}</td>
          <td className={`${td} font-medium`}>{e.action}</td>
          <td className={td}>{e.targetType ? `${e.targetType} ${e.targetId ?? ''}` : '–'}</td>
          <td className={`${td} max-w-xs break-words text-xs text-slate-400`}>{e.details ? JSON.stringify(e.details) : ''}</td>
        </tr>
      ))}
    />
  );
}

export function AuditLog() {
  const [f, setF] = useState({ action: '', targetId: '' });
  const [applied, setApplied] = useState(f);
  const [offset, setOffset] = useState(0);
  const list = useLoad(() => api(`/admin/audit?${qs({ ...applied, limit: 50, offset })}`), [JSON.stringify(applied), offset]);
  return (
    <Card title="Administrator audit log">
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setOffset(0); setApplied(f); }}>
        <Field label="Action (e.g. user. or asset.status)" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} />
        <Field label="Target ID" value={f.targetId} onChange={(e) => setF({ ...f, targetId: e.target.value })} />
        <Button>Filter</Button>
      </form>
      <Alert>{list.error}</Alert>
      <AuditTable entries={list.data?.entries ?? []} />
      <div className="mt-3 flex items-center gap-3 text-sm text-slate-400">
        <Button variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Newer</Button>
        <span>{list.data ? `${list.data.total === 0 ? 0 : offset + 1}-${Math.min(offset + 50, list.data.total)} of ${list.data.total}` : ''}</span>
        <Button variant="ghost" disabled={!list.data || offset + 50 >= list.data.total} onClick={() => setOffset(offset + 50)}>Older</Button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ reports

const REPORTS = [
  ['users', 'Users', 'Names, emails, roles, status and balances.'],
  ['orders', 'Orders', 'Every order with its fill details.'],
  ['withdrawals', 'Withdrawal requests', 'Amounts, status and who decided.'],
  ['failed-logins', 'Failed logins', 'Every failed sign-in attempt.'],
  ['audit', 'Audit log', 'The full administrator audit trail.'],
  ['assets', 'Assets', 'The catalogue with each asset\'s status.'],
];

export function Reports() {
  const [msg, run] = useAction();
  return (
    <Card title="Export reports (CSV)">
      <p className="mb-3 text-sm text-slate-400">Each export is recorded in the audit log. Reports never include passwords, tokens, two-factor secrets or identity-document details.</p>
      <ul className="grid gap-3 md:grid-cols-2">
        {REPORTS.map(([id, label, text]) => (
          <li key={id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 p-3">
            <div><p className="font-medium">{label}</p><p className="text-xs text-slate-400">{text}</p></div>
            <Button variant="ghost" aria-label={`Download ${label} report`} onClick={() => run(() => download(`/admin/reports/${id}`, `admin-${id}.csv`), `${label} report downloaded.`)}>Download</Button>
          </li>
        ))}
      </ul>
      <div className="mt-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>
    </Card>
  );
}
