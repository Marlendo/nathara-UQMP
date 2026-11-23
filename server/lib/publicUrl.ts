import type { Context } from 'hono';

// L-04: base URL publik (auditUrl/portalUrl) WAJIB dari allowlist exact —
// JANGAN dari header Origin/Referer mentah (vektor phish admin-lite).
// Allowlist = origin callback SSO (default https://pjm.nathara.ac.id) +
// localhost dev. Header tak cocok → abaikan + peringatan, pakai default.

function allowedOrigins(): string[] {
  const callback = process.env.SSO_CALLBACK_URL || 'https://pjm.nathara.ac.id/api/auth/sso/callback';
  let callbackOrigin = 'https://pjm.nathara.ac.id';
  try {
    callbackOrigin = new URL(callback).origin;
  } catch {
    // pakai default bila env tidak valid
  }
  return [callbackOrigin, 'http://localhost:5173', 'http://localhost:5174'];
}

export function resolvePublicBaseUrl(c: Context): string {
  const fallback = allowedOrigins()[0];
  const candidates = [c.req.header('origin'), c.req.header('referer')];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const origin = new URL(raw).origin;
      if (allowedOrigins().includes(origin)) {
        return origin;
      }
      console.log(`[sso-audit] public base URL ditolak (bukan allowlist): ${origin}`);
    } catch {
      // header bukan URL valid → abaikan
    }
  }
  return fallback;
}
