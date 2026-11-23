import type { Context, Next } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { prisma } from '../lib/prisma.js';

// ── SSO-UQMP: adaptor auth Supabase PROD (pengganti JWT lokal, K1–K5) ────────
// Kontrak PM-0246 (FINAL): iss exact `https://sso.nathara.ac.id`, JWKS
// `https://api.nathara.ac.id/functions/v1/sso-jwks`, klaim `role` + `scopes`
// (kanonis `admin` / `UQMP`), sub = UUID (→ `supabase_sub`), TTL token 900.
// GAP B2: `aud` BELUM ada di kontrak → TIDAK divalidasi; bila butuh aud →
// STOP + eskalasi PM (JANGAN karang nilai). Validasi: iss + signature + exp
// + klaim role/scope. Guard: exact match, case-sensitive, TANPA normalisasi.

export const SSO_ISSUER = process.env.SSO_ISSUER_URL || 'https://sso.nathara.ac.id';
const SSO_JWKS_URL =
  process.env.SSO_JWKS_URL || 'https://api.nathara.ac.id/functions/v1/sso-jwks';
// Opsional, hanya bila kontrak B2 sudah FINAL dari PM Production.
// Kosong = lewati validasi aud (GAP B2 terbuka).
const SSO_AUDIENCE = process.env.SSO_AUDIENCE || '';
const CLOCK_SKEW_SECONDS = 60;
const DISCOVERY_TTL_MS = 3600_000; // 1 jam — pola KEEP dari scaffold sso.ts

const FORBIDDEN_MESSAGE =
  'Akses ditolak: butuh peran admin scope UQMP. Hubungi admin PJM.';

export interface SsoUser {
  userId: string;
  email: string;
  name: string;
  role: string;
  scope: string;
  orgId: string | null;
  supabaseSub: string;
  iat?: number;
  exp?: number;
}

// Kompat: beberapa route mengimpor tipe JwtPayload dari middleware lama.
export type JwtPayload = SsoUser;

export type Permission =
  | 'canView'
  | 'canEdit'
  | 'canApprove'
  | 'canAdmin'
  | 'canDelete'
  | 'canSign'
  | 'canExport';

// Matriks lama qa_* MATI untuk akses. Shim ini HANYA benar untuk admin
// (baris admin lama = semua true); peran lain tidak pernah lolos guard.
export function roleHasPermission(role: string, _permission: Permission | string): boolean {
  return role === 'admin';
}

// ── JWKS tunggal + backoff + circuit-breaker ringan (L-03) ──────────────────
// SATU cache JWKS untuk seluruh proses (dipakai middleware + routes SSO).
// Retry refetch HANYA untuk kid-unknown/JWKS-key (regex sempit — kata
// `signature` generik DILARANG agar token palsu tidak memicu refetch sia-sia).
// Gagal jaringan beruntun (≥3) → circuit terbuka 30 dtk (fail-closed cepat,
// tidak menghantam IdP). Catatan: in-memory, cukup untuk 1 replika staging.

const KID_UNKNOWN_RE = /kid|JWKS|no matching key|key.*not found|unknown key/i;
const JWKS_FETCH_FAIL_RE = /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|timeout|network/i;
const JWKS_MAX_FAILURES = 3;
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_MIN_REFRESH_INTERVAL_MS = 30_000;

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksUrlCached = '';
let jwksLastRefreshAt = 0;
let jwksFailures = 0;
let jwksBlockedUntil = 0;

export function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks || jwksUrlCached !== SSO_JWKS_URL) {
    jwks = createRemoteJWKSet(new URL(SSO_JWKS_URL));
    jwksUrlCached = SSO_JWKS_URL;
    jwksLastRefreshAt = Date.now();
  }
  return jwks;
}

function refreshJwks(): void {
  const now = Date.now();
  if (now - jwksLastRefreshAt < JWKS_MIN_REFRESH_INTERVAL_MS) {
    return; // backoff: jangan recreate lebih cepat dari interval
  }
  jwksLastRefreshAt = now;
  jwks = createRemoteJWKSet(new URL(SSO_JWKS_URL));
  jwksUrlCached = SSO_JWKS_URL;
  console.log('[sso-audit] JWKS prod di-refresh');
}

function noteJwksFailure(): void {
  jwksFailures += 1;
  if (jwksFailures >= JWKS_MAX_FAILURES) {
    jwksBlockedUntil = Date.now() + JWKS_COOLDOWN_MS;
    console.log('[sso-audit] JWKS circuit terbuka 30 dtk (gagal beruntun)');
  }
}

function noteJwksSuccess(): void {
  jwksFailures = 0;
  jwksBlockedUntil = 0;
}

/** Verifikasi JWT prod bersama (middleware + callback SSO memakai ini). */
export async function verifySsoJwt(token: string): Promise<JWTPayload> {
  if (Date.now() < jwksBlockedUntil) {
    throw new Error('JWKS circuit terbuka — IdP tidak terjangkau');
  }
  const verifyOpts: Record<string, unknown> = {
    issuer: SSO_ISSUER,
    clockTolerance: CLOCK_SKEW_SECONDS,
  };
  if (SSO_AUDIENCE) {
    verifyOpts.audience = SSO_AUDIENCE;
  }
  try {
    const { payload } = await jwtVerify(token, getJwks(), verifyOpts);
    noteJwksSuccess();
    return payload;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (KID_UNKNOWN_RE.test(msg)) {
      // kid tak dikenal (rotasi 24 jam) → refetch sekali lalu coba lagi
      refreshJwks();
      try {
        const { payload } = await jwtVerify(token, getJwks(), verifyOpts);
        noteJwksSuccess();
        return payload;
      } catch (retryErr: unknown) {
        if (JWKS_FETCH_FAIL_RE.test(retryErr instanceof Error ? retryErr.message : '')) {
          noteJwksFailure();
        }
        throw retryErr;
      }
    }
    if (JWKS_FETCH_FAIL_RE.test(msg)) {
      noteJwksFailure();
    }
    // Token palsu / expired / iss salah → langsung tolak, TANPA refetch.
    throw err;
  }
}

// ── Ekstraksi klaim role/scope — EXACT, tanpa normalisasi ────────────────────
// Klaim kanonis prod: `role` (string) + `scopes` (array string / string
// spasi-koma). Nilai yang diterima HANYA persis `admin` dan `UQMP`.
// DILARANG membaca peran dari lokasi klaim lain yang belum di-SSOT-kan
// (H-01: diselesaikan via SSOT PM Production + token-proof,
// BUKAN via fallback code). Bila klaim prod ternyata bernama/bernilai beda
// → tolak + eskalasi, JANGAN mapping diam-diam.

export function extractRoleScope(payload: JWTPayload): { role: string; scope: string } | null {
  const role = payload.role;
  if (typeof role !== 'string' || role !== 'admin') {
    return null;
  }
  const scopes = (payload as Record<string, unknown>).scopes;
  let scopeList: string[] = [];
  if (Array.isArray(scopes)) {
    scopeList = scopes.filter((s): s is string => typeof s === 'string');
  } else if (typeof scopes === 'string') {
    scopeList = scopes.split(/[\s,]+/);
  }
  if (!scopeList.includes('UQMP')) {
    return null;
  }
  return { role: 'admin', scope: 'UQMP' };
}

// ── Verifikasi JWT prod (stateless) ──────────────────────────────────────────

export interface VerifiedProdToken {
  sub: string;
  email: string;
  name: string;
  payload: JWTPayload;
}

export async function verifyProdToken(token: string): Promise<VerifiedProdToken | null> {
  let payload: JWTPayload;
  try {
    payload = await verifySsoJwt(token);
  } catch {
    return null;
  }
  try {
    if (typeof payload.sub !== 'string' || !payload.sub) {
      return null;
    }
    // EMAIL/NAME TIDAK ADA di JWT (B5) — jangan andalkan; diisi via linking.
    const email = typeof payload.email === 'string' ? payload.email : '';
    const name =
      (typeof payload.name === 'string' && payload.name) ||
      (typeof payload.preferred_username === 'string' && payload.preferred_username) ||
      '';
    return { sub: payload.sub, email, name: name || '', payload };
  } catch {
    return null;
  }
}

// ── Audit login/guard (best-effort, tanpa projectId → console) ──────────────

export async function auditSso(
  c: Context,
  action: 'sso.login' | 'sso.login_failed' | 'sso.logout' | 'auth.forbidden' | 'user.role_mapped',
  detail: Record<string, unknown>,
): Promise<void> {
  const line = `[sso-audit] ${action} ${JSON.stringify(detail)}`;
  try {
    const projectId =
      c.req.param('projectId') ||
      (detail.projectId as string | undefined) ||
      null;
    if (projectId) {
      await prisma.auditLog.create({
        data: {
          projectId,
          userId: (detail.supabaseSub as string | undefined) || 'sso',
          action,
          entityType: 'sso_session',
          entityId: (detail.supabaseSub as string | undefined) || 'unknown',
          newValue: detail as never,
          reason: (detail.reason as string | undefined) || undefined,
        },
      });
      return;
    }
  } catch {
    // best-effort: jangan gagalkan request karena audit
  }
  console.log(line);
}

// ── Allowlist mapping (auto-provision default MATI) ──────────────────────────
// Format env UQMP_SSO_ALLOWLIST_SUBS: "sub-uuid-1,sub-uuid-2" (via file VPS,
// nilai DILARANG di log). Selain allowlist → 403 + sso.login_failed.

function getAllowlist(): Set<string> {
  const raw = process.env.UQMP_SSO_ALLOWLIST_SUBS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// ── Resolusi mapping bersama (dipakai middleware + routes SSO) ───────────────
// Mengembalikan SsoUser bila klaim exact admin/UQMP + sub terpetakan;
// selain itu { error, status } (401 token tak valid sudah ditangani pemanggil,
// 403 default deny + audit sso.login_failed).

export async function resolveSsoUser(
  c: Context,
  verified: VerifiedProdToken,
): Promise<{ user: SsoUser } | { error: string; status: 403 }> {
  const roleScope = extractRoleScope(verified.payload);
  if (!roleScope) {
    await auditSso(c, 'sso.login_failed', {
      supabaseSub: verified.sub,
      reason: 'klaim role/scope bukan admin+UQMP exact',
    });
    return { error: FORBIDDEN_MESSAGE, status: 403 };
  }

  const mapped = await prisma.user.findUnique({
    where: { supabaseSub: verified.sub },
  });

  // L-01: guard kanonis = role AND scope dari baris DB (kolom scope hidup,
  // bukan literal). Selain admin+UQMP exact → 403 default deny.
  if (mapped && mapped.role === 'admin' && mapped.scope === 'UQMP') {
    await auditSso(c, 'sso.login', { supabaseSub: verified.sub, email: mapped.email });
    return {
      user: {
        userId: mapped.id,
        email: mapped.email,
        name: mapped.name,
        role: 'admin',
        scope: mapped.scope,
        orgId: mapped.orgId,
        supabaseSub: verified.sub,
        iat: verified.payload.iat,
        exp: verified.payload.exp,
      },
    };
  }

  // Auto-provision default MATI — hanya allowlist eksplisit human.
  if (getAllowlist().has(verified.sub)) {
    const provisioned = await provisionAllowlisted(c, verified);
    if (provisioned) {
      return { user: provisioned };
    }
    return { error: FORBIDDEN_MESSAGE, status: 403 };
  }

  await auditSso(c, 'sso.login_failed', {
    supabaseSub: verified.sub,
    reason: 'sub belum dipetakan ke admin/UQMP',
  });
  return { error: FORBIDDEN_MESSAGE, status: 403 };
}

// ── Middleware utama: validasi JWT prod → mapping admin/UQMP ─────────────────

export async function ssoAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ message: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  const verified = await verifyProdToken(token);
  if (!verified) {
    return c.json({ message: 'Token SSO tidak valid atau kedaluwarsa. Silakan login ulang.' }, 401);
  }

  const resolved = await resolveSsoUser(c, verified);
  if ('error' in resolved) {
    return c.json({ message: resolved.error }, resolved.status);
  }

  (c as unknown as { _user: SsoUser })._user = resolved.user;
  await next();
}

async function provisionAllowlisted(
  c: Context,
  verified: VerifiedProdToken,
): Promise<SsoUser | null> {
  try {
    // Linking email satu-kali: baris invite (supabaseSub null, email sama)
    // boleh diklaim; bila tidak ada baris invite → buat baris baru minimal.
    // Baris dengan supabaseSub terisi oleh sub LAIN tidak pernah dioverride.
    let row = verified.email
      ? await prisma.user.findUnique({ where: { email: verified.email } })
      : null;
    if (row && row.supabaseSub && row.supabaseSub !== verified.sub) {
      await auditSso(c, 'sso.login_failed', {
        supabaseSub: verified.sub,
        reason: 'email sudah terikat sub lain — butuh OTP/linking manual',
      });
      return null;
    }
    if (!row) {
      row = await prisma.user.create({
        data: {
          email: verified.email || `${verified.sub}@sso.local`,
          name: verified.name || 'SSO User',
          role: 'admin',
          scope: 'UQMP',
          supabaseSub: verified.sub,
        },
      });
    } else {
      row = await prisma.user.update({
        where: { id: row.id },
        data: { supabaseSub: verified.sub, role: 'admin', scope: 'UQMP' },
      });
    }
    await auditSso(c, 'user.role_mapped', {
      supabaseSub: verified.sub,
      email: row.email,
      reason: 'allowlist provision admin/UQMP',
    });
    return {
      userId: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      scope: row.scope,
      orgId: row.orgId,
      supabaseSub: verified.sub,
      iat: verified.payload.iat,
      exp: verified.payload.exp,
    };
  } catch {
    return null;
  }
}

// ── Guard akses: HANYA admin + UQMP (dipakai di semua route) ─────────────────

export function requireAdminUQMP() {
  return async (c: Context, next: Next) => {
    const user = getUser(c);
    if (!user) {
      return c.json({ message: 'Authentication required' }, 401);
    }
    if (user.role !== 'admin' || user.scope !== 'UQMP') {
      await auditSso(c, 'auth.forbidden', {
        supabaseSub: user.supabaseSub,
        reason: `guard menolak role=${user.role} scope=${user.scope}`,
      });
      return c.json({ message: FORBIDDEN_MESSAGE }, 403);
    }
    await next();
  };
}

export function getUser(c: Context): SsoUser {
  return (c as unknown as { _user: SsoUser })._user;
}

// ── Step-up e-sign (keputusan R1): JWT prod segar ≤300 dtk + method sso-reauth

export function isSsoFreshForEsign(user: SsoUser): boolean {
  if (typeof user.iat !== 'number') return false;
  return Date.now() / 1000 - user.iat <= 300;
}

export function discoveryCacheInfo() {
  return { ttlMs: DISCOVERY_TTL_MS, jwksUrl: SSO_JWKS_URL, issuer: SSO_ISSUER };
}
