import { useState, useMemo } from 'react';

export type AppMode = 'standalone' | 'server';

// SSO-UQMP migrasi (K26): mode standalone TANPA auth DIMATIKAN untuk deploy.
// Server-mode selalu (SSO wajib). Key storage nathara-uqmp:*.

const MODE_KEY = 'nathara-uqmp:mode';
const API_URL_KEY = 'nathara-uqmp:api-url';

function getInitialMode(): AppMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (stored === 'server') return 'server';
    // Migrasi sekali dari key lama
    if (localStorage.getItem('nathara-uqmp:mode') === 'server') {
      localStorage.setItem(MODE_KEY, 'server');
    }
    localStorage.removeItem('nathara-uqmp:mode');
  } catch {
    // abaikan
  }
  return 'server';
}

function getInitialApiUrl(): string | null {
  try {
    const stored = localStorage.getItem(API_URL_KEY);
    if (stored) return stored;
    const legacy = localStorage.getItem('nathara-uqmp:api-url');
    if (legacy) {
      localStorage.setItem(API_URL_KEY, legacy);
      localStorage.removeItem('nathara-uqmp:api-url');
      return legacy;
    }
  } catch {
    // abaikan
  }
  return import.meta.env.VITE_API_URL || null;
}

export function useAppMode() {
  const [mode] = useState<AppMode>(getInitialMode);
  const [apiUrl] = useState<string | null>(getInitialApiUrl);

  return useMemo(
    () => ({
      mode,
      apiUrl,
      // Disediakan untuk kompat; standalone tidak lagi didukung (selalu server).
      setServerMode: (_url: string) => {},
      setStandaloneMode: () => {},
    }),
    [mode, apiUrl],
  );
}
