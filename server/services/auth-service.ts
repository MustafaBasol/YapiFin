import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { sendPasswordResetEmail, sendVerificationEmail } from "@/lib/email/mailer";
import { writeAuditLog } from "@/lib/audit";
import { ServiceError } from "@/server/services/errors";
import type { User } from "@prisma/client";

const RESET_TTL_MS = 60 * 60 * 1000; // 1 saat
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * E-posta, organizationId olmadan tek başına global olarak benzersiz
 * değildir (docs/DATA_MODEL.md: unique(organizationId, email)) — bir kişi
 * teoride birden çok organizasyonda aynı e-postayla hesaba sahip olabilir.
 * Bu yüzden e-postayla eşleşen tüm hesaplar aday alınır ve parola hangisiyle
 * doğrularsa o hesapla giriş yapılır.
 */
export async function authenticateUser(email: string, password: string): Promise<User> {
  const candidates = await db.user.findMany({ where: { email, status: "ACTIVE" } });

  for (const candidate of candidates) {
    if (!candidate.passwordHash) continue;
    if (await verifyPassword(password, candidate.passwordHash)) {
      await db.user.update({ where: { id: candidate.id }, data: { lastLoginAt: new Date() } });
      return candidate;
    }
  }

  throw new ServiceError("Geçersiz e-posta veya parola", "VALIDATION");
}

export async function verifyEmail(token: string): Promise<void> {
  const record = await db.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new ServiceError("Doğrulama bağlantısı geçersiz veya süresi dolmuş", "VALIDATION");
  }
  await db.$transaction([
    db.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
    db.emailVerificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);
}

export async function resendVerificationEmail(userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.emailVerifiedAt) return;
  const { raw } = generateToken();
  await db.emailVerificationToken.create({
    data: { userId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
  });
  try {
    await sendVerificationEmail(user.email, raw);
  } catch (err) {
    console.error("verification email delivery failed", err instanceof Error ? err.message : err);
    throw new ServiceError("Doğrulama e-postası gönderilemedi. Lütfen daha sonra tekrar deneyin.", "VALIDATION");
  }
}

/**
 * Kullanıcı olsun olmasın aynı sonucu döner — e-posta numaralandırma
 * saldırısını önler. Bu nedenle SMTP gönderim hatası da bilerek burada
 * yutulur (yalnızca güvenli biçimde loglanır, token asla loglanmaz);
 * aksi halde "var olan e-posta + SMTP arızası" ile "olmayan e-posta"
 * durumları çağıran tarafta farklı sonuçlar üretir ve numaralandırmaya
 * açık hale gelir (bkz. docs/PRODUCTION_READINESS.md R-9).
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await db.user.findFirst({ where: { email, status: "ACTIVE" } });
  if (!user) return;

  const { raw } = generateToken();
  await db.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
  });
  try {
    await sendPasswordResetEmail(user.email, raw);
  } catch (err) {
    console.error("password reset email delivery failed", err instanceof Error ? err.message : err);
  }
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const record = await db.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new ServiceError("Sıfırlama bağlantısı geçersiz veya süresi dolmuş", "VALIDATION");
  }

  const passwordHash = await hashPassword(newPassword);
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
    await tx.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await tx.session.deleteMany({ where: { userId: record.userId } });
    const user = await tx.user.findUniqueOrThrow({ where: { id: record.userId } });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorId: user.id,
      action: "user.password_reset",
      entityType: "User",
      entityId: user.id,
    });
  });
}
