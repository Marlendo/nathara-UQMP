// SSO-UQMP: token = JWT prod (stateless). Base URL default =
// https://pjm.nathara.ac.id/api (override VITE_API_URL).
// Key storage nathara-uqmp:* (migrasi sekali dari key nathara-uqmp:* lama).

const DEFAULT_API_BASE = 'https://pjm.nathara.ac.id/api';

export const TOKEN_KEY = 'nathara-uqmp:token';
export const REFRESH_KEY = 'nathara-uqmp:refresh-token';
const API_URL_KEY = 'nathara-uqmp:api-url';

const LEGACY_KEYS: Record<string, string> = {
  [TOKEN_KEY]: 'nathara-uqmp:token',
  [REFRESH_KEY]: 'nathara-uqmp:refresh-token',
  [API_URL_KEY]: 'nathara-uqmp:api-url',
};

function migrateLegacyKey(newKey: string): void {
  try {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem(newKey) != null) return;
    const legacy = LEGACY_KEYS[newKey];
    if (!legacy) return;
    const value = localStorage.getItem(legacy);
    if (value != null) {
      localStorage.setItem(newKey, value);
    }
    localStorage.removeItem(legacy);
  } catch {
    // abaikan — storage tak tersedia
  }
}

[migrateLegacyKey(TOKEN_KEY), migrateLegacyKey(REFRESH_KEY), migrateLegacyKey(API_URL_KEY)];

export function getApiBase(): string {
  const storedApiBase = typeof window !== 'undefined'
    ? localStorage.getItem(API_URL_KEY)
    : null;

  return (storedApiBase || import.meta.env.VITE_API_URL || DEFAULT_API_BASE).replace(/\/$/, '');
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  migrateLegacyKey(TOKEN_KEY);
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredSession(params: { token: string; refreshToken?: string }): void {
  localStorage.setItem(TOKEN_KEY, params.token);
  if (params.refreshToken) {
    localStorage.setItem(REFRESH_KEY, params.refreshToken);
  } else {
    localStorage.removeItem(REFRESH_KEY);
  }
}

export function clearStoredSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export function getStoredRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  migrateLegacyKey(REFRESH_KEY);
  return localStorage.getItem(REFRESH_KEY);
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getStoredToken();
  const res = await fetch(`${getApiBase()}${normalizePath(path)}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || res.statusText);
  }
  return res.json();
}
