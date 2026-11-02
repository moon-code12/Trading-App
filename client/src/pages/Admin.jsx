import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, Badge, Button, Card, Table, statusTone, useLoad } from '../components/ui.jsx';
import { Announcements, Assets, AuditLog, FailedLogins, Reports, Users, Withdrawals } from './AdminTabs.jsx';

const TABS = [
  ['overview', 'Overview'], ['users', 'Users'], ['withdrawals', 'Withdrawals'], ['assets', 'Assets'],
  ['announcements', 'Announcements'], ['failed', 'Failed logins'], ['audit', 'Audit log'], ['reports', 'Reports'],
];

export default function Admin() {
  const { user } = useAuth();
  return user.role === 'admin' ? <AdminPanel /> : <Navigate to="/dashboard" replace />;
}

function AdminPanel() {
  const [tab, setTab] = useState('overview');
  return (
    <>
      <h1 className="text-2xl font-bold">Admin dashboard</h1>
      <nav aria-label="Admin sections" className="flex flex-wrap gap-1">
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === id ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>{label}</button>
        ))}
      </nav>
      {tab === 'overview' && <Overview go={setTab} />}
      {tab === 'users' && <Users />}
      {tab === 'withdrawals' && <Withdrawals />}
      {tab === 'assets' && <Assets />}
      {tab === 'announcements' && <Announcements />}
      {tab === 'failed' && <FailedLogins />}
      {tab === 'audit' && <AuditLog />}
      {tab === 'reports' && <Reports />}
    </>
  );
}

function Overview({ go }) {
  const stats = useLoad(() => api('/admin/stats'));
  const kyc = useLoad(() => api('/admin/kyc'));
  const orders = useLoad(() => api('/admin/orders'));

  const decide = async (id, decision) => {
    await api(`/admin/kyc/${id}/${decision}`, { method: 'POST' });
    kyc.reload(); stats.reload();
  };
  const tiles = [
    ['Users', 'users'], ['Suspended', 'suspendedUsers'], ['Orders', 'orders'], ['Filled orders', 'filledOrders'],
    ['Pending KYC', 'pendingKyc'], ['Pending withdrawals', 'pendingWithdrawals', 'withdrawals'], ['Failed logins (24h)', 'failedLogins24h', 'failed'],
  ];
  return (
    <>
      <Alert>{stats.error}</Alert>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {tiles.map(([l, k, link]) => (
          <Card key={k}>
            <p className="text-sm text-slate-400">{l}</p>
            <p className="text-2xl font-bold">{stats.data?.[k] ?? '…'}</p>
            {link && <button className="text-xs text-emerald-400" onClick={() => go(link)}>Open</button>}
          </Card>
        ))}
      </div>
      <Card title="KYC review queue">
        <Table
          head={['Name', 'Country', 'Document', 'Number', '']}
          empty="No pending submissions."
          rows={(kyc.data?.submissions ?? []).map((s) => (
            <tr key={s.id}>
              <td className="px-3 py-2 font-medium">{s.full_name}</td>
              <td className="px-3 py-2">{s.country}</td>
              <td className="px-3 py-2">{s.document_type}</td>
              <td className="px-3 py-2">{s.document_number}</td>
              <td className="flex gap-2 px-3 py-2">
                <Button onClick={() => decide(s.id, 'approve')}>Approve</Button>
                <Button variant="danger" onClick={() => decide(s.id, 'reject')}>Reject</Button>
              </td>
            </tr>
          ))}
        />
      </Card>
      <Card title="Recent orders">
        <Table
          head={['#', 'User', 'Asset', 'Side', 'Type', 'Qty', 'Status']}
          rows={(orders.data?.orders ?? []).slice(0, 50).map((o) => (
            <tr key={o.id}>
              <td className="px-3 py-2 text-slate-500">{o.id}</td>
              <td className="px-3 py-2">{o.user_id}</td>
              <td className="px-3 py-2 font-medium">{o.symbol}</td>
              <td className="px-3 py-2 capitalize">{o.side}</td>
              <td className="px-3 py-2 capitalize">{o.type}</td>
              <td className="px-3 py-2">{o.quantity}</td>
              <td className="px-3 py-2"><Badge tone={statusTone(o.status)}>{o.status}</Badge></td>
            </tr>
          ))}
        />
      </Card>
    </>
  );
}
