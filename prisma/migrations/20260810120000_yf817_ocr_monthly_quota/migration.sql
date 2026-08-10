-- YF-817 — Add the missing `ocr.monthly_quota` canonical limit id to all
-- four canonical "Plan" rows' "limits" JSON. Forward-only, idempotent (a
-- targeted jsonb merge keyed on the existing unique "Plan_code_key" index —
-- same idempotency guarantee as the full-row ON CONFLICT DO UPDATE pattern
-- used by 20260809130000_yf801a_plan_seed_alignment, just narrower: this
-- migration touches ONLY the "limits" key being added, it does not restate
-- unrelated limits/capabilities).
--
-- Business context / blocker (see docs/PLAN_FEATURE_MATRIX.md §5 #5 and
-- §6, and docs/product/YF-807-plan-unit-economics.md §9 "OCR/belge işleme
-- ekonomisi"): `ocr` has always been a binary capability with NO
-- quantitative cap — a Professional/Business organization could
-- theoretically upload unlimited documents (only the existing 8 MB/file
-- size limit applied, see server/services/document-extraction-service.ts).
-- This migration adds the limit id itself; the enforcement engine (new
-- `countUsage` case in lib/entitlements/entitlement-service.ts, wired via
-- `assertWithinLimitAtomic` in `uploadAndExtractDocument`) ships in the
-- same YF-817 change set.
--
-- STARTER stays 0 — the `ocr` capability is already `false` there
-- (uploads are rejected before any quota check runs), so this is a
-- defense-in-depth value, not a new restriction.
--
-- PROFESSIONAL (50) and BUSINESS (200) numeric values are PROVISIONAL,
-- low-risk placeholder seed values ONLY — mirroring the EXACT same
-- placeholder convention already established for `ai.monthly_quota` (see
-- lib/entitlements/plan-defaults.ts doc comment and
-- 20260809130000_yf801a_plan_seed_alignment): they only need to satisfy
-- "Professional > 0" and "Business > Professional". The real commercial
-- OCR quota figures are an EXPLICIT, UNRESOLVED business/pricing decision
-- per YF-807 §9 ("Ön koşul mühendislik görevi" — no real OCR provider is
-- integrated today, so `OCR_COST_PER_PAGE` is purely symbolic; this
-- migration does NOT resolve that pricing decision, it only closes the
-- ENGINEERING gap so the quota can be enforced once real numbers exist).
--
-- ENTERPRISE stays null ("configurable"/unlimited), consistent with its
-- existing users.active/projects.active/ai.monthly_quota convention.
--
-- No "Organization"."planId" is read/written. No "DocumentExtraction" row
-- is touched — existing extraction history is untouched; it simply starts
-- counting toward the new quota for the CURRENT UTC calendar month onward
-- (see lib/entitlements/ocr-quota-usage.ts).

UPDATE "Plan"
SET "limits" = "limits" || '{"ocr.monthly_quota": 0}'::jsonb, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'STARTER';

UPDATE "Plan"
SET "limits" = "limits" || '{"ocr.monthly_quota": 50}'::jsonb, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'PROFESSIONAL';

UPDATE "Plan"
SET "limits" = "limits" || '{"ocr.monthly_quota": 200}'::jsonb, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'BUSINESS';

UPDATE "Plan"
SET "limits" = "limits" || '{"ocr.monthly_quota": null}'::jsonb, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'ENTERPRISE';
