import { db } from "@/lib/db";
import { registerOwnerAndOrganization } from "@/server/services/organization-service";
import { DEFAULT_PLANS } from "@/lib/entitlements/plan-defaults";
import type { CapabilityId, LimitId } from "@/lib/entitlements/capabilities";
import type { SessionUser } from "@/lib/auth/session";
import type { RegisterOwnerInput } from "@/lib/validation/auth";
import type { Prisma, UserRole } from "@prisma/client";

let counter = 0;
function unique(prefix: string) {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export async function createOwnerOrg(overrides: Partial<RegisterOwnerInput> = {}) {
  const suffix = unique("org");
  const input: RegisterOwnerInput = {
    firstName: "Ayşe",
    lastName: "Yılmaz",
    email: `${suffix}@example.com`,
    phone: "",
    password: "Sifre1234",
    organizationName: `Test İnşaat ${suffix}`,
    city: "İstanbul",
    district: "Kadıköy",
    taxOffice: "",
    taxNumber: "",
    ...overrides,
  };

  const { userId, organizationId } = await registerOwnerAndOrganization(input);
  const owner = await toSessionUser(userId);
  return { organizationId, owner };
}

export async function toSessionUser(userId: string): Promise<SessionUser> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { organization: true } });
  return {
    id: user.id,
    organizationId: user.organizationId,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
    organizationName: user.organization.tradeName ?? user.organization.name,
  };
}

export async function createOrgUser(organizationId: string, role: UserRole, overrides: { email?: string } = {}) {
  const suffix = unique("user");
  const user = await db.user.create({
    data: {
      organizationId,
      firstName: "Test",
      lastName: role,
      email: overrides.email ?? `${suffix}@example.com`,
      passwordHash: "unused",
      role,
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
  return toSessionUser(user.id);
}

export async function cleanDatabase() {
  await db.$transaction([
    db.auditLog.deleteMany(),
    db.documentExtraction.deleteMany(),
    db.integrationEventLog.deleteMany(),
    db.integrationCredential.deleteMany(),
    db.integrationConnection.deleteMany(),
    db.bankImportRow.deleteMany(),
    db.bankImportBatch.deleteMany(),
    db.accountMovement.deleteMany(),
    db.accountTransfer.deleteMany(),
    db.settlement.deleteMany(),
    db.projectBudgetItem.deleteMany(),
    db.financialTransaction.deleteMany(),
    db.projectMember.deleteMany(),
    db.project.deleteMany(),
    db.transactionCategory.deleteMany(),
    db.financialAccount.deleteMany(),
    db.customer.deleteMany(),
    db.supplier.deleteMany(),
    db.invitation.deleteMany(),
    db.emailVerificationToken.deleteMany(),
    db.passwordResetToken.deleteMany(),
    db.session.deleteMany(),
    db.user.deleteMany(),
    db.organization.deleteMany(),
    // YF-802 — testlerin oluşturduğu geçici planlar (bkz. createTestPlan)
    // temizlenir; migration'ın tohumladığı varsayılan planlar (STARTER/
    // PROFESSIONAL/ENTERPRISE) her zaman korunur — organizasyonlar
    // yukarıda zaten silindiği için FK çakışması olmaz.
    db.plan.deleteMany({ where: { code: { notIn: DEFAULT_PLANS.map((p) => p.code) } } }),
  ]);
}

/** YF-802 — bir organizasyonu belirtilen (varsayılan veya test amaçlı) plana bağlar. */
export async function setOrganizationPlan(organizationId: string, planCode: string) {
  const plan = await db.plan.findUniqueOrThrow({ where: { code: planCode } });
  await db.organization.update({ where: { id: organizationId }, data: { planId: plan.id } });
  return plan;
}

/** YF-802 — sınır/yetenek testleri için özel limit/capability kombinasyonlarına sahip geçici bir plan oluşturur. */
export async function createTestPlan(overrides: {
  code?: string;
  name?: string;
  limits?: Partial<Record<LimitId, number | null>>;
  capabilities?: Partial<Record<CapabilityId, boolean>>;
  isActive?: boolean;
}) {
  const suffix = unique("plan");
  return db.plan.create({
    data: {
      code: overrides.code ?? `TEST-${suffix}`,
      name: overrides.name ?? "Test Planı",
      limits: (overrides.limits ?? {}) as Prisma.InputJsonValue,
      capabilities: (overrides.capabilities ?? {}) as Prisma.InputJsonValue,
      isActive: overrides.isActive ?? true,
    },
  });
}
