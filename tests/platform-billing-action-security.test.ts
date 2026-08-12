import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * YF-820 — `reconcilePlatformOrganizationBillingAction`
 * (app/actions/platform-billing.ts) yetki sınırı testleri.
 *
 * `requirePlatformAdmin()` (lib/auth/platform-guard.ts, YF-818'den DEĞİŞTİRİLMEDEN
 * yeniden kullanılır) `next/headers` `cookies()`e bağlıdır ve React `cache()`
 * ile sarmalanmıştır — bu ikisi TEK istek-kapsamlı bir Next.js sunucu
 * bağlamı DIŞINDA (düz bir vitest testinde) güvenilir biçimde çalıştırılamaz
 * (bkz. tests/platform-admin-auth.test.ts dosya başı notu — YF-818 AYNI
 * gerekçeyle `getPlatformAdminSessionUser`'ı doğrudan ÇAĞIRMAKTAN KAÇINIR).
 * Bu dosya bu yüzden `requirePlatformAdmin`'in KENDİSİNİ mock'lar ve action'ın
 * onu HER ZAMAN, herhangi bir form doğrulaması/servis çağrısından ÖNCE
 * çağırdığını VE reddettiğinde (fırlattığında/yönlendirdiğinde) mutabakat
 * servisinin HİÇ TETİKLENMEDİĞİNİ kanıtlar — fail-closed sözleşmesinin
 * gerçek KANIT NOKTASI budur (`requirePlatformAdmin`in KENDİSİ zaten YF-818
 * kapsamında test edilmiştir, burada TEKRAR test EDİLMEZ).
 *
 * Tenant OWNER/ADMIN/FINANCE'ın bu action'a asla platform-admin olarak
 * erişemeyeceği YAPISAL bir garantidir: platform-admin oturumu TAMAMEN AYRI
 * bir çerez (`yapifin_platform_session`) + AYRI bir kimlik tablosudur
 * (`PlatformAdmin`, `User` DEĞİL) — bkz. lib/auth/platform-session.ts dosya
 * başı notu VE tests/platform-admin-auth.test.ts "iki farklı kimlik sistemi
 * ÇAPRAZ kimlik doğrulama YAPMAZ" testi. Bu action `requirePlatformAdmin`i
 * DEĞİŞTİRMEDEN, YF-818'den OLDUĞU GİBİ yeniden kullandığı için AYNI garanti
 * buraya da OTOMATİK olarak taşınır.
 */

const { requirePlatformAdminMock } = vi.hoisted(() => ({ requirePlatformAdminMock: vi.fn() }));
vi.mock("@/lib/auth/platform-guard", () => ({ requirePlatformAdmin: requirePlatformAdminMock }));

const { reconcileMock } = vi.hoisted(() => ({ reconcileMock: vi.fn() }));
vi.mock("@/server/services/platform/platform-billing-reconciliation-service", () => ({
  reconcilePlatformOrganizationSubscription: reconcileMock,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  reconcilePlatformOrganizationBillingAction,
  initialPlatformBillingReconciliationState,
} from "@/app/actions/platform-billing";

afterEach(() => {
  requirePlatformAdminMock.mockReset();
  reconcileMock.mockReset();
});

describe("YF-820 — reconcilePlatformOrganizationBillingAction yetki sınırı", () => {
  it("platform-admin oturumu YOKSA (requirePlatformAdmin reddeder/yönlendirir) mutabakat servisi HİÇ ÇAĞRILMAZ", async () => {
    requirePlatformAdminMock.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT:/platform/login");
    });

    const formData = new FormData();
    formData.set("organizationId", "org_whatever");

    await expect(
      reconcilePlatformOrganizationBillingAction(initialPlatformBillingReconciliationState, formData),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("geçerli bir platform-admin oturumunda, DOĞRULANMIŞ organizationId/reason ile mutabakat servisini çağırır", async () => {
    const admin = { id: "admin-1", email: "admin@example.com", name: "Admin", status: "ACTIVE" as const };
    requirePlatformAdminMock.mockResolvedValue(admin);
    reconcileMock.mockResolvedValue({
      organizationId: "org_1",
      before: { found: true, status: "ACTIVE", planCode: "STARTER", cancelAtPeriodEnd: false, billingHealth: {} },
      after: { found: true, status: "ACTIVE", planCode: "STARTER", cancelAtPeriodEnd: false, billingHealth: {} },
      changed: false,
      lastSyncAt: new Date(),
      warnings: [],
    });

    const formData = new FormData();
    formData.set("organizationId", "org_1");
    formData.set("reason", "destek talebi #1234");

    const state = await reconcilePlatformOrganizationBillingAction(initialPlatformBillingReconciliationState, formData);

    expect(requirePlatformAdminMock).toHaveBeenCalled();
    expect(reconcileMock).toHaveBeenCalledWith(admin, "org_1", "destek talebi #1234");
    expect(state.error).toBeUndefined();
    expect(state.success).toBeDefined();
  });

  it("boş organizationId için servis ASLA çağrılmadan doğrulama hatası döner", async () => {
    requirePlatformAdminMock.mockResolvedValue({ id: "admin-1", email: "admin@example.com", name: "Admin", status: "ACTIVE" });

    const formData = new FormData();
    formData.set("organizationId", "");

    const state = await reconcilePlatformOrganizationBillingAction(initialPlatformBillingReconciliationState, formData);
    expect(state.error).toBeDefined();
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
