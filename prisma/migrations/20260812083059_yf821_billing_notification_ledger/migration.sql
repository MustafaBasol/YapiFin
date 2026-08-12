-- CreateEnum
CREATE TYPE "BillingNotificationType" AS ENUM ('PAYMENT_FAILED_GRACE_STARTED', 'GRACE_EXPIRING_REMINDER', 'GRACE_EXPIRED_RESTRICTED', 'PAYMENT_RECOVERED');

-- CreateEnum
CREATE TYPE "BillingNotificationStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "BillingNotification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "BillingNotificationType" NOT NULL,
    "episodeKey" TEXT NOT NULL,
    "status" "BillingNotificationStatus" NOT NULL DEFAULT 'SCHEDULED',
    "gracePeriodEndsAt" TIMESTAMP(3),
    "recipientCount" INTEGER,
    "triggeredByEventId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingNotification_organizationId_status_idx" ON "BillingNotification"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingNotification_organizationId_type_episodeKey_key" ON "BillingNotification"("organizationId", "type", "episodeKey");

-- AddForeignKey
ALTER TABLE "BillingNotification" ADD CONSTRAINT "BillingNotification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
