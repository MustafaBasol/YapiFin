-- CreateEnum
CREATE TYPE "IntegrationErrorCategory" AS ENUM ('AUTH_CONFIG', 'VALIDATION', 'TEMPORARY_PROVIDER', 'RATE_LIMIT', 'TIMEOUT_NETWORK', 'PERMANENT_REJECTION', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "IntegrationOutboundOperationStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'RETRYING', 'DEAD_LETTER');

-- CreateTable
CREATE TABLE "IntegrationOutboundOperation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "IntegrationOutboundOperationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorCategory" "IntegrationErrorCategory",
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "resultSummary" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationOutboundOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationOutboundOperation_organizationId_connectionId_cr_idx" ON "IntegrationOutboundOperation"("organizationId", "connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationOutboundOperation_organizationId_status_idx" ON "IntegrationOutboundOperation"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationOutboundOperation_connectionId_operationType_ide_key" ON "IntegrationOutboundOperation"("connectionId", "operationType", "idempotencyKey");
