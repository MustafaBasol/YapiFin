-- CreateEnum
CREATE TYPE "StripeSubscriptionStatus" AS ENUM ('INCOMPLETE', 'INCOMPLETE_EXPIRED', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID', 'PAUSED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "StripeInvoicePaymentStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "StripeWebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateTable
CREATE TABLE "StripeWebhookEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "environment" "StripeEnvironment" NOT NULL,
    "eventType" TEXT NOT NULL,
    "organizationId" TEXT,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "status" "StripeWebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "errorSummary" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "stripeCreatedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationStripeSubscription" (
    "organizationId" TEXT NOT NULL,
    "environment" "StripeEnvironment" NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "stripePriceId" TEXT NOT NULL,
    "planCode" TEXT,
    "billingInterval" "BillingInterval",
    "status" "StripeSubscriptionStatus" NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "trialStart" TIMESTAMP(3),
    "trialEnd" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "lastGrantedPlanId" TEXT,
    "reconciliationNote" TEXT,
    "lastProcessedEventId" TEXT,
    "lastProcessedEventCreatedAt" TIMESTAMP(3),
    "lastPaymentStatus" "StripeInvoicePaymentStatus",
    "lastPaymentAt" TIMESTAMP(3),
    "lastInvoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationStripeSubscription_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "StripeWebhookEvent_stripeEventId_key" ON "StripeWebhookEvent"("stripeEventId");

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_organizationId_stripeCreatedAt_idx" ON "StripeWebhookEvent"("organizationId", "stripeCreatedAt");

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_status_idx" ON "StripeWebhookEvent"("status");

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_stripeSubscriptionId_idx" ON "StripeWebhookEvent"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "OrganizationStripeSubscription_stripeCustomerId_idx" ON "OrganizationStripeSubscription"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationStripeSubscription_environment_stripeSubscripti_key" ON "OrganizationStripeSubscription"("environment", "stripeSubscriptionId");
