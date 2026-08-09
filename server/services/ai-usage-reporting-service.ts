import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { ServiceError } from "@/server/services/errors";
import {
  checkCapability,
  checkLimit,
  getEffectivePlan,
  lockOrganizationForEntitlement,
  resolveLimitMax,
} from "@/lib/entitlements/entitlement-service";
import { getCurrentPeriodAiCreditsUsed } from "@/lib/entitlements/ai-quota-usage";
import { getAiQuotaPeriodStart } from "@/lib/ai/quota-period";
import { AI_CREDIT_POLICY, estimateReservationCredits, tokensToCredits, creditsToEstimatedCostUsd } from "@/lib/ai/credits";
import {
  runAiCompletion,
  AiError,
  type AiProvider,
  type AiMessage,
  type AiCompletionResult,
  type AiUsageReporter,
  type AiQuotaDecision,
  type AiQuotaCheckRequest,
  type AiUsageReportEntry,
} from "@/lib/ai";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-711 — `ai.features`/`ai.monthly_quota` reddi için kararlı, makine-okunur
 * sınıflandırma. `ServiceError`'ı GENİŞLETİR (ikinci, ilgisiz bir hata
 * hiyerarşisi DEĞİL) — `code` (FORBIDDEN/CONFLICT) her zaman diğer tüm
 * entitlement reddleriyle (bkz. lib/entitlements/entitlement-service.ts
 * forbidden()/conflict()) aynı genel anlamı taşır; `reasonCode` bunun
 * ÜZERİNE, gelecekteki bir yükseltme/kota UX'inin güvenle eşleyebileceği
 * AI'ya özgü bir sınıflandırma ekler (bkz. lib/ai/errors.ts AiError.category
 * ile aynı desen).
 */
export type AiEntitlementReasonCode = "AI_PLAN_REQUIRED" | "AI_QUOTA_EXCEEDED";

export class AiEntitlementError extends ServiceError {
  constructor(message: string, code: "FORBIDDEN" | "CONFLICT", public readonly reasonCode: AiEntitlementReasonCode) {
    super(message, code);
    this.name = "AiEntitlementError";
  }
}

function warnFinalizationSuperseded(entry: AiUsageReportEntry, ledgerId: string) {
  // YF-711 — geç kalan bir finalize çağrısı (bkz. plan "Row-identity guard"):
  // rezervasyon bu sırada bir retry tarafından geri kazanılmış (recycle) veya
  // zaten kesinleşmiş. Sessizce yutulmaz — gözlemlenebilir bir uyarı yayılır.
  // Bu, o yörüngesiz (orphaned) denemenin gerçek sağlayıcı maliyetinin bu
  // fazda mükemmel şekilde uzlaştırılamayacağı, belgelenmiş, ERTELENMİŞ bir
  // YF-709/sağlayıcı-maliyet-uzlaştırma takip maddesidir — hiçbir kredi
  // tüketimi/maliyet yazılmaz (çift ücretlendirme YOK), yalnızca o tek
  // denemenin kullanım kaydı kaybolur.
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "ai_usage.finalize_skipped_superseded",
      organizationId: entry.organizationId,
      ledgerId,
      correlationId: entry.correlationId,
    }),
  );
}

interface OwnedReservation {
  id: string;
  attemptCount: number;
}

export interface EntitlementAiUsageReporter extends AiUsageReporter {
  /** Bu çağrı bir rezervasyon sahibiyse satır kimliğini döner — aksi halde `null` (kota/yetenek reddi, ya da nadir eşzamanlılık geri dönüşü). */
  getReservationId(): string | null;
}

/**
 * YF-701'in `AiUsageReporter` sınırının gerçek (YF-711) implementasyonu.
 * `runAiCompletion` (bkz. lib/ai/service.ts) tarafından yalnızca bu arayüz
 * üzerinden çağrılır — Prisma'ya asla doğrudan bağımlı olmaz. Her
 * `requestAiCompletion` çağrısı için TAZE bir örnek oluşturulur (bkz. alt
 * kısım) — `owned` kapanışı (closure) yalnızca O çağrının rezervasyonunu
 * tutar, çağrılar arası sızıntı yoktur.
 */
export function createEntitlementAiUsageReporter(actor: SessionUser): EntitlementAiUsageReporter {
  let owned: OwnedReservation | null = null;

  async function checkQuota(organizationId: string, request: AiQuotaCheckRequest): Promise<AiQuotaDecision> {
    if (organizationId !== actor.organizationId) {
      // Asla olmamalı — organizationId her zaman requestAiCompletion tarafından
      // actor.organizationId'den türetilir, hiçbir zaman istemciden kabul edilmez.
      throw new Error("AI kota kontrolü: organizationId oturumla eşleşmiyor");
    }

    const now = new Date();
    const periodStart = getAiQuotaPeriodStart(now);
    const reservationExpiresAt = new Date(now.getTime() + AI_CREDIT_POLICY.reservationTtlMs);
    const estimate = request.reservationCreditsEstimate;

    return db.$transaction(async (tx) => {
      const capability = await checkCapability(tx, organizationId, "ai.features");
      if (!capability.allowed) {
        return {
          allowed: false,
          reason: "Planınız yapay zekâ özelliklerini içermiyor. Devam etmek için planınızı yükseltmeniz gerekir.",
          reasonCode: "AI_PLAN_REQUIRED",
        };
      }

      // YF-711 — organizasyon satırını kilitler (bkz. lockOrganizationForEntitlement,
      // aynı SELECT ... FOR UPDATE deseni server/services/project-service.ts
      // createProject/invitation-service.ts acceptInvitation ile) — bu org için
      // tüm AI rezervasyon denemelerini serileştirir.
      await lockOrganizationForEntitlement(tx, organizationId);

      const existing = await tx.aiUsageLedger.findUnique({
        where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: request.idempotencyKey } },
      });

      if (existing?.status === "COMMITTED") {
        // Nadir yarış geri dönüşü — yaygın durum requestAiCompletion'ın erken
        // kontrolünde zaten yakalanır (bkz. aşağıda).
        return { allowed: false, reason: "Bu istek daha önce tamamlandı.", reasonCode: "AI_REQUEST_ALREADY_COMPLETED" };
      }
      if (existing?.status === "RESERVED" && existing.reservationExpiresAt > now) {
        return { allowed: false, reason: "Bu istek zaten işleniyor.", reasonCode: "AI_REQUEST_IN_PROGRESS" };
      }

      const plan = await getEffectivePlan(tx, organizationId);
      const max = resolveLimitMax(plan, "ai.monthly_quota");

      if (existing) {
        // FAILED veya bayat (expired) RESERVED — aynı satırı denetlenebilir
        // biçimde geri kazan (recycle): idempotencyKey slotu değişmez,
        // createdAt ASLA dokunulmaz (orijinal denemenin kanıtı korunur),
        // attemptCount hem denetim izidir hem de reportUsage'ın "fencing"
        // (çitleme) anahtarıdır (bkz. dosya başı yorumu).
        const used = await getCurrentPeriodAiCreditsUsed(tx, organizationId, { excludeLedgerRowId: existing.id });
        if (max !== null && used + estimate > max) {
          return { allowed: false, reason: "AI kullanım kotanız doldu.", reasonCode: "AI_QUOTA_EXCEEDED" };
        }

        const newAttemptCount = existing.attemptCount + 1;
        await tx.aiUsageLedger.update({
          where: { id: existing.id },
          data: {
            status: "RESERVED",
            reservedCredits: estimate,
            consumedCredits: 0,
            consumedCreditsCapped: false,
            reservationExpiresAt,
            attemptCount: newAttemptCount,
            lastReservationAt: now,
            correlationId: request.correlationId,
            provider: request.provider,
            model: request.model,
            failureCategory: null,
          },
        });
        await writeAuditLog(tx, {
          organizationId,
          actorId: actor.id,
          action: "ai_usage.reservation_recycled",
          entityType: "AiUsageLedger",
          entityId: existing.id,
          before: { attemptCount: existing.attemptCount, correlationId: existing.correlationId, status: existing.status },
          after: { attemptCount: newAttemptCount, correlationId: request.correlationId },
        });

        owned = { id: existing.id, attemptCount: newAttemptCount };
        return { allowed: true };
      }

      const used = await getCurrentPeriodAiCreditsUsed(tx, organizationId);
      if (max !== null && used + estimate > max) {
        return { allowed: false, reason: "AI kullanım kotanız doldu.", reasonCode: "AI_QUOTA_EXCEEDED" };
      }

      const created = await tx.aiUsageLedger.create({
        data: {
          organizationId,
          periodStart,
          idempotencyKey: request.idempotencyKey,
          provider: request.provider,
          model: request.model,
          status: "RESERVED",
          reservedCredits: estimate,
          reservationExpiresAt,
          attemptCount: 1,
          lastReservationAt: now,
          correlationId: request.correlationId,
          createdById: actor.id,
        },
      });
      owned = { id: created.id, attemptCount: 1 };
      return { allowed: true };
    });
  }

  async function reportUsage(entry: AiUsageReportEntry): Promise<void> {
    if (!owned) {
      // Hiçbir rezervasyon yapılmadı (yetenek/kota reddi veya nadir yarış geri
      // dönüşü) — serbest bırakılacak bir şey yok.
      return;
    }
    const { id, attemptCount } = owned;

    await db.$transaction(async (tx) => {
      if (entry.status === "failure") {
        // WHERE guard'ı (id + attemptCount + status) — geç kalan bir finalize
        // çağrısının, aynı satır kimliğini yeniden kullanan bir sonraki
        // rezervasyonu (recycle) bozmasını engeller (bkz. dosya başı yorumu).
        const result = await tx.aiUsageLedger.updateMany({
          where: { id, attemptCount, status: "RESERVED" },
          data: { status: "FAILED", consumedCredits: 0, consumedCreditsCapped: false, failureCategory: entry.failureCategory ?? null },
        });
        if (result.count === 0) warnFinalizationSuperseded(entry, id);
        return;
      }

      const row = await tx.aiUsageLedger.findFirst({ where: { id, attemptCount, status: "RESERVED" } });
      if (!row) {
        warnFinalizationSuperseded(entry, id);
        return;
      }

      // YF-711 — sert kota garantisi: gerçek (uncapped) kullanım rezervasyonu
      // aşsa bile müşteriye yansıyan tüketim ASLA reservedCredits'i geçemez
      // (bkz. AiUsageLedger.consumedCredits doküman notu). Token sayıları ve
      // maliyet yaklaşıklaması her zaman GERÇEK (uncapped) kullanımdan
      // hesaplanır — kota güvenliği için yapılan sınırlama, sağlayıcı
      // kaynak tüketimini gözlemlenebilirlikten GİZLEMEZ.
      const actualCredits = tokensToCredits(entry.usage);
      const consumedCredits = Math.min(actualCredits, row.reservedCredits);
      const consumedCreditsCapped = actualCredits > row.reservedCredits;

      const result = await tx.aiUsageLedger.updateMany({
        where: { id, attemptCount, status: "RESERVED" },
        data: {
          status: "COMMITTED",
          consumedCredits,
          consumedCreditsCapped,
          inputTokens: entry.usage.promptTokens,
          outputTokens: entry.usage.completionTokens,
          totalTokens: entry.usage.totalTokens,
          estimatedCostUsd: creditsToEstimatedCostUsd(actualCredits),
        },
      });
      if (result.count === 0) warnFinalizationSuperseded(entry, id);
    });
  }

  return {
    checkQuota,
    reportUsage,
    getReservationId: () => owned?.id ?? null,
  };
}

export type AiCompletionOutcome =
  | { status: "completed"; result: AiCompletionResult; ledgerId: string }
  | { status: "already_processed"; ledgerId: string; idempotencyKey: string };

export interface RequestAiCompletionInput {
  provider: AiProvider;
  idempotencyKey: string;
  messages: AiMessage[];
  promptVersion: string;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  correlationId?: string;
}

/**
 * YF-711 — YF-701'in `runAiCompletion`'ını merkezi entitlement katmanına
 * bağlayan tek orkestrasyon noktası. `organizationId` YALNIZCA güvenilir
 * `actor` oturumundan türetilir — `input`de hiçbir organizationId alanı
 * YOKTUR, bir AI isteğinden/istemciden asla kabul edilmez.
 *
 * İki katmanlı kontrol (bkz. server/services/invitation-service.ts
 * createInvitation/acceptInvitation ile aynı desen): burada erken,
 * bilgilendirici bir kontrol (hızlı, açık FORBIDDEN/CONFLICT); asıl
 * otoriter/eşzamanlılığa-karşı-güvenli kontrol `createEntitlementAiUsageReporter`
 * içindeki atomik `checkQuota`dadır.
 */
export async function requestAiCompletion(actor: SessionUser, input: RequestAiCompletionInput): Promise<AiCompletionOutcome> {
  const organizationId = actor.organizationId;

  const existing = await db.aiUsageLedger.findUnique({
    where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing?.status === "COMMITTED") {
    // YF-711 — idempotent tekrar: sağlayıcı ASLA tekrar çağrılmaz, ikinci kez
    // ücretlendirilmez. Ledger yalnızca kullanım METAVERİSİ tuttuğundan
    // (ham AI çıktısı asla saklanmaz), burada UYDURULMUŞ bir sonuç
    // DÖNDÜRÜLMEZ — çağıran, bu isteğin daha önce tamamlandığını öğrenir.
    return { status: "already_processed", ledgerId: existing.id, idempotencyKey: input.idempotencyKey };
  }

  const capability = await checkCapability(db, organizationId, "ai.features");
  if (!capability.allowed) {
    throw new AiEntitlementError(
      "Planınız yapay zekâ özelliklerini içermiyor. Devam etmek için planınızı yükseltmeniz gerekir.",
      "FORBIDDEN",
      "AI_PLAN_REQUIRED",
    );
  }

  const estimate = estimateReservationCredits({ messages: input.messages, maxOutputTokens: input.maxOutputTokens });
  const early = await checkLimit(db, organizationId, "ai.monthly_quota");
  if (early.max !== null && early.used + estimate > early.max) {
    throw new AiEntitlementError(
      "AI kullanım kotanız doldu. Yeni dönemde veya planınızı yükselttiğinizde tekrar deneyebilirsiniz.",
      "CONFLICT",
      "AI_QUOTA_EXCEEDED",
    );
  }

  const reporter = createEntitlementAiUsageReporter(actor);
  let result: AiCompletionResult;
  try {
    result = await runAiCompletion({
      provider: input.provider,
      organizationId,
      idempotencyKey: input.idempotencyKey,
      messages: input.messages,
      promptVersion: input.promptVersion,
      model: input.model,
      maxOutputTokens: input.maxOutputTokens,
      temperature: input.temperature,
      timeoutMs: input.timeoutMs,
      correlationId: input.correlationId,
      usageReporter: reporter,
    });
  } catch (err) {
    // Atomik (otoriter) kontrol içindeki nadir yarış reddi — yaygın durum
    // yukarıdaki erken kontrolde zaten yakalanır; bu yalnızca bir arka güvenlik
    // ağıdır. Her iki katman da aynı AiEntitlementError şekline normalize
    // edilir, böylece çağıranlar tek bir hata tipi ele alır.
    if (err instanceof AiError && err.reasonCode === "AI_PLAN_REQUIRED") {
      throw new AiEntitlementError(err.message, "FORBIDDEN", "AI_PLAN_REQUIRED");
    }
    if (err instanceof AiError && err.reasonCode === "AI_QUOTA_EXCEEDED") {
      throw new AiEntitlementError(err.message, "CONFLICT", "AI_QUOTA_EXCEEDED");
    }
    throw err;
  }

  // checkQuota `allowed: true` döndürdüğünde her zaman bir rezervasyon
  // oluşturur/geri kazanır (bkz. yukarıdaki checkQuota implementasyonu) —
  // runAiCompletion başarıyla döndüyse bir rezervasyon sahibi OLMALIDIR.
  const ledgerId = reporter.getReservationId();
  if (!ledgerId) throw new Error("AI tamamlama başarılı ama rezervasyon kimliği bulunamadı (beklenmeyen durum)");

  return { status: "completed", result, ledgerId };
}
