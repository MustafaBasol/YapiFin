import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { sendVerificationEmail } from "@/lib/email/mailer";
import { writeAuditLog } from "@/lib/audit";
import { conflict } from "@/server/services/errors";
import type { RegisterOwnerInput } from "@/lib/validation/auth";

export const DEFAULT_INCOME_CATEGORIES = [
  "Avans",
  "Hakediş",
  "Ara ödeme",
  "Ek iş",
  "Proje teslim ödemesi",
  "Malzeme satışı",
  "Diğer gelir",
];

export const DEFAULT_EXPENSE_CATEGORIES = [
  "İnşaat malzemesi",
  "İşçilik",
  "Taşeron",
  "Nakliye",
  "Makine ve ekipman",
  "Araç ve yakıt",
  "Kira",
  "Ruhsat ve resmî harçlar",
  "Sigorta",
  "Vergi",
  "Personel",
  "Ofis",
  "Diğer",
];

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Firma sahibi kaydı: aynı işlemde organizasyon, varsayılan gelir/gider
 * kategorileri ve Ana Kasa hesabı oluşturulur (docs/ACCEPTANCE_CRITERIA.md
 * "Firma kaydı"). E-posta doğrulama linki en son, transaction dışında,
 * best-effort gönderilir — bir SMTP hatası kaydı geri almaz.
 */
export async function registerOwnerAndOrganization(
  input: RegisterOwnerInput,
): Promise<{ userId: string; organizationId: string; verificationEmailSent: boolean }> {
  const passwordHash = await hashPassword(input.password);

  const result = await db.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: input.organizationName,
        tradeName: input.organizationName,
        taxOffice: input.taxOffice || null,
        taxNumber: input.taxNumber || null,
        city: input.city || null,
        district: input.district || null,
      },
    });

    const user = await tx.user.create({
      data: {
        organizationId: organization.id,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone || null,
        passwordHash,
        role: "OWNER",
        status: "ACTIVE",
      },
    });

    await tx.transactionCategory.createMany({
      data: [
        ...DEFAULT_INCOME_CATEGORIES.map((name) => ({
          organizationId: organization.id,
          type: "INCOME" as const,
          name,
          isSystem: true,
        })),
        ...DEFAULT_EXPENSE_CATEGORIES.map((name) => ({
          organizationId: organization.id,
          type: "EXPENSE" as const,
          name,
          isSystem: true,
        })),
      ],
    });

    const mainCashAccount = await tx.financialAccount.create({
      data: {
        organizationId: organization.id,
        name: "Ana Kasa",
        type: "CASH",
        openingBalance: 0,
      },
    });
    // Açılış bakiyesi denetlenebilir bir hesap hareketi olarak kaydedilir
    // (bkz. server/services/account-service.ts createAccount ile aynı ilke).
    await tx.accountMovement.create({
      data: {
        organizationId: organization.id,
        financialAccountId: mainCashAccount.id,
        type: "OPENING",
        direction: "CREDIT",
        amount: 0,
        occurredAt: mainCashAccount.createdAt,
        description: "Açılış bakiyesi",
        createdById: user.id,
      },
    });

    await writeAuditLog(tx, {
      organizationId: organization.id,
      actorId: user.id,
      action: "organization.create",
      entityType: "Organization",
      entityId: organization.id,
      after: { name: organization.name },
    });
    await writeAuditLog(tx, {
      organizationId: organization.id,
      actorId: user.id,
      action: "user.create",
      entityType: "User",
      entityId: user.id,
      after: { role: user.role },
    });

    return { userId: user.id, organizationId: organization.id };
  }).catch((err) => {
    if (err?.code === "P2002") {
      throw conflict("Bu firma adıyla veya e-posta ile zaten bir kayıt var");
    }
    throw err;
  });

  const { raw } = generateToken();
  await db.emailVerificationToken.create({
    data: {
      userId: result.userId,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    },
  });
  let verificationEmailSent = true;
  // Hata zaten lib/email/mailer.ts sendMail() içinde güvenli biçimde loglanır.
  await sendVerificationEmail(input.email, raw).catch(() => {
    verificationEmailSent = false;
  });

  return { ...result, verificationEmailSent };
}
