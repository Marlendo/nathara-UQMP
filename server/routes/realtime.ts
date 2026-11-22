import { Hono } from 'hono';
import { verifyProdToken } from '../middleware/ssoAuth.js';
import { realtimeService } from '../services/realtime.service.js';
import { prisma } from '../lib/prisma.js';

const realtime = new Hono();

// SSE endpoint - auth via query param for EventSource compatibility
// SSO-UQMP migrasi (K19): verifikasi sesi SSO prod (JWKS), BUKAN JWT_SECRET lama.
realtime.get('/events', async (c) => {
  // EventSource doesn't support custom headers, so accept token as query param
  const token = c.req.query('token');
  const projectId = c.req.query('projectId');

  if (!token || !projectId) {
    return c.json({ message: 'token and projectId query params required' }, 400);
  }

  // Verify SSO session: token prod valid + mapping admin/UQMP
  const verified = await verifyProdToken(token);
  if (!verified) {
    return c.json({ message: 'Invalid token' }, 401);
  }

  const mapped = await prisma.user.findUnique({
    where: { supabaseSub: verified.sub },
    select: { id: true, role: true },
  });
  if (!mapped || mapped.role !== 'admin') {
    return c.json(
      { message: 'Akses ditolak: butuh peran admin scope UQMP. Hubungi admin PJM.' },
      403,
    );
  }

  const userId = mapped.id;
  const clientId = `${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return realtimeService.createSSEStream(c, clientId, userId, projectId);
});

export default realtime;
