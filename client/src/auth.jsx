import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(!!localStorage.getItem('token'));

  const refresh = useCallback(async () => {
    try {
      setUser((await api('/auth/me')).user);
    } catch {
      localStorage.removeItem('token');
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (localStorage.getItem('token')) refresh(); }, [refresh]);

  const authenticate = async (path, body) => {
    const d = await api(path, { method: 'POST', body });
    localStorage.setItem('token', d.token);
    setUser(d.user);
  };
  // Ends this device's session on the server too, so the token stops working even if it was copied.
  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* already expired: nothing to revoke */ }
    localStorage.removeItem('token');
    setUser(null);
  };

  return <Ctx.Provider value={{ user, loading, refresh, logout, authenticate }}>{children}</Ctx.Provider>;
}
