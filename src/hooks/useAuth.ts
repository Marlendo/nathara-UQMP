import { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import { createElement, type ReactNode } from 'react';
import {
  apiFetch,
  getApiBase,
  getStoredToken,
  getStoredRefreshToken,
  setStoredSession,
  clearStoredSession,
} from '../lib/apiClient';
import { isAdminUQMP } from '../lib/permissions';
import { useAuthStore } from '../store/useAuthStore';

// ── Types ───────────────────────────────────────────────────────────────────
// SSO-UQMP migrasi (K21): alur password (login/register/refreshToken lokal)
// DIMATIKAN. Sesi = JWT prod via SSO Nathara (stateless).

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  scope: string;
  orgId: string | null;
}

export interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  isAdminUQMP: boolean;
  isLoading: boolean;
  /** Tukar idToken prod → profil (dipakai callback SSO). */
  loginWithSsoToken: (idToken: string, refreshToken?: string) => Promise<void>;
  logout: () => void;
}

// ── Context ─────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthState | null>(null);

// ── Provider ────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [isLoading, setIsLoading] = useState<boolean>(() => getStoredToken() !== null);

  const isAuthenticated = !!user && !!token;

  const applyProfile = useCallback((profile: AuthUser, sessionToken: string, refreshToken?: string) => {
    setStoredSession({ token: sessionToken, refreshToken });
    setToken(sessionToken);
    setUser(profile);
    useAuthStore.getState().setProfile({
      id: profile.id,
      email: profile.email,
      displayName: profile.name,
      role: profile.role,
      scope: profile.scope,
    });
  }, []);

  const clearAll = useCallback(() => {
    clearStoredSession();
    setToken(null);
    setUser(null);
    useAuthStore.getState().clearProfile();
  }, []);

  const fetchMe = useCallback(async (sessionToken: string): Promise<AuthUser> => {
    const res = await apiFetch<{ user: AuthUser }>('/auth/sso/me', {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    return res.user;
  }, []);

  const refreshViaBackend = useCallback(async (): Promise<string | null> => {
    const rt = getStoredRefreshToken();
    if (!rt) return null;
    try {
      const res = await apiFetch<{ accessToken: string; idToken: string; refreshToken?: string }>(
        '/auth/sso/refresh',
        { method: 'POST', body: JSON.stringify({ refreshToken: rt }) },
      );
      const nextToken = res.idToken || res.accessToken;
      setStoredSession({ token: nextToken, refreshToken: res.refreshToken ?? rt });
      setToken(nextToken);
      return nextToken;
    } catch {
      return null;
    }
  }, []);

  // ── Validasi sesi tersimpan saat mount ────────────────────────────────────

  useEffect(() => {
    const storedToken = getStoredToken();
    if (!storedToken) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    async function validate() {
      try {
        const profile = await fetchMe(storedToken as string);
        if (!cancelled) {
          setUser(profile);
          useAuthStore.getState().setProfile({
            id: profile.id,
            email: profile.email,
            displayName: profile.name,
            role: profile.role,
            scope: profile.scope,
          });
        }
      } catch {
        try {
          const next = await refreshViaBackend();
          if (next && !cancelled) {
            const profile = await fetchMe(next);
            if (!cancelled) {
              setUser(profile);
              useAuthStore.getState().setProfile({
                id: profile.id,
                email: profile.email,
                displayName: profile.name,
                role: profile.role,
                scope: profile.scope,
              });
            }
          } else if (!cancelled) {
            clearAll();
          }
        } catch {
          if (!cancelled) {
            clearAll();
          }
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    validate();
    return () => { cancelled = true; };
  }, [fetchMe, refreshViaBackend, clearAll]);

  // ── Login via token SSO ───────────────────────────────────────────────────

  const loginWithSsoToken = useCallback(async (idToken: string, refreshToken?: string) => {
    const res = await apiFetch<{ user: AuthUser }>('/auth/sso/login', {
      method: 'POST',
      body: JSON.stringify({ idToken }),
    });
    applyProfile(res.user, idToken, refreshToken);
  }, [applyProfile]);

  // ── Logout (hapus sesi lokal + redirect portal) ───────────────────────────

  const logout = useCallback(() => {
    const base = getApiBase();
    clearAll();
    // Best-effort: beri tahu backend (audit) lalu ke portal.
    fetch(`${base}/auth/sso/logout`, {
      method: 'POST',
      headers: getStoredToken() ? { Authorization: `Bearer ${getStoredToken()}` } : {},
    }).catch(() => {});
  }, [clearAll]);

  // ── Value ─────────────────────────────────────────────────────────────────

  const value = useMemo<AuthState>(
    () => ({
      user,
      token,
      isAuthenticated,
      isAdminUQMP: isAdminUQMP(user),
      isLoading,
      loginWithSsoToken,
      logout,
    }),
    [user, token, isAuthenticated, isLoading, loginWithSsoToken, logout],
  );

  return createElement(AuthContext.Provider, { value }, children);
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
