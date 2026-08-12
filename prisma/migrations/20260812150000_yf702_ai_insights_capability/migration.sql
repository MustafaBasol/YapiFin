-- YF-702 — Add the `ai.insights` capability id to all four canonical "Plan"
-- rows' "capabilities" JSON. Forward-only and idempotent (a targeted jsonb
-- merge keyed on the existing unique "Plan_code_key" index — the exact same
-- narrow-merge pattern as 20260810120000_yf817_ocr_monthly_quota: this
-- migration touches ONLY the capability key being added, it does not restate
-- unrelated limits/capabilities).
--
-- Why this migration is MANDATORY, not cosmetic:
-- `resolveCapabilityValue` (lib/entitlements/entitlement-service.ts) is
-- fail-closed — it compares `plan.capabilities[id] === true`, so a Plan row
-- that simply LACKS this key denies the feature. Shipping the new capability
-- id in lib/entitlements/capabilities.ts WITHOUT this migration would
-- silently turn AI Insights off for every existing organization, including
-- Professional/Business/Enterprise tenants that are entitled to it.
--
-- Relationship to `ai.features` (see the doc comment on the capability id):
-- this is an ADDITIONAL, per-feature gate layered UNDER the existing AI
-- umbrella, NOT a replacement. `requestAiCompletion` still checks
-- `ai.features` on every AI call, and the shared `ai.monthly_quota` pool is
-- unchanged — no parallel subscription or quota system is introduced. The
-- per-feature id exists so a future AI surface (e.g. `ai.ask_yapifin`) can be
-- packaged independently per plan while sharing the same credit pool.
--
-- Plan placement follows the canonical decision matrix in
-- docs/PLAN_FEATURE_MATRIX.md §3.2 ("ai.insights: Not included @ Starter,
-- Included from Professional upward"), mirroring lib/entitlements/plan-defaults.ts.
--
-- STARTER stays false — `ai.features` is already false there, so the AI call
-- is rejected before this gate is ever consulted. This is a defense-in-depth
-- value, not a new restriction.
--
-- No "Organization"."planId" is read or written. No "AiUsageLedger" row is
-- touched — quota accounting and billing periods are entirely unaffected.
-- Stripe remains authoritative for subscription lifecycle.

UPDATE "Plan"
SET "capabilities" = "capabilities" || '{"ai.insights": false}'::jsonb, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'STARTER';

UPDATE "Plan"
SET "capabilities" = "capabilities" || '{"ai.insights": true}'::jsonb, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'PROFESSIONAL';

UPDATE "Plan"
SET "capabilities" = "capabilities" || '{"ai.insights": true}'::jsonb, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'BUSINESS';

UPDATE "Plan"
SET "capabilities" = "capabilities" || '{"ai.insights": true}'::jsonb, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'ENTERPRISE';
