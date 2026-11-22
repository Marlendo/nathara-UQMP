import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/useAuth';
import { Loader2, Shield, AlertTriangle } from 'lucide-react';
import { getApiBase, setStoredSession } from '../../lib/apiClient';

// SSO-UQMP migrasi (K22): form email+password + mode register DIHAPUS.
// Halaman ini SSO-only: tombol "Masuk dengan SSO Nathara" + error 403 jelas.
// NOL input password.

export function LoginPage() {
  const { t } = useTranslation();
  const { loginWithSsoToken } = useAuth();

  const [error, setError] = useState<string | null>(null);
  const [ssoExchanging, setSsoExchanging] = useState(false);
  const [ssoConfig, setSsoConfig] = useState<{ enabled: boolean; issuer?: string } | null>(null);

  // Status SSO + tangani callback: #sso_token=… (tukar via backend) atau
  // ?sso_error=… dari /api/auth/sso/callback.
  useEffect(() => {
    let cancelled = false;

    fetch(`${getApiBase()}/auth/sso/config`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setSsoConfig(data);
      })
      .catch(() => {
        if (!cancelled) setSsoConfig({ enabled: true });
      });

    const params = new URLSearchParams(window.location.search);
    const ssoError = params.get('sso_error');
    if (ssoError) {
      setError(decodeURIComponent(ssoError));
      window.history.replaceState(null, '', window.location.pathname);
    }

    const hash = window.location.hash;
    if (hash.includes('sso_token=')) {
      const token = hash.split('sso_token=')[1]?.split('&')[0];
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      if (token) {
        setSsoExchanging(true);
        // Tukar ssoToken 60-dtk → { user, idToken, refreshToken };
        // simpan sesi stateless lalu reload (AuthProvider validasi via /me).
        fetch(`${getApiBase()}/auth/sso/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
          .then(async (res) => {
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(body.message || 'SSO authentication failed');
            }
            return res.json() as Promise<{ idToken: string; refreshToken?: string }>;
          })
          .then((data) => {
            setStoredSession({ token: data.idToken, refreshToken: data.refreshToken });
            window.location.reload();
          })
          .catch((err: unknown) => {
            setError(err instanceof Error ? err.message : 'SSO authentication failed');
            setSsoExchanging(false);
          });
      }
    }

    return () => { cancelled = true; };
  }, []);

  // Alur token langsung (ditempel dari portal): ?id_token=…
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const idToken = params.get('id_token');
    if (!idToken) return;
    window.history.replaceState(null, '', window.location.pathname);
    setSsoExchanging(true);
    loginWithSsoToken(idToken)
      .then(() => {
        window.location.reload();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'SSO authentication failed');
        setSsoExchanging(false);
      });
  }, [loginWithSsoToken]);

  const handleSsoLogin = () => {
    window.location.href = `${getApiBase()}/auth/sso/login`;
  };

  if (ssoExchanging) {
    return (
      <div className="min-h-screen bg-surface-secondary flex items-center justify-center p-4">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-accent mx-auto mb-3" />
          <p className="text-sm text-text-secondary">Menyelesaikan masuk SSO...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-secondary flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo & branding */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-gradient-start to-gradient-end mb-4 shadow-lg">
            <span className="text-2xl font-bold text-white">NU</span>
          </div>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">Nathara UQMP</h1>
          <p className="text-sm text-text-secondary mt-1">
            University Quality Management Platform
          </p>
        </div>

        {/* Card */}
        <div className="bg-surface rounded-xl border border-border shadow-lg p-6">
          <button
            onClick={handleSsoLogin}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-text-primary bg-surface-secondary border border-border rounded-lg hover:bg-surface-hover transition-colors"
          >
            <Shield className="w-4 h-4 text-accent" />
            {t('sso.signInWithSso')}
          </button>

          {ssoConfig && (
            <p className="mt-3 text-xs text-text-tertiary text-center">
              SSO Nathara · {ssoConfig.issuer ?? 'sso.nathara.ac.id'}
            </p>
          )}

          {/* Error / 403 jelas */}
          {error && (
            <div className="mt-4 flex items-start gap-2 text-sm text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <p className="mt-4 text-xs text-text-tertiary text-center leading-relaxed">
            Akses hanya untuk peran admin scope UQMP. Selain itu akses ditolak — hubungi admin PJM.
          </p>
        </div>
      </div>
    </div>
  );
}
