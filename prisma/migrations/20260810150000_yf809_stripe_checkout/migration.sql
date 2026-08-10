-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateTable
CREATE TABLE "OrganizationCheckoutAttempt" (
    "organizationId" TEXT NOT NULL,
    "environment" "StripeEnvironment" NOT NULL,
    "planCode" TEXT NOT NULL,
    "billingInterval" "BillingInterval" NOT NULL,
    "stripeCheckoutSessionId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationCheckoutAttempt_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationCheckoutAttempt_stripeCheckoutSessionId_key" ON "OrganizationCheckoutAttempt"("stripeCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationCheckoutAttempt_idempotencyKey_key" ON "OrganizationCheckoutAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OrganizationCheckoutAttempt_expiresAt_idx" ON "OrganizationCheckoutAttempt"("expiresAt");
