import { useState } from 'react';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { Alert, Badge, Button, Card, Field, Select, statusTone } from '../components/ui.jsx';

export default function Kyc() {
  const { user, refresh } = useAuth();
  const [v, setV] = useState({ fullName: '', dateOfBirth: '', country: '', documentType: 'passport', documentNumber: '' });
  const [error, setError] = useState('');
  const bind = (k) => ({ value: v[k], onChange: (e) => setV({ ...v, [k]: e.target.value }) });
  const locked = ['pending', 'approved'].includes(user.kycStatus);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api('/kyc', { method: 'POST', body: v });
      await refresh();
    } catch (err) { setError(err.message); }
  };

  return (
    <>
      <h1 className="text-2xl font-bold">Identity verification</h1>
      <Card title="Status">
        <div className="flex items-center gap-3">
          <Badge tone={statusTone(user.kycStatus)}>{user.kycStatus === 'none' ? 'not submitted' : user.kycStatus}</Badge>
          <p className="text-sm text-slate-400">
            {user.kycStatus === 'approved' && 'You are verified and can withdraw funds.'}
            {user.kycStatus === 'pending' && 'We are reviewing your details.'}
            {user.kycStatus === 'rejected' && 'Your submission was rejected. Please check your details and try again.'}
            {user.kycStatus === 'none' && 'Verification is required before withdrawing or trading with real money.'}
          </p>
        </div>
      </Card>
      {!locked && (
        <Card title="Submit your details">
          <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
            <Field label="Full legal name" required {...bind('fullName')} />
            <Field label="Date of birth" type="date" required {...bind('dateOfBirth')} />
            <Field label="Country" required {...bind('country')} />
            <Select label="Document type" {...bind('documentType')}>
              <option value="passport">Passport</option>
              <option value="national_id">National ID</option>
              <option value="drivers_license">Driver&apos;s license</option>
            </Select>
            <Field label="Document number" required minLength={4} {...bind('documentNumber')} />
            <div className="flex items-end"><Button>Submit for review</Button></div>
            <div className="md:col-span-2"><Alert>{error}</Alert></div>
          </form>
        </Card>
      )}
    </>
  );
}
