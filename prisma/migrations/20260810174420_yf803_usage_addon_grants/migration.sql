-- CreateTable
CREATE TABLE "UsageAddonGrant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "metadata" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageAddonGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageAddonGrant_organizationId_resource_validFrom_validUnti_idx" ON "UsageAddonGrant"("organizationId", "resource", "validFrom", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "UsageAddonGrant_organizationId_idempotencyKey_key" ON "UsageAddonGrant"("organizationId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "UsageAddonGrant" ADD CONSTRAINT "UsageAddonGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
