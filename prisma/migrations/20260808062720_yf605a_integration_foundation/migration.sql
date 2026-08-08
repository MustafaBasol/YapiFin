-- CreateEnum
CREATE TYPE "IntegrationType" AS ENUM ('E_INVOICE', 'ACCOUNTING');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('NILVERA', 'UYUMSOFT', 'IZIBIZ', 'SOVOS', 'QNB_ESOLUTIONS', 'PARASUT', 'GENERIC');

-- CreateEnum
CREATE TYPE "IntegrationEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "IntegrationConnectionStatus" AS ENUM ('INACTIVE', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "IntegrationEventDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "IntegrationEventStatus" AS ENUM ('SUCCESS', 'FAILURE');

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationType" "IntegrationType" NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "environment" "IntegrationEnvironment" NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "IntegrationConnectionStatus" NOT NULL DEFAULT 'INACTIVE',
    "externalTenantId" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationCredential" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationEventLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "actorId" TEXT,
    "eventType" TEXT NOT NULL,
    "direction" "IntegrationEventDirection",
    "status" "IntegrationEventStatus" NOT NULL DEFAULT 'SUCCESS',
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationConnection_organizationId_status_idx" ON "IntegrationConnection"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_organizationId_integrationType_provid_key" ON "IntegrationConnection"("organizationId", "integrationType", "provider", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCredential_connectionId_key" ON "IntegrationCredential"("connectionId");

-- CreateIndex
CREATE INDEX "IntegrationCredential_organizationId_connectionId_idx" ON "IntegrationCredential"("organizationId", "connectionId");

-- CreateIndex
CREATE INDEX "IntegrationEventLog_organizationId_connectionId_createdAt_idx" ON "IntegrationEventLog"("organizationId", "connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationEventLog_organizationId_eventType_idx" ON "IntegrationEventLog"("organizationId", "eventType");
