import { meResponseSchema, type CurrentUser } from '@health-buddy/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, apiRequest, setUnauthenticatedHandler } from '../api/http';

export type AuthState =
  { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: CurrentUser };

interface AuthContextValue {
  state: AuthState;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    setUnauthenticatedHandler(() => setState({ status: 'anonymous' }));
    return () => setUnauthenticatedHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/auth/me', meResponseSchema)
      .then(({ user }) => !cancelled && setState({ status: 'authenticated', user }))
      .catch(() => !cancelled && setState({ status: 'anonymous' }));
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { user } = await apiRequest('/auth/login', meResponseSchema, {
      method: 'POST',
      body: { email, password },
    });
    setState({ status: 'authenticated', user });
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiRequest('/auth/logout', null, { method: 'POST' });
    } catch (err) {
      // 网络断了也先回到登录页；会话会在服务端过期。
      if (!(err instanceof ApiError)) throw err;
    }
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo(() => ({ state, login, logout }), [state, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
