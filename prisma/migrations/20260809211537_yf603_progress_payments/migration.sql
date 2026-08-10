-- CreateEnum
CREATE TYPE "ProgressPaymentStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ProgressPayment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "customerId" TEXT,
    "categoryId" TEXT NOT NULL,
    "sequenceNo" INTEGER NOT NULL,
    "periodStartDate" TIMESTAMP(3) NOT NULL,
    "periodEndDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "deductionAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(18,2) NOT NULL,
    "notes" TEXT,
    "status" "ProgressPaymentStatus" NOT NULL DEFAULT 'DRAFT',
    "financialTransactionId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectionReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancellationReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgressPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgressPaymentExtraWorkItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "progressPaymentId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgressPaymentExtraWorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProgressPayment_financialTransactionId_key" ON "ProgressPayment"("financialTransactionId");

-- CreateIndex
CREATE INDEX "ProgressPayment_organizationId_projectId_status_idx" ON "ProgressPayment"("organizationId", "projectId", "status");

-- CreateIndex
CREATE INDEX "ProgressPayment_organizationId_status_idx" ON "ProgressPayment"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProgressPayment_projectId_sequenceNo_key" ON "ProgressPayment"("projectId", "sequenceNo");

-- CreateIndex
CREATE INDEX "ProgressPaymentExtraWorkItem_organizationId_progressPayment_idx" ON "ProgressPaymentExtraWorkItem"("organizationId", "progressPaymentId");

-- AddForeignKey
ALTER TABLE "ProgressPaymentExtraWorkItem" ADD CONSTRAINT "ProgressPaymentExtraWorkItem_progressPaymentId_fkey" FOREIGN KEY ("progressPaymentId") REFERENCES "ProgressPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
