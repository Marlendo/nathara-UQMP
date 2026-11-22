import { Hono } from 'hono';
import { prisma } from '../lib/prisma.js';
import {
  ssoAuthMiddleware,
  requireAdminUQMP,
  getUser,
  auditSso,
} from '../middleware/ssoAuth.js';

// SSO-UQMP migrasi (K15–K16): password-invite + role bebas DIMATIKAN.
// Invite = pemetaan admin/UQMP oleh admin (tanpa password, tanpa
// temporaryPassword). Satu-satunya role valid = admin (+scope UQMP).

const users = new Hono();

users.use('*', ssoAuthMiddleware);

function deriveDisplayName(email: string): string {
  const localPart = email.split('@')[0] || 'User';
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'User';
}

users.get('/team', async (c) => {
  try {
    const user = getUser(c);

    if (!user.orgId) {
      return c.json({ orgName: 'Organization', members: [] });
    }

    const [org, members] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: user.orgId },
        select: { name: true },
      }),
      prisma.user.findMany({
        where: { orgId: user.orgId },
        select: { id: true, email: true, name: true, role: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return c.json({
      orgName: org?.name ?? 'Organization',
      members,
    });
  } catch (error: unknown) {
    console.error('Load team error:', error);
    return c.json({ message: 'Failed to load team' }, 500);
  }
});

users.get('/', async (c) => {
  try {
    const user = getUser(c);

    if (!user.orgId) {
      return c.json({ users: [] });
    }

    const items = await prisma.user.findMany({
      where: { orgId: user.orgId },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    return c.json({ users: items });
  } catch (error: unknown) {
    console.error('List users error:', error);
    return c.json({ message: 'Failed to list users' }, 500);
  }
});

// POST /invite — admin memetakan email menjadi admin/UQMP.
// Baris dibuat tanpa supabaseSub; sub diikat saat login SSO pertama
// (satu-kali, hanya bila email cocok persis dan sub belum terikat).
users.post('/invite', requireAdminUQMP(), async (c) => {
  try {
    const currentUser = getUser(c);
    const body = await c.req.json();

    if (!body.email) {
      return c.json({ message: 'Email is required' }, 400);
    }

    if (body.role && body.role !== 'admin') {
      return c.json(
        { message: 'Satu-satunya peran valid: admin (scope UQMP).' },
        400,
      );
    }

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return c.json({ message: 'User with this email already exists' }, 409);
    }

    const inviteeName =
      typeof body.name === 'string' && body.name.trim().length > 0
        ? body.name.trim()
        : deriveDisplayName(body.email);

    const newUser = await prisma.user.create({
      data: {
        email: body.email,
        name: inviteeName,
        role: 'admin',
        scope: 'UQMP',
        orgId: currentUser.orgId,
      },
    });

    await auditSso(c, 'user.role_mapped', {
      supabaseSub: newUser.supabaseSub ?? 'pending-link',
      email: newUser.email,
      reason: 'invite admin/UQMP — sub diikat saat login SSO pertama',
    });

    return c.json({
      user: { id: newUser.id, email: newUser.email, name: newUser.name, role: newUser.role },
    }, 201);
  } catch (error: unknown) {
    console.error('Invite user error:', error);
    return c.json({ message: 'Failed to invite user' }, 500);
  }
});

// PUT /:id/role —terkunci: hanya admin yang boleh dipertahankan.
// Peran qa_* MATI untuk akses (default deny).
users.put('/:id/role', requireAdminUQMP(), async (c) => {
  try {
    const currentUser = getUser(c);
    const { id } = c.req.param();
    const body = await c.req.json();

    if (body.role !== 'admin') {
      return c.json(
        { message: 'Satu-satunya peran valid: admin (scope UQMP).' },
        400,
      );
    }

    const targetUser = await prisma.user.findUnique({ where: { id } });
    if (!targetUser) {
      return c.json({ message: 'User not found' }, 404);
    }

    if (targetUser.orgId !== currentUser.orgId) {
      return c.json({ message: 'Cannot modify users outside your organization' }, 403);
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { role: 'admin', scope: 'UQMP' },
      select: { id: true, email: true, name: true, role: true },
    });

    await auditSso(c, 'user.role_mapped', {
      supabaseSub: targetUser.supabaseSub ?? updated.id,
      email: updated.email,
      reason: 'role ditegaskan admin/UQMP',
    });

    return c.json({ user: updated });
  } catch (error: unknown) {
    console.error('Update user role error:', error);
    return c.json({ message: 'Failed to update user role' }, 500);
  }
});

export default users;
