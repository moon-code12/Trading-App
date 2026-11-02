import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { Alert, Button, Field } from '../components/ui.jsx';

export function Landing() {
  const { user } = useAuth();
  const features = [
    ['Four markets', 'Trade crypto, stocks, forex and commodities from one account.'],
    ['Practice risk-free', 'Every account starts with demo funds, so you can learn before going live.'],
    ['Secure by default', 'Two-factor authentication and identity verification protect your account.'],
  ];
  return (
    <div className="mx-auto max-w-5xl px-6">
      <header className="flex items-center justify-between py-5">
        <span className="text-lg font-bold text-emerald-400">TradeApp</span>
        <div className="flex gap-3 text-sm">
          {user ? <Link to="/dashboard" className="text-emerald-400">Dashboard</Link> : (<>
            <Link to="/login" className="px-3 py-2 text-slate-300 hover:text-white">Log in</Link>
            <Link to="/register" className="rounded-lg bg-emerald-500 px-4 py-2 font-semibold text-slate-950">Sign up</Link>
          </>)}
        </div>
      </header>
      <section className="py-20 text-center">
        <h1 className="text-4xl font-bold tracking-tight md:text-6xl">Trade smarter, <span className="text-emerald-400">start with demo funds</span></h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-slate-400">Build a portfolio across crypto, stocks, forex and commodities. Practice with simulated money first.</p>
        <Link to="/register" className="mt-8 inline-block rounded-lg bg-emerald-500 px-6 py-3 font-semibold text-slate-950 hover:bg-emerald-400">Create free account</Link>
      </section>
      <section className="grid gap-4 pb-20 md:grid-cols-3">
        {features.map(([t, d]) => (
          <div key={t} className="rounded-xl border border-slate-800 bg-slate-900 p-6">
            <h3 className="font-semibold">{t}</h3>
            <p className="mt-2 text-sm text-slate-400">{d}</p>
          </div>
        ))}
      </section>
      <p className="border-t border-slate-800 py-6 text-center text-xs text-slate-500">Prices are simulated. Nothing here is financial advice.</p>
    </div>
  );
}

function AuthShell({ title, children, footer }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900 p-6">
        <Link to="/" className="tap text-lg font-bold text-emerald-400">TradeApp</Link>
        <h1 className="mb-5 mt-2 text-xl font-semibold">{title}</h1>
        {children}
        <p className="mt-5 text-center text-sm text-slate-400">{footer}</p>
      </div>
    </div>
  );
}

function useForm(initial, onSubmit) {
  const [v, setV] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bind = (k) => ({ value: v[k], onChange: (e) => setV({ ...v, [k]: e.target.value }) });
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await onSubmit(v); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return { bind, submit, error, busy, setError, v, setV };
}

export function Login() {
  const { user, authenticate } = useAuth();
  const [needCode, setNeedCode] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const f = useForm({ email: '', password: '', code: '' }, async (v) => {
    try {
      await authenticate('/auth/login', { email: v.email, password: v.password, ...(useRecovery ? { recoveryCode: v.code || undefined } : { code: v.code || undefined }) });
    } catch (e) {
      if (e.data?.twoFactorRequired) setNeedCode(true);
      throw e;
    }
  });
  if (user) return <Navigate to="/dashboard" replace />;
  return (
    <AuthShell title="Log in" footer={<>No account? <Link to="/register" className="text-emerald-400">Sign up</Link></>}>
      <form onSubmit={f.submit} className="space-y-4">
        <Field label="Email" type="email" required {...f.bind('email')} />
        <Field label="Password" type="password" required {...f.bind('password')} />
        {needCode && (useRecovery
          ? <Field label="Recovery code" autoComplete="off" autoFocus placeholder="XXXXX-XXXXX" {...f.bind('code')} />
          : <Field label="Two-factor code" inputMode="numeric" maxLength={6} autoFocus {...f.bind('code')} />)}
        {needCode && (
          <button type="button" className="text-sm text-emerald-400" onClick={() => { setUseRecovery(!useRecovery); f.setV({ ...f.v, code: '' }); }}>
            {useRecovery ? 'Use my authenticator app instead' : 'Lost your device? Use a recovery code'}
          </button>
        )}
        <Alert>{f.error}</Alert>
        <Button className="w-full" disabled={f.busy}>{f.busy ? 'Signing in…' : 'Log in'}</Button>
        <p className="text-center text-sm"><Link to="/forgot-password" className="text-slate-400 hover:text-white">Forgot your password?</Link></p>
      </form>
    </AuthShell>
  );
}

export function Register() {
  const { user, authenticate } = useAuth();
  const nav = useNavigate();
  const f = useForm({ name: '', email: '', password: '' }, async (v) => {
    await authenticate('/auth/register', v);
    nav('/dashboard');
  });
  if (user) return <Navigate to="/dashboard" replace />;
  return (
    <AuthShell title="Create your account" footer={<>Already registered? <Link to="/login" className="text-emerald-400">Log in</Link></>}>
      <form onSubmit={f.submit} className="space-y-4">
        <Field label="Full name" required {...f.bind('name')} />
        <Field label="Email" type="email" required {...f.bind('email')} />
        <Field label="Password (8+ characters)" type="password" minLength={8} required {...f.bind('password')} />
        <Alert>{f.error}</Alert>
        <Button className="w-full" disabled={f.busy}>{f.busy ? 'Creating…' : 'Create account'}</Button>
      </form>
    </AuthShell>
  );
}

export function ForgotPassword() {
  const [sent, setSent] = useState('');
  const f = useForm({ email: '' }, async (v) => {
    setSent((await api('/auth/forgot-password', { method: 'POST', body: v })).message);
  });
  return (
    <AuthShell title="Forgot your password?" footer={<Link to="/login" className="text-emerald-400">Back to log in</Link>}>
      {sent ? <Alert kind="ok">{sent}</Alert> : (
        <form onSubmit={f.submit} className="space-y-4">
          <p className="text-sm text-slate-400">Enter your email and we will send you a link to choose a new password. The link works once and expires in 30 minutes.</p>
          <Field label="Email" type="email" required {...f.bind('email')} />
          <Alert>{f.error}</Alert>
          <Button className="w-full" disabled={f.busy}>{f.busy ? 'Sending…' : 'Send reset link'}</Button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [done, setDone] = useState(false);
  const f = useForm({ password: '', confirm: '' }, async (v) => {
    if (v.password !== v.confirm) throw new Error('The two passwords do not match');
    await api('/auth/reset-password', { method: 'POST', body: { token, password: v.password } });
    localStorage.removeItem('token');
    setDone(true);
  });
  return (
    <AuthShell title="Choose a new password" footer={<Link to="/login" className="text-emerald-400">Log in</Link>}>
      {!token && <Alert>This link is missing its token. Request a new one.</Alert>}
      {done && <Alert kind="ok">Password updated. All devices were signed out, so log in again.</Alert>}
      {token && !done && (
        <form onSubmit={f.submit} className="space-y-4">
          <Field label="New password (8+ characters)" type="password" minLength={8} required autoComplete="new-password" {...f.bind('password')} />
          <Field label="Confirm new password" type="password" minLength={8} required autoComplete="new-password" {...f.bind('confirm')} />
          <Alert>{f.error}</Alert>
          <Button className="w-full" disabled={f.busy}>{f.busy ? 'Saving…' : 'Update password'}</Button>
        </form>
      )}
    </AuthShell>
  );
}

export function VerifyEmail() {
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const [state, setState] = useState({ status: 'idle', error: '' });
  const token = params.get('token');
  const verify = async () => {
    try {
      await api(`/auth/verify-email?token=${encodeURIComponent(token)}`);
      setState({ status: 'done', error: '' });
      if (localStorage.getItem('token')) refresh();
    } catch (e) { setState({ status: 'error', error: e.message }); }
  };
  return (
    <AuthShell title="Verify your email" footer={<Link to="/dashboard" className="text-emerald-400">Go to dashboard</Link>}>
      {!token && <Alert>This link is missing its token.</Alert>}
      {token && state.status === 'idle' && <Button className="w-full" onClick={verify}>Confirm my email</Button>}
      {state.status === 'done' && <Alert kind="ok">Email verified. Thank you!</Alert>}
      {state.status === 'error' && <Alert>{state.error}</Alert>}
    </AuthShell>
  );
}
