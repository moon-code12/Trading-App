import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, Link } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { api, money } from './api.js';
import { Landing, Login, Register, VerifyEmail, ForgotPassword, ResetPassword } from './pages/Public.jsx';
import LoginHistory from './pages/LoginHistory.jsx';
import { Achievements, ChallengeDetail, Challenges } from './pages/Challenges.jsx';
import Kyc from './pages/Kyc.jsx';
import Dashboard from './pages/Dashboard.jsx';
import { Markets, Asset, Trade } from './pages/Markets.jsx';
import { Portfolio, Orders, Transactions, Wallet, Notifications } from './pages/Account.jsx';
import { Profile, Security } from './pages/Settings.jsx';
import Risk from './pages/Risk.jsx';
import Compare from './pages/Compare.jsx';
import OrderDetail from './pages/OrderDetail.jsx';
import Admin from './pages/Admin.jsx';

const nav = [
  ['/dashboard', 'Dashboard'], ['/markets', 'Markets'], ['/portfolio', 'Portfolio'], ['/orders', 'Orders'], ['/challenges', 'Challenges'],
  ['/transactions', 'Transactions'], ['/wallet', 'Wallet'], ['/notifications', 'Notifications'],
  ['/risk', 'Risk limits'], ['/kyc', 'Verification'], ['/profile', 'Profile'], ['/security', 'Security'],
];

const LEVEL_STYLE = { info: 'bg-sky-500/10 text-sky-200', warning: 'bg-amber-500/10 text-amber-200', critical: 'bg-rose-500/15 text-rose-200' };

// Platform announcements from the administrators; each can be dismissed on this device.
function Announcements() {
  const [items, setItems] = useState([]);
  const [hidden, setHidden] = useState(() => JSON.parse(localStorage.getItem('dismissedAnnouncements') || '[]'));
  useEffect(() => { api('/announcements').then((d) => setItems(d.announcements)).catch(() => {}); }, []);
  const dismiss = (id) => {
    const next = [...hidden, id];
    setHidden(next);
    localStorage.setItem('dismissedAnnouncements', JSON.stringify(next.slice(-50)));
  };
  return items.filter((a) => !hidden.includes(a.id)).map((a) => (
    <div key={a.id} role={a.level === 'info' ? 'status' : 'alert'} className={`flex items-start justify-between gap-3 px-3 py-2 text-sm sm:px-6 ${LEVEL_STYLE[a.level]}`}>
      <p><b>{a.title}</b> {a.message}</p>
      <button onClick={() => dismiss(a.id)} aria-label={`Dismiss announcement: ${a.title}`} className="shrink-0 underline">Dismiss</button>
    </div>
  ));
}

function Shell() {
  const { user, loading, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  if (loading) return <p className="p-8 text-slate-400">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  const link = ({ isActive }) =>
    `block rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-slate-800 text-emerald-400' : 'text-slate-300 hover:bg-slate-900'}`;
  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-slate-800 p-3 md:w-56 md:shrink-0 md:border-b-0 md:border-r md:p-4">
        <div className="flex items-center justify-between md:block">
          <Link to="/dashboard" className="tap text-lg font-bold text-emerald-400 md:mb-4 md:block">TradeApp</Link>
          <button type="button" className="rounded-lg border border-slate-700 px-3 text-sm text-slate-200 md:hidden" aria-expanded={menuOpen} aria-controls="main-nav" onClick={() => setMenuOpen((o) => !o)}>
            {menuOpen ? 'Close menu' : 'Menu'}
          </button>
        </div>
        <nav id="main-nav" aria-label="Main" className={`${menuOpen ? 'mt-2 flex' : 'hidden'} flex-wrap gap-1 md:mt-0 md:block md:space-y-1`}>
          {nav.map(([to, label]) => <NavLink key={to} to={to} className={link} onClick={() => setMenuOpen(false)}>{label}</NavLink>)}
          {user.role === 'admin' && <NavLink to="/admin" className={link} onClick={() => setMenuOpen(false)}>Admin</NavLink>}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-slate-800 px-3 py-2 sm:px-6 sm:py-3">
          <span className="text-sm text-slate-400">Demo balance <b className="text-slate-100">{money(user.balance)}</b></span>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-400">{user.name}</span>
            <button onClick={logout} className="px-2 text-slate-400 hover:text-white">Log out</button>
          </div>
        </header>
        {user.suspended && (
          <p role="alert" className="bg-rose-500/15 px-3 py-2 text-sm text-rose-200 sm:px-6">Your account is suspended. You can look around, but you cannot trade, deposit or withdraw. Contact support for help.</p>
        )}
        <Announcements />
        {!user.emailVerified && (
          <p className="bg-amber-500/10 px-3 py-2 text-sm text-amber-300 sm:px-6">Your email is not verified yet. Check your inbox for the link.</p>
        )}
        <main className="mx-auto max-w-5xl space-y-4 p-3 sm:space-y-6 sm:p-6"><Outlet /></main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<Shell />}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/markets" element={<Markets />} />
        <Route path="/markets/compare" element={<Compare />} />
        <Route path="/markets/:symbol" element={<Asset />} />
        <Route path="/trade/:symbol" element={<Trade />} />
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/:id" element={<OrderDetail />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/wallet" element={<Wallet />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/kyc" element={<Kyc />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/security" element={<Security />} />
        <Route path="/security/login-history" element={<LoginHistory />} />
        <Route path="/risk" element={<Risk />} />
        <Route path="/challenges" element={<Challenges />} />
        <Route path="/challenges/:id" element={<ChallengeDetail />} />
        <Route path="/achievements" element={<Achievements />} />
        <Route path="/admin" element={<Admin />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
