import { lazy, Suspense } from 'react';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { AppShell } from './components/layout/AppShell';
import { LoginPage } from './components/auth/LoginPage';
import { ShieldAlert } from 'lucide-react';

const AuditModeView = lazy(() => import('./components/audit/AuditModeView').then((m) => ({ default: m.AuditModeView })));
const SupplierPortalView = lazy(() => import('./components/suppliers/SupplierPortalView').then((m) => ({ default: m.SupplierPortalView })));

/**
 * Check if the current URL is an audit mode link: /audit/{token}
 */
function getAuditToken(): string | null {
  const path = window.location.pathname;
  const match = path.match(/^\/audit\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * Check if the current URL is a supplier portal link: /supplier/{token}
 */
function getSupplierPortalToken(): string | null {
  const path = window.location.pathname;
  const match = path.match(/^\/supplier\/(.+)$/);
  return match ? match[1] : null;
}

function ForbiddenPage() {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-screen bg-surface-secondary flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/30 mb-4">
          <ShieldAlert className="w-8 h-8 text-red-500" />
        </div>
        <h1 className="text-xl font-bold text-text-primary">Akses Ditolak (403)</h1>
        <p className="text-sm text-text-secondary mt-2 leading-relaxed">
          Akses ditolak: butuh peran admin scope UQMP. Hubungi admin PJM.
          {user && (
            <>
              <br />
              <span className="text-text-tertiary">
                Masuk sebagai {user.email} (role: {user.role}, scope: {user.scope || '-'}).
              </span>
            </>
          )}
        </p>
        <button
          onClick={logout}
          className="mt-6 px-4 py-2 text-sm font-medium text-text-primary bg-surface border border-border rounded-lg hover:bg-surface-hover transition-colors"
        >
          Keluar & masuk ulang SSO
        </button>
      </div>
    </div>
  );
}

function AppContent() {
  const { isAuthenticated, isAdminUQMP, isLoading, user } = useAuth();

  // Check for audit mode URL — token-link read-only (signing kunci app baru)
  const auditToken = getAuditToken();
  if (auditToken) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-surface-secondary flex items-center justify-center">
          <div className="h-6 w-6 rounded-full border-2 border-accent border-t-transparent animate-spin" />
        </div>
      }>
        <AuditModeView token={auditToken} />
      </Suspense>
    );
  }

  // Check for supplier portal URL — token-link read-only
  const supplierToken = getSupplierPortalToken();
  if (supplierToken) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-surface-secondary flex items-center justify-center">
          <div className="h-6 w-6 rounded-full border-2 border-accent border-t-transparent animate-spin" />
        </div>
      }>
        <SupplierPortalView token={supplierToken} />
      </Suspense>
    );
  }

  // SSO-UQMP: standalone tanpa auth DIMATIKAN (K26). Server-mode only.
  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface-secondary flex items-center justify-center">
        <div className="h-6 w-6 rounded-full border-2 border-accent border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <LoginPage />;
  }

  // Guard kanonis FE: role == 'admin' AND scope == 'UQMP' (exact).
  if (!isAdminUQMP) {
    return <ForbiddenPage />;
  }

  return <AppShell />;
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
