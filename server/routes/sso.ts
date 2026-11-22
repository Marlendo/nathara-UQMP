import { Hono } from 'hono';
import { prisma } from '../lib/prisma.js';
import {
  ssoAuthMiddleware,
  getUser,
  verifyProdToken,
  resolveSsoUser,
  auditSso,
  type VerifiedProdToken,
} from '../middleware/ssoAuth.js';
import * as crypto from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// ── SSO-UQMP: adaptor Supabase PROD (ADAPTASI TOTAL K12–K14) ─────────────────
// IdP: https://api.nathara.ac.id (PROD). Kontrak PM-0246 FINAL:
// iss exact https://sso.nathara.ac.id; JWKS live
// https://api.nathara.ac.id/functions/v1/sso-jwks (rotasi overlap 24 jam,
// kid tak dikenal → refetch); klaim role+scopes (admin/UQMP exact);
// sub=UUID (→ supabase_sub); EMAIL/NAME TIDAK di JWT (linking via allowlist/
// invite + OTP, BUKAN lookup email bebas); TTL token 900; sesi stateless
// (JWT prod langsung, DILARANG JWT HS256 lokal); logout redirect portal;
// e-sign step-up now-iat≤300 (R1); assign di prod (UQMP hanya mapping).
// GAP B2: aud BELUM ada → validasi iss+signature+exp+klaim; SSO_AUDIENCE
// hanya diisi bila kontrak B2 FINAL, JANGAN karang nilai.
// Callback allowlist exact (sudah live di bundle portal post-redeploy):
// https://pjm.nathara.ac.id/api/auth/sso/callback

const sso = new Hono();

const SSO_ISSUER = process.env.SSO_ISSUER_URL || 'https://sso.nathara.ac.id';
const SSO_JWKS_URL =
  process.env.SSO_JWKS_URL || 'https://api.nathara.ac.id/functions/v1/sso-jwks';
const SSO_AUDIENCE = process.env.SSO_AUDIENCE || '';
const SSO_CLIENT_ID = process.env.SSO_CLIENT_ID || '';
const SSO_CLIENT_SECRET = process.env.SSO_CLIENT_SECRET || '';
const SSO_CALLBACK_URL =
  process.env.SSO_CALLBACK_URL || 'https://pjm.nathara.ac.id/api/auth/sso/callback';
// Endpoint otorisasi IdP: dari discovery bila ada, override via env bila tidak.
const SSO_AUTHORIZATION_URL = process.env.SSO_AUTHORIZATION_URL || '';
const SSO_TOKEN_URL = process.env.SSO_TOKEN_URL || '';
const SSO_LOGOUT_URL = process.env.SSO_LOGOUT_URL || SSO_ISSUER;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://api.nathara.ac.id';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const CLOCK_SKEW_SECONDS = 60;
const DISCOVERY_TTL_MS = 3600_000; // 1 jam — KEEP pola scaffold (K14)

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

let discoveryCache: OidcDiscovery | null = null;
let discoveryCacheTime = 0;
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

async function getOidcDiscovery(): Promise<OidcDiscovery | null> {
  if (discoveryCache && Date.now() - discoveryCacheTime < DISCOVERY_TTL_MS) {
    return discoveryCache;
  }
  try {
    const url = `${SSO_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) return null;
    discoveryCache = (await res.json()) as OidcDiscovery;
    discoveryCacheTime = Date.now();
    jwksCache = null;
    return discoveryCache;
  } catch {
    return null;
  }
}

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(new URL(SSO_JWKS_URL));
  }
  return jwksCache;
}

// In-memory state store for CSRF (single instance; dibersihkan berkala)
const stateStore = new Map<string, { nonce: string; createdAt: number }>();

function cleanStates() {
  const now = Date.now();
  for (const [key, val] of stateStore.entries()) {
    if (now - val.createdAt > 600_000) {
      stateStore.delete(key);
    }
  }
}

// In-memory SSO exchange store: ssoToken -> { verified, idToken, refreshToken, createdAt } (60 dtk)
const ssoTokenStore = new Map<string, { verified: VerifiedProdToken; idToken: string; refreshToken?: string; createdAt: number }>();

function cleanSsoTokens() {
  const now = Date.now();
  for (const [key, val] of ssoTokenStore.entries()) {
    if (now - val.createdAt > 60_000) {
      ssoTokenStore.delete(key);
    }
  }
}

// ── GET /config — public SSO status (tanpa secret) ──────────────────────────

sso.get('/config', (c) => {
  return c.json({
    enabled: true,
    provider: 'supabase-prod',
    issuer: SSO_ISSUER,
    jwksUrl: SSO_JWKS_URL,
    callbackUrl: SSO_CALLBACK_URL,
  });
});

// ── POST /login — tukar idToken prod → profil (SPA / curl) ───────────────────
// Body: { idToken }. Validasi JWKS → mapping admin/UQMP → 200 { user }.
// Token prod ITU sesi (stateless); FE menyimpannya sebagai Bearer.

sso.post('/login', async (c) => {
  try {
    const body = await c.req.json();
    const idToken = body.idToken || body.access_token;
    if (!idToken) {
      return c.json({ message: 'idToken is required' }, 400);
    }

    const verified = await verifyProdToken(idToken);
    if (!verified) {
      await auditSso(c, 'sso.login_failed', { reason: 'idToken tidak valid/kedaluwarsa' });
      return c.json({ message: 'Token SSO tidak valid atau kedaluwarsa.' }, 401);
    }

    const resolved = await resolveSsoUser(c, verified);
    if ('error' in resolved) {
      return c.json({ message: resolved.error }, resolved.status);
    }

    const { user } = resolved;
    return c.json({
      user: {
        id: user.userId,
        email: user.email,
        name: user.name,
        role: user.role,
        scope: user.scope,
        orgId: user.orgId,
      },
    });
  } catch (error: unknown) {
    console.error('SSO login error:', error);
    return c.json({ message: 'SSO login failed' }, 500);
  }
});

// ── POST /refresh — refresh via Supabase prod (tanpa lib baru) ───────────────
// Body: { refreshToken }. Diteruskan ke /auth/v1/token?grant_type=refresh_token.

sso.post('/refresh', async (c) => {
  try {
    const body = await c.req.json();
    if (!body.refreshToken) {
      return c.json({ message: 'refreshToken is required' }, 400);
    }
    if (!SUPABASE_ANON_KEY) {
      return c.json({ message: 'Refresh SSO belum dikonfigurasi di server.' }, 503);
    }

    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ refresh_token: body.refreshToken }),
    });

    if (!res.ok) {
      await auditSso(c, 'sso.login_failed', { reason: 'refresh token ditolak prod' });
      return c.json({ message: 'Refresh token tidak valid. Silakan login ulang SSO.' }, 401);
    }

    const data = await res.json();
    return c.json({
      accessToken: data.access_token,
      idToken: data.id_token ?? data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in ?? 900,
    });
  } catch (error: unknown) {
    console.error('SSO refresh error:', error);
    return c.json({ message: 'SSO refresh failed' }, 500);
  }
});

// ── GET /login — mulai alur authorization-code (redirect IdP) ────────────────

sso.get('/login', async (c) => {
  try {
    const discovery = await getOidcDiscovery();
    const authorizationEndpoint =
      SSO_AUTHORIZATION_URL || discovery?.authorization_endpoint || '';

    if (!authorizationEndpoint) {
      return c.json(
        { message: 'Alur redirect SSO belum dikonfigurasi (tanpa authorization endpoint). Gunakan POST /api/auth/sso/login dengan idToken.' },
        503,
      );
    }

    const state = crypto.randomBytes(32).toString('hex');
    const nonce = crypto.randomBytes(32).toString('hex');

    cleanStates();
    stateStore.set(state, { nonce, createdAt: Date.now() });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: SSO_CLIENT_ID,
      redirect_uri: SSO_CALLBACK_URL,
      scope: 'openid profile email',
      state,
      nonce,
    });

    return c.redirect(`${authorizationEndpoint}?${params.toString()}`);
  } catch (error: unknown) {
    console.error('SSO login initiation error:', error);
    return c.json({ message: 'Failed to initiate SSO login' }, 500);
  }
});

// ── GET /callback — IdP redirect ke sini (allowlist exact di portal) ─────────
// URL exact: https://pjm.nathara.ac.id/api/auth/sso/callback

sso.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const errorParam = c.req.query('error');

  if (errorParam) {
    const errorDesc = c.req.query('error_description') || errorParam;
    return c.redirect(`/?sso_error=${encodeURIComponent(errorDesc)}`);
  }

  if (!code || !state) {
    return c.redirect('/?sso_error=Missing+code+or+state');
  }

  const storedState = stateStore.get(state);
  if (!storedState) {
    return c.redirect('/?sso_error=Invalid+or+expired+state');
  }
  stateStore.delete(state);

  try {
    const discovery = await getOidcDiscovery();
    const tokenEndpoint = SSO_TOKEN_URL || discovery?.token_endpoint || '';

    if (!tokenEndpoint) {
      return c.redirect('/?sso_error=Token+endpoint+not+configured');
    }

    const tokenRes = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SSO_CALLBACK_URL,
        client_id: SSO_CLIENT_ID,
        client_secret: SSO_CLIENT_SECRET,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('Token exchange failed:', errBody);
      return c.redirect('/?sso_error=Token+exchange+failed');
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      id_token?: string;
      refresh_token?: string;
      token_type: string;
    };

    if (!tokenData.id_token) {
      return c.redirect('/?sso_error=Missing+id_token');
    }

    // Verifikasi kriptografis id_token: signature JWKS + iss exact +
    // exp + clock-skew ±60 dtk + nonce. aud hanya bila SSO_AUDIENCE diisi
    // (GAP B2 — JANGAN karang nilai).
    try {
      const verifyOpts: Record<string, unknown> = {
        issuer: SSO_ISSUER,
        clockTolerance: CLOCK_SKEW_SECONDS,
      };
      if (SSO_AUDIENCE) {
        verifyOpts.audience = SSO_AUDIENCE;
      }
      let payload;
      try {
        ({ payload } = await jwtVerify(tokenData.id_token, getJwks(), verifyOpts));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        if (/kid|JWKS|signature|key/i.test(msg)) {
          jwksCache = createRemoteJWKSet(new URL(SSO_JWKS_URL));
          ({ payload } = await jwtVerify(tokenData.id_token, getJwks(), verifyOpts));
        } else {
          throw err;
        }
      }

      if (!payload.nonce || payload.nonce !== storedState.nonce) {
        return c.redirect('/?sso_error=Nonce+mismatch');
      }

      const verified: VerifiedProdToken = {
        sub: typeof payload.sub === 'string' ? payload.sub : '',
        email: typeof payload.email === 'string' ? payload.email : '',
        name:
          (typeof payload.name === 'string' && payload.name) ||
          (typeof payload.preferred_username === 'string' && payload.preferred_username) ||
          '',
        payload,
      };

      if (!verified.sub) {
        return c.redirect('/?sso_error=Missing+sub+claim');
      }

      // Mapping admin/UQMP — selain itu 403 tercatat (redirect error jelas).
      const mapped = await prisma.user.findUnique({
        where: { supabaseSub: verified.sub },
        select: { id: true, role: true },
      });
      const allowlisted = (process.env.UQMP_SSO_ALLOWLIST_SUBS || '')
        .split(',')
        .map((s) => s.trim())
        .includes(verified.sub);
      if ((!mapped || mapped.role !== 'admin') && !allowlisted) {
        await auditSso(c, 'sso.login_failed', {
          supabaseSub: verified.sub,
          reason: 'callback: sub belum dipetakan ke admin/UQMP',
        });
        return c.redirect('/?sso_error=Akses+ditolak:+butuh+peran+admin+scope+UQMP');
      }
      // Daftarkan sesi 60 dtk untuk ditukar FE via POST /token.
      // idToken prod disertakan agar FE punya Bearer stateless (tanpa JWT lokal).
      cleanSsoTokens();
      const ssoToken = crypto.randomBytes(48).toString('hex');
      ssoTokenStore.set(ssoToken, {
        verified,
        idToken: tokenData.id_token,
        refreshToken: tokenData.refresh_token,
        createdAt: Date.now(),
      });

      const refreshPart = tokenData.refresh_token
        ? `&sso_refresh=${encodeURIComponent(tokenData.refresh_token)}`
        : '';
      return c.redirect(`/#sso_token=${ssoToken}${refreshPart}`);
    } catch (verifyError: unknown) {
      console.error(
        'ID token verification failed:',
        verifyError instanceof Error ? verifyError.message : verifyError,
      );
      return c.redirect('/?sso_error=Invalid+ID+token');
    }
  } catch (error: unknown) {
    console.error('SSO callback error:', error);
    return c.redirect('/?sso_error=SSO+authentication+failed');
  }
});

// ── POST /token — tukar ssoToken 60-dtk → profil (tanpa JWT lokal) ───────────
// FE lalu memakai idToken prod sebagai Bearer (stateless). TIDAK ada
// penerbitan pasangan JWT lokal (DILARANG).

sso.post('/token', async (c) => {
  try {
    const body = await c.req.json();
    const { token } = body;

    if (!token) {
      return c.json({ message: 'token is required' }, 400);
    }

    const stored = ssoTokenStore.get(token);
    if (!stored) {
      return c.json({ message: 'Invalid or expired SSO token' }, 401);
    }

    ssoTokenStore.delete(token);

    if (Date.now() - stored.createdAt > 60_000) {
      return c.json({ message: 'SSO token expired' }, 401);
    }

    const resolved = await resolveSsoUser(c, stored.verified);
    if ('error' in resolved) {
      return c.json({ message: resolved.error }, resolved.status);
    }

    const { user } = resolved;
    return c.json({
      user: {
        id: user.userId,
        email: user.email,
        name: user.name,
        role: user.role,
        scope: user.scope,
        orgId: user.orgId,
      },
      // Sesi stateless = idToken prod (FE simpan sebagai Bearer).
      idToken: stored.idToken,
      refreshToken: stored.refreshToken,
    });
  } catch (error: unknown) {
    console.error('SSO token exchange error:', error);
    return c.json({ message: 'SSO token exchange failed' }, 500);
  }
});

// ── GET /me — profil dari mapping supabase_sub (pengganti /auth/me) ──────────

sso.get('/me', ssoAuthMiddleware, async (c) => {
  const user = getUser(c);
  return c.json({
    user: {
      id: user.userId,
      email: user.email,
      name: user.name,
      role: user.role,
      scope: user.scope,
      orgId: user.orgId,
    },
  });
});

// ── POST /logout — audit + redirect portal ───────────────────────────────────

sso.post('/logout', ssoAuthMiddleware, async (c) => {
  const user = getUser(c);
  await auditSso(c, 'sso.login', {
    supabaseSub: user.supabaseSub,
    email: user.email,
    reason: 'logout — sesi klien dihapus, redirect portal',
  });
  return c.json({ redirectTo: SSO_LOGOUT_URL });
});

export default sso;
