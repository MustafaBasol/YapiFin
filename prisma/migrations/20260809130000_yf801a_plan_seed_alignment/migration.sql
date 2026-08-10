-- YF-801-A — Align runtime Plan seed data with the canonical decision
-- matrix in docs/PLAN_FEATURE_MATRIX.md (§1/§3/§5). Forward-only,
-- idempotent (ON CONFLICT ("code") DO UPDATE, keyed on the existing unique
-- Plan_code_key index), and touches ONLY the "Plan" table:
--   - No "Organization"."planId" is read or written by this migration —
--     existing organization -> plan relationships are fully preserved.
--   - No "AiUsageLedger" row is touched — no usage/AI ledger is reset.
--   - No "Plan" row is deleted (STARTER/PROFESSIONAL/ENTERPRISE keep the
--     same "id" they were given by 20260808210000_yf802_plan_entitlements,
--     so the existing "Organization_planId_fkey" relationships remain
--     valid without any backfill/update on "Organization").
--
-- Impact on EXISTING PROFESSIONAL organizations (applies to the very next
-- request after this migration runs, since getEffectivePlan always reads
-- the "Plan" row fresh — see lib/entitlements/entitlement-service.ts):
--   1. users.active limit drops 15 -> 10 (PLAN_FEATURE_MATRIX.md §5 #2).
--      Any organization already sitting at 11-15 ACTIVE users is NOT
--      modified/deactivated — it is "grandfathered" per the already
--      documented downgrade semantics (PLAN_FEATURE_MATRIX.md §8.3):
--      existing users keep working, only NEW invitations/acceptances are
--      blocked (assertWithinLimit*) until the organization drops back
--      under 10 active users or moves to BUSINESS/ENTERPRISE.
--   2. ai.features flips false -> true and ai.monthly_quota 0 -> 500
--      (PLAN_FEATURE_MATRIX.md §5 #4). This is the intended matrix
--      decision (Professional includes AI) and genuinely ENABLES AI usage
--      (server/services/ai-usage-reporting-service.ts requestAiCompletion)
--      for existing PROFESSIONAL organizations that previously could not
--      use it at all (AI_PLAN_REQUIRED on every call).
--   3. e_document flips true -> false (PLAN_FEATURE_MATRIX.md §5 #6 — the
--      matrix assigns e-document/accounting-provider ACCESS to BUSINESS).
--      This is a data-only change: e_document has no assertCapability/
--      canUseCapability call site anywhere in the codebase today (§5 #8),
--      so no existing functionality is actually gated by it yet.
--   - projects.active (25) and export.xlsx/export.pdf/reports.advanced/
--     bank_import/ocr stay unchanged for PROFESSIONAL.
--
-- Impact on EXISTING STARTER organizations: projects.active limit only
-- widens 3 -> 5 (PLAN_FEATURE_MATRIX.md §5 #1) — strictly more permissive,
-- no downgrade risk. Nothing else changes for STARTER.
--
-- BUSINESS: newly inserted Plan row (previously entirely absent from the
-- runtime — PLAN_FEATURE_MATRIX.md §5 #3). No existing organization is
-- assigned to it by this migration; DEFAULT_ORGANIZATION_PLAN_CODE remains
-- "PROFESSIONAL" (unchanged — see lib/entitlements/plan-defaults.ts).
-- ai.monthly_quota (2000) and users.active/projects.active (30/100) match
-- the canonical matrix's quantitative limits; the AI credit figure itself
-- is a provisional seed value (see lib/entitlements/plan-defaults.ts doc
-- comment) — the matrix only requires it to be higher than Professional's.
--
-- ENTERPRISE: untouched — its null ("configurable"/unlimited) limits and
-- all-capabilities-on posture already match the canonical matrix (§5 #7
-- documents this as a semantic nuance, not a data mismatch).

INSERT INTO "Plan" ("id", "code", "name", "limits", "capabilities", "isActive", "createdAt", "updatedAt") VALUES
(
    'plan_starter_default',
    'STARTER',
    'Başlangıç',
    '{"users.active": 3, "projects.active": 5, "ai.monthly_quota": 0}',
    '{"reports.advanced": false, "export.xlsx": true, "export.pdf": true, "bank_import": false, "ocr": false, "e_document": false, "ai.features": false}',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
    "limits" = EXCLUDED."limits",
    "capabilities" = EXCLUDED."capabilities",
    "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "Plan" ("id", "code", "name", "limits", "capabilities", "isActive", "createdAt", "updatedAt") VALUES
(
    'plan_professional_default',
    'PROFESSIONAL',
    'Profesyonel',
    '{"users.active": 10, "projects.active": 25, "ai.monthly_quota": 500}',
    '{"reports.advanced": true, "export.xlsx": true, "export.pdf": true, "bank_import": true, "ocr": true, "e_document": false, "ai.features": true}',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
    "limits" = EXCLUDED."limits",
    "capabilities" = EXCLUDED."capabilities",
    "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "Plan" ("id", "code", "name", "limits", "capabilities", "isActive", "createdAt", "updatedAt") VALUES
(
    'plan_business_default',
    'BUSINESS',
    'İşletme',
    '{"users.active": 30, "projects.active": 100, "ai.monthly_quota": 2000}',
    '{"reports.advanced": true, "export.xlsx": true, "export.pdf": true, "bank_import": true, "ocr": true, "e_document": true, "ai.features": true}',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
    "limits" = EXCLUDED."limits",
    "capabilities" = EXCLUDED."capabilities",
    "updatedAt" = CURRENT_TIMESTAMP;
