-- CreateEnum
CREATE TYPE "StripeEnvironment" AS ENUM ('TEST', 'LIVE');

-- CreateTable
CREATE TABLE "OrganizationStripeCustomer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "environment" "StripeEnvironment" NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationStripeCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationStripeCustomer_organizationId_idx" ON "OrganizationStripeCustomer"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationStripeCustomer_organizationId_environment_key" ON "OrganizationStripeCustomer"("organizationId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationStripeCustomer_environment_stripeCustomerId_key" ON "OrganizationStripeCustomer"("environment", "stripeCustomerId");
