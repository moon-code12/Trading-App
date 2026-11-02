import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Alert, Badge, Card, Table, useLoad } from '../components/ui.jsx';

const REASONS = {
  registered: 'Account created',
  recovery_code: 'Used a recovery code',
  bad_password: 'Wrong password',
  bad_2fa: 'Wrong two-factor code',
  locked: 'Blocked: account locked',
};

export default function LoginHistory() {
  const { data, error, loading } = useLoad(() => api('/auth/login-history'));
  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">Login history</h1>
        <Link to="/security" className="tap text-sm text-emerald-400">Back to security</Link>
      </div>
      <Card title="Recent sign-in attempts">
        {error && <Alert>{error}</Alert>}
        {loading && <p className="text-slate-400">Loading…</p>}
        {data && (
          <>
            <p className="mb-3 text-sm text-slate-400">The last 50 attempts on your account. If you see one you do not recognise, change your password and log out your other devices.</p>
            <Table
              head={['When', 'Result', 'Device', 'IP address']}
              empty="No sign-ins recorded yet."
              rows={data.events.map((e) => (
                <tr key={e.id}>
                  <td className="px-2 py-2 md:px-3">{new Date(e.at).toLocaleString()}</td>
                  <td className="px-2 py-2 md:px-3">
                    <Badge tone={e.success ? 'green' : 'red'}>{e.success ? 'Success' : 'Failed'}</Badge>
                    {REASONS[e.reason] && <span className="ml-2 text-xs text-slate-400">{REASONS[e.reason]}</span>}
                  </td>
                  <td className="px-2 py-2 md:px-3">{e.device}</td>
                  <td className="px-2 py-2 md:px-3">{e.ip || '–'}</td>
                </tr>
              ))}
            />
          </>
        )}
      </Card>
    </>
  );
}
