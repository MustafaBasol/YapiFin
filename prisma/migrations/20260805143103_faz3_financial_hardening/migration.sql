-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- AlterTable
ALTER TABLE "AccountTransfer" ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
DROP COLUMN "status",
ADD COLUMN     "status" "TransferStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AccountTransfer_idempotencyKey_key" ON "AccountTransfer"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_idempotencyKey_key" ON "Settlement"("idempotencyKey");

