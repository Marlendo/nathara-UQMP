import { prisma } from '../lib/prisma.js';

// SSO-UQMP seed admin awal (R5): tanpa password.
// Nilai via file env VPS (JANGAN commit/log):
//   UQMP_SEED_SUB   = supabase_sub (UUID prod dari human/PM Production)
//   UQMP_SEED_EMAIL = email admin
//   UQMP_SEED_NAME  = nama tampilan (opsional)
// Idempoten (upsert by supabaseSub, lalu by email untuk linking invite).

async function main() {
  const sub = (process.env.UQMP_SEED_SUB || '').trim();
  const email = (process.env.UQMP_SEED_EMAIL || '').trim().toLowerCase();
  const name = (process.env.UQMP_SEED_NAME || '').trim() || 'PJM Admin';

  if (!sub || !email) {
    console.error('UQMP_SEED_SUB dan UQMP_SEED_EMAIL wajib diisi via file env VPS.');
    process.exit(1);
  }

  const bySub = await prisma.user.findUnique({ where: { supabaseSub: sub } });
  if (bySub) {
    await prisma.user.update({
      where: { id: bySub.id },
      data: { email, name, role: 'admin', scope: 'UQMP' },
    });
    console.log(`seed: ditegaskan admin/UQMP untuk sub ${sub.slice(0, 8)}…`);
    return;
  }

  const byEmail = await prisma.user.findUnique({ where: { email } });
  if (byEmail) {
    if (byEmail.supabaseSub && byEmail.supabaseSub !== sub) {
      console.error('seed GAGAL: email sudah terikat sub lain — butuh OTP/linking manual.');
      process.exit(1);
    }
    await prisma.user.update({
      where: { id: byEmail.id },
      data: { supabaseSub: sub, name, role: 'admin', scope: 'UQMP' },
    });
    console.log(`seed: sub diikat ke baris invite ${email}`);
    return;
  }

  await prisma.user.create({
    data: { email, name, role: 'admin', scope: 'UQMP', supabaseSub: sub },
  });
  console.log(`seed: admin/UQMP dibuat untuk ${email}`);
}

main()
  .catch((e) => {
    console.error('seed gagal:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
