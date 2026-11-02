import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, Field, useLoad } from '../components/ui.jsx';

function useAction() {
  const [msg, setMsg] = useState({ kind: 'ok', text: '' });
  const run = async (fn, okText) => {
    setMsg({ kind: 'ok', text: '' });
    try { await fn(); setMsg({ kind: 'ok', text: okText }); } catch (e) { setMsg({ kind: 'error', text: e.message }); }
  };
  return [msg, run];
}

export function Profile() {
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user.name);
  const [msg, run] = useAction();
  return (
    <>
      <h1 className="text-2xl font-bold">Profile and settings</h1>
      <Card title="Personal details">
        <form className="grid max-w-md gap-4" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/auth/profile', { method: 'PATCH', body: { name } }); await refresh(); }, 'Saved.'); }}>
          <Field label="Email" value={user.email} disabled readOnly />
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Alert kind={msg.kind}>{msg.text}</Alert>
          <div><Button>Save changes</Button></div>
        </form>
      </Card>
    </>
  );
}

// Shown once, right after they are created. They cannot be looked up again.
function RecoveryCodes({ codes, onDone }) {
  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4" role="region" aria-label="Recovery codes">
      <p className="text-sm text-amber-200">Save these recovery codes somewhere safe. Each works once if you lose your authenticator app. <b>They will not be shown again.</b></p>
      <ul className="grid grid-cols-2 gap-1 font-mono text-slate-100">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}>Copy</Button>
        <Button onClick={onDone}>I have saved them</Button>
      </div>
    </div>
  );
}

function Sessions() {
  const { data, error, reload } = useLoad(() => api('/auth/sessions'));
  const [msg, run] = useAction();
  return (
    <Card title="Active sessions and devices" action={<Link to="/security/login-history" className="tap text-sm text-emerald-400">Login history</Link>}>
      {error && <Alert>{error}</Alert>}
      <ul className="divide-y divide-slate-800" aria-label="Active sessions">
        {data?.sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
            <div>
              <p className="font-medium">{s.device} {s.current && <Badge tone="green">this device</Badge>}</p>
              <p className="text-xs text-slate-400">{s.ip || 'Unknown IP'} · signed in {new Date(s.createdAt).toLocaleString()} · last active {new Date(s.lastSeenAt).toLocaleString()}</p>
            </div>
            {!s.current && (
              <Button variant="danger" aria-label={`Log out ${s.device}, signed in ${new Date(s.createdAt).toLocaleString()}`}
                onClick={() => run(async () => { await api(`/auth/sessions/${s.id}`, { method: 'DELETE' }); reload(); }, 'Device logged out.')}>Log out</Button>
            )}
          </li>
        ))}
      </ul>
      {data?.sessions.length > 1 && (
        <div className="mt-3"><Button variant="danger" onClick={() => run(async () => { await api('/auth/sessions/revoke-others', { method: 'POST' }); reload(); }, 'All other devices were logged out.')}>Log out all other devices</Button></div>
      )}
      <div className="mt-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>
    </Card>
  );
}

export function Security() {
  const { user, refresh } = useAuth();
  const [codes, setCodes] = useState(null);
  const [status, setStatus] = useState(null);
  const [recMsg, runRec] = useAction();
  useEffect(() => {
    if (!user.twoFactorEnabled) { setStatus(null); return; }
    api('/auth/2fa/recovery-codes').then(setStatus).catch(() => setStatus(null));
  }, [user.twoFactorEnabled, codes]);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [pwMsg, runPw] = useAction();
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [tfMsg, runTf] = useAction();

  return (
    <>
      <h1 className="text-2xl font-bold">Security</h1>
      <Card title="Change password">
        <form className="grid max-w-md gap-4" onSubmit={(e) => { e.preventDefault(); runPw(async () => { await api('/auth/change-password', { method: 'POST', body: pw }); setPw({ currentPassword: '', newPassword: '' }); }, 'Password updated.'); }}>
          <Field label="Current password" type="password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
          <Field label="New password (8+ characters)" type="password" minLength={8} required value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
          <Alert kind={pwMsg.kind}>{pwMsg.text}</Alert>
          <div><Button>Update password</Button></div>
        </form>
      </Card>
      <Card title="Two-factor authentication" action={<Badge tone={user.twoFactorEnabled ? 'green' : 'slate'}>{user.twoFactorEnabled ? 'enabled' : 'off'}</Badge>}>
        <div className="max-w-md space-y-4">
          {!user.twoFactorEnabled && !setup && (
            <Button onClick={() => runTf(async () => setSetup(await api('/auth/2fa/setup', { method: 'POST' })), '')}>Set up authenticator app</Button>
          )}
          {setup && !user.twoFactorEnabled && (
            <>
              <p className="text-sm text-slate-400">Add this key to an authenticator app (Google Authenticator, Authy, 1Password), then enter the 6-digit code.</p>
              <code className="block break-all rounded-lg bg-slate-950 p-3 text-emerald-300">{setup.secret}</code>
              <a className="tap text-sm text-emerald-400" href={setup.otpauthUrl}>Open in authenticator app</a>
            </>
          )}
          {(setup || user.twoFactorEnabled) && (
            <Field label={user.twoFactorEnabled ? '6-digit code (or a recovery code to disable)' : '6-digit code'} autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
          )}
          {setup && !user.twoFactorEnabled && (
            <Button onClick={() => runTf(async () => { const r = await api('/auth/2fa/enable', { method: 'POST', body: { code } }); setSetup(null); setCode(''); setCodes(r.recoveryCodes); await refresh(); }, 'Two-factor enabled.')}>Enable</Button>
          )}
          {user.twoFactorEnabled && (
            <Button variant="danger" onClick={() => runTf(async () => { await api('/auth/2fa/disable', { method: 'POST', body: code.trim().length > 6 ? { recoveryCode: code } : { code } }); setCode(''); await refresh(); }, 'Two-factor disabled.')}>Disable</Button>
          )}
          <Alert kind={tfMsg.kind}>{tfMsg.text}</Alert>
          {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
          {user.twoFactorEnabled && !codes && status && (
            <div className="space-y-2 border-t border-slate-800 pt-4">
              <p className="text-sm text-slate-300">Recovery codes: <b>{status.remaining}</b> unused{status.expiresAt && <>, the oldest expires {new Date(status.expiresAt).toLocaleDateString()}</>}.</p>
              <Button variant="ghost" disabled={code.trim().length !== 6}
                onClick={() => runRec(async () => { const r = await api('/auth/2fa/recovery-codes', { method: 'POST', body: { code } }); setCode(''); setCodes(r.recoveryCodes); }, '')}>Generate new recovery codes</Button>
              <p className="text-xs text-slate-500">Enter your current 6-digit code above first. New codes replace the old ones.</p>
              <Alert kind={recMsg.kind}>{recMsg.text}</Alert>
            </div>
          )}
        </div>
      </Card>
      <Sessions />
    </>
  );
}
