-- AlterTable
ALTER TABLE "OrganizationStripeSubscription" ADD COLUMN     "delinquentSince" TIMESTAMP(3),
ADD COLUMN     "gracePeriodEndsAt" TIMESTAMP(3),
ADD COLUMN     "recoveredAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "OrganizationStripeSubscription_gracePeriodEndsAt_idx" ON "OrganizationStripeSubscription"("gracePeriodEndsAt");
