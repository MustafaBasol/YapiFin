-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "planId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE INDEX "Organization_planId_idx" ON "Organization"("planId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- YF-802 — Varsayılan plan verisi (bkz. lib/entitlements/plan-defaults.ts
-- DEFAULT_PLANS — bu INSERT'ler o dosyadaki tanımların birebir SQL
-- karşılığıdır, tek doğruluk kaynağı olarak DB'de tutulur). Sabit id'ler
-- (cuid formatı değil ama Prisma `id String @id` alanı için herhangi bir
-- benzersiz metin geçerlidir) okunabilirlik ve idempotent olmayan tekrar
-- çalıştırmalarda çakışmayı görünür kılmak için bilinçli olarak seçildi.
INSERT INTO "Plan" ("id", "code", "name", "limits", "capabilities", "isActive", "createdAt", "updatedAt") VALUES
(
    'plan_starter_default',
    'STARTER',
    'Başlangıç',
    '{"users.active": 3, "projects.active": 3, "ai.monthly_quota": 0}',
    '{"reports.advanced": false, "export.xlsx": true, "export.pdf": true, "bank_import": false, "ocr": false, "e_document": false, "ai.features": false}',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
),
(
    'plan_professional_default',
    'PROFESSIONAL',
    'Profesyonel',
    '{"users.active": 15, "projects.active": 25, "ai.monthly_quota": 0}',
    '{"reports.advanced": true, "export.xlsx": true, "export.pdf": true, "bank_import": true, "ocr": true, "e_document": true, "ai.features": false}',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
),
(
    'plan_enterprise_default',
    'ENTERPRISE',
    'Kurumsal',
    '{"users.active": null, "projects.active": null, "ai.monthly_quota": null}',
    '{"reports.advanced": true, "export.xlsx": true, "export.pdf": true, "bank_import": true, "ocr": true, "e_document": true, "ai.features": true}',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

-- YF-802 — geriye dönük dolgu (backfill): bu migration öncesinde
-- oluşturulmuş organizasyonların planId'si NULL'dur; entitlement servisi
-- planId=NULL'u fail-closed (hiçbir yetenek/kota) kabul ettiği için, mevcut
-- ürün davranışını (tüm modüller herkese açık) korumak amacıyla hepsi
-- varsayılan PROFESSIONAL plana bağlanır (bkz. lib/entitlements/plan-defaults.ts
-- DEFAULT_ORGANIZATION_PLAN_CODE — aynı kod, yeni kayıtlarda da kullanılır).
UPDATE "Organization" SET "planId" = 'plan_professional_default' WHERE "planId" IS NULL;
