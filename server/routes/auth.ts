import { Hono } from 'hono';

// SSO-UQMP migrasi: seluruh password-path DIMATIKAN TOTAL (K6–K11).
// register / login / verify-password / refresh → 404.
// Profil sesi SSO: GET /api/auth/sso/me (lihat server/routes/sso.ts).

const auth = new Hono();

const GONE = {
  message: 'Endpoint autentikasi password dimatikan. Gunakan SSO Nathara.',
};

auth.post('/register', (c) => c.json(GONE, 404));
auth.post('/login', (c) => c.json(GONE, 404));
auth.post('/verify-password', (c) => c.json(GONE, 404));
auth.post('/refresh', (c) => c.json(GONE, 404));
auth.get('/me', (c) =>
  c.json(
    { message: 'Endpoint ini dimatikan. Gunakan GET /api/auth/sso/me dengan token SSO.' },
    404,
  ),
);

export default auth;
