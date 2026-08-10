-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "CheckoutAttemptStatus" AS ENUM ('RESERVED', 'COMPLETED');

-- CreateTable
CREATE TABLE "OrganizationCheckoutAttempt" (
    "organizationId" TEXT NOT NULL,
    "environment" "StripeEnvironment" NOT NULL,
    "planCode" TEXT NOT NULL,
    "billingInterval" "BillingInterval" NOT NULL,
    "status" "CheckoutAttemptStatus" NOT NULL DEFAULT 'RESERVED',
    "stripeCheckoutSessionId" TEXT,
    "stripeCustomerId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "reservationExpiresAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "OrganizationCheckoutAttempt_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationCheckoutAttempt_stripeCheckoutSessionId_key" ON "OrganizationCheckoutAttempt"("stripeCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationCheckoutAttempt_idempotencyKey_key" ON "OrganizationCheckoutAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OrganizationCheckoutAttempt_expiresAt_idx" ON "OrganizationCheckoutAttempt"("expiresAt");
