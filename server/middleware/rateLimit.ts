import type { Context, Next } from 'hono';

// M-01: rate-limit per-IP untuk endpoint SSO publik.
// In-memory fixed-window — cukup untuk 1 replika staging. Bila naik ke
// multi-replika/edge, pindahkan ke Cloudflare/nginx (koordinasi DevOps).

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 5000;

function readLimit(): { max: number; windowMs: number } {
  const max = Number(process.env.SSO_RATE_LIMIT_MAX ?? 30);
  const windowMs = Number(process.env.SSO_RATE_LIMIT_WINDOW_MS ?? 60_000);
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 30,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : 60_000,
  };
}

function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return c.req.header('x-real-ip') || 'unknown';
}

export async function ssoRateLimit(c: Context, next: Next) {
  const { max, windowMs } = readLimit();
  const pathname = new URL(c.req.url).pathname;
  const key = `${clientIp(c)}:${pathname}`;
  const now = Date.now();

  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
  }
  bucket.count += 1;
  buckets.set(key, bucket);

  if (buckets.size > MAX_BUCKETS) {
    for (const [k, b] of buckets) {
      if (now >= b.resetAt) buckets.delete(k);
      if (buckets.size <= MAX_BUCKETS) break;
    }
  }

  if (bucket.count > max) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    c.header('Retry-After', String(retryAfter));
    return c.json({ message: 'Terlalu banyak percobaan. Coba lagi nanti.' }, 429);
  }

  await next();
}
