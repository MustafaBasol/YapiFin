-- CreateEnum
CREATE TYPE "BankImportRowStatus" AS ENUM ('IMPORTED', 'CONFIRMING', 'RECONCILED', 'IGNORED', 'ERROR');

-- CreateEnum
CREATE TYPE "BankImportReconciliationType" AS ENUM ('COLLECTION', 'PAYMENT', 'TRANSFER');

-- CreateTable
CREATE TABLE "BankImportBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileFingerprint" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "importedRowCount" INTEGER NOT NULL,
    "errorRowCount" INTEGER NOT NULL,
    "duplicateSkippedCount" INTEGER NOT NULL,
    "importedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankImportRow" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowFingerprint" TEXT NOT NULL,
    "transactionDate" TIMESTAMP(3),
    "valueDate" TIMESTAMP(3),
    "amount" DECIMAL(18,2),
    "currency" TEXT,
    "direction" "MovementDirection",
    "description" TEXT NOT NULL,
    "bankReference" TEXT,
    "counterparty" TEXT,
    "rawRowJson" JSONB NOT NULL,
    "status" "BankImportRowStatus" NOT NULL DEFAULT 'IMPORTED',
    "errorMessage" TEXT,
    "reconciliationType" "BankImportReconciliationType",
    "matchedSettlementId" TEXT,
    "matchedTransferId" TEXT,
    "ignoredById" TEXT,
    "ignoredAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankImportBatch_organizationId_financialAccountId_createdAt_idx" ON "BankImportBatch"("organizationId", "financialAccountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BankImportBatch_organizationId_financialAccountId_fileFinge_key" ON "BankImportBatch"("organizationId", "financialAccountId", "fileFingerprint");

-- CreateIndex
CREATE INDEX "BankImportRow_organizationId_financialAccountId_status_idx" ON "BankImportRow"("organizationId", "financialAccountId", "status");

-- CreateIndex
CREATE INDEX "BankImportRow_organizationId_batchId_idx" ON "BankImportRow"("organizationId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "BankImportRow_organizationId_financialAccountId_rowFingerpr_key" ON "BankImportRow"("organizationId", "financialAccountId", "rowFingerprint");

-- AddForeignKey
ALTER TABLE "BankImportRow" ADD CONSTRAINT "BankImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BankImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
