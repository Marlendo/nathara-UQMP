// SSO-UQMP migrasi (K24): matriks peran lama qa_* MATI untuk akses.
// Satu-satunya guard FE = isAdminUQMP (role=='admin' AND scope=='UQMP',
// exact match dari profil SSO). roleHasPermission dipertahankan untuk
// kompatibilitas komponen: hanya admin yang lolos.

export type AppPermission = 'canView' | 'canEdit' | 'canApprove' | 'canAdmin' | 'canDelete' | 'canSign' | 'canExport';

export interface SsoProfileLike {
  role?: string | null;
  scope?: string | null;
}

/** Guard kanonis FE: role == 'admin' AND scope == 'UQMP' (exact, tanpa normalisasi). */
export function isAdminUQMP(profile: SsoProfileLike | null | undefined): boolean {
  if (!profile) return false;
  return profile.role === 'admin' && profile.scope === 'UQMP';
}

export function roleHasPermission(role: string | null | undefined, _permission: AppPermission): boolean {
  if (!role) {
    return false;
  }

  return role === 'admin';
}
