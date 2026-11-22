import { create } from 'zustand';
import { setAuthStoreRef } from './useAuditStore';

// SSO-UQMP migrasi (K23): auth demo client-side (simpleHash + password di
// localStorage + login/register/verifyForSignature lokal) DIHAPUS TOTAL.
// Store ini hanya menyimpan profil SSO (diset oleh useAuth setelah
// validasi backend). Tanpa password, tanpa hash, tanpa backdoor.

export interface SsoProfile {
  id: string;
  email: string;
  displayName: string;
  role: string;
  scope: string;
}

interface AuthStoreState {
  currentUser: SsoProfile | null;
  setProfile: (profile: SsoProfile | null) => void;
  clearProfile: () => void;
}

export const useAuthStore = create<AuthStoreState>()((set) => ({
  currentUser: null,

  setProfile: (profile) => {
    set({ currentUser: profile });
  },

  clearProfile: () => {
    set({ currentUser: null });
  },
}));

// Kompatibilitas audit trail lokal: identitas penanda dari profil SSO.
setAuthStoreRef(() => {
  const user = useAuthStore.getState().currentUser;
  return user ? { id: user.id, name: user.displayName } : null;
});
