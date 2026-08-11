-- CreateEnum
CREATE TYPE "StripeRefundStatus" AS ENUM ('PENDING', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "StripeRefundPolicyState" AS ENUM ('NOT_APPLICABLE', 'RETAINED', 'GRANT_EXPIRED', 'EXPIRED_AFTER_CONSUMPTION');

-- CreateEnum
CREATE TYPE "StripeDisputeStatus" AS ENUM ('WARNING_NEEDS_RESPONSE', 'WARNING_UNDER_REVIEW', 'WARNING_CLOSED', 'NEEDS_RESPONSE', 'UNDER_REVIEW', 'WON', 'LOST', 'PREVENTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "StripeDisputeRiskState" AS ENUM ('FLAGGED', 'RESTRICTED', 'CLEARED');

-- CreateTable
CREATE TABLE "StripeRefund" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "environment" "StripeEnvironment" NOT NULL,
    "stripeRefundId" TEXT NOT NULL,
    "stripeChargeId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "status" "StripeRefundStatus" NOT NULL,
    "policyState" "StripeRefundPolicyState" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "relatedUsageAddonGrantId" TEXT,
    "manualReviewNote" TEXT,
    "lastProcessedEventId" TEXT,
    "lastProcessedEventCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeDispute" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "environment" "StripeEnvironment" NOT NULL,
    "stripeDisputeId" TEXT NOT NULL,
    "stripeChargeId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "status" "StripeDisputeStatus" NOT NULL,
    "riskState" "StripeDisputeRiskState" NOT NULL DEFAULT 'FLAGGED',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "lastProcessedEventId" TEXT,
    "lastProcessedEventCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeDispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StripeRefund_organizationId_createdAt_idx" ON "StripeRefund"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "StripeRefund_stripeChargeId_idx" ON "StripeRefund"("stripeChargeId");

-- CreateIndex
CREATE INDEX "StripeRefund_relatedUsageAddonGrantId_idx" ON "StripeRefund"("relatedUsageAddonGrantId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeRefund_environment_stripeRefundId_key" ON "StripeRefund"("environment", "stripeRefundId");

-- CreateIndex
CREATE INDEX "StripeDispute_organizationId_riskState_idx" ON "StripeDispute"("organizationId", "riskState");

-- CreateIndex
CREATE INDEX "StripeDispute_stripeChargeId_idx" ON "StripeDispute"("stripeChargeId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeDispute_environment_stripeDisputeId_key" ON "StripeDispute"("environment", "stripeDisputeId");

-- AddForeignKey
ALTER TABLE "StripeRefund" ADD CONSTRAINT "StripeRefund_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeDispute" ADD CONSTRAINT "StripeDispute_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
