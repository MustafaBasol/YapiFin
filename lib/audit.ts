import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

interface AuditEntry {
  organizationId: string;
  actorId: string | null;
  /** YF-819 — bir Platform Admin eylemi için aktör bağlantısı. `actorId` ile AYNI ANDA dolu OLMAZ (bkz. prisma/schema.prisma `AuditLog.platformAdminId` yorumu). */
  platformAdminId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Kritik değişiklikleri audit log tablosuna yazar. Her zaman çağıran transaction içinde çalıştırılmalıdır. */
export async function writeAuditLog(tx: Tx, entry: AuditEntry) {
  await tx.auditLog.create({
    data: {
      organizationId: entry.organizationId,
      actorId: entry.actorId,
      platformAdminId: entry.platformAdminId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      beforeJson: entry.before === undefined ? undefined : (entry.before as Prisma.InputJsonValue),
      afterJson: entry.after === undefined ? undefined : (entry.after as Prisma.InputJsonValue),
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
    },
  });
}
