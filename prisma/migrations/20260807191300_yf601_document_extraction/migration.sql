-- CreateEnum
CREATE TYPE "DocumentExtractionStatus" AS ENUM ('PENDING', 'EXTRACTED', 'FAILED', 'CONFIRMING', 'CONFIRMED');

-- CreateTable
CREATE TABLE "DocumentExtraction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "uploadedById" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "fileData" BYTEA NOT NULL,
    "status" "DocumentExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "providerName" TEXT,
    "candidateJson" JSONB,
    "errorMessage" TEXT,
    "confirmedTransactionId" TEXT,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentExtraction_confirmedTransactionId_key" ON "DocumentExtraction"("confirmedTransactionId");

-- CreateIndex
CREATE INDEX "DocumentExtraction_organizationId_status_idx" ON "DocumentExtraction"("organizationId", "status");

-- CreateIndex
CREATE INDEX "DocumentExtraction_organizationId_projectId_idx" ON "DocumentExtraction"("organizationId", "projectId");
