-- CreateEnum
CREATE TYPE "PlatformPlanOverrideStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "platformAdminId" TEXT;

-- CreateTable
CREATE TABLE "PlatformPlanOverride" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "previousPlanId" TEXT,
    "reason" TEXT NOT NULL,
    "platformAdminId" TEXT NOT NULL,
    "status" "PlatformPlanOverrideStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformPlanOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformPlanOverride_organizationId_status_idx" ON "PlatformPlanOverride"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PlatformPlanOverride_organizationId_createdAt_idx" ON "PlatformPlanOverride"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "PlatformPlanOverride" ADD CONSTRAINT "PlatformPlanOverride_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformPlanOverride" ADD CONSTRAINT "PlatformPlanOverride_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformPlanOverride" ADD CONSTRAINT "PlatformPlanOverride_previousPlanId_fkey" FOREIGN KEY ("previousPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformPlanOverride" ADD CONSTRAINT "PlatformPlanOverride_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformPlanOverride" ADD CONSTRAINT "PlatformPlanOverride_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
