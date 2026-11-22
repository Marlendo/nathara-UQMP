// SSO-UQMP migrasi: path JWT lokal (register/login/refresh/verify-password,
// penerbitan token HS256, matriks qa_*) DIMATIKAN TOTAL 2026-11-22.
// Satu-satunya jalan masuk = JWT prod via server/middleware/ssoAuth.ts
// (ssoAuthMiddleware + requireAdminUQMP). File ini dipertahankan sebagai
// stub agar impor lama gagal secara eksplisit saat compile, bukan diam-diam.

export {};
