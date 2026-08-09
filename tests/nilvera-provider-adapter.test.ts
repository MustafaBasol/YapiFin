import { describe, expect, it, vi } from "vitest";
import { createNilveraProviderAdapter } from "@/server/services/integrations/providers/nilvera-provider";
import { ProviderError, type ProviderConnectionContext } from "@/server/services/integrations/provider-adapter";

/**
 * YF-605-D — Nilvera sandbox adaptörünün birim testleri. Gerçek ağ çağrısı
 * YAPILMAZ (görev talimatı "Do not make real external network calls in
 * automated tests") — `fetchImpl` her testte enjekte edilen bir sahte
 * fonksiyondur.
 */
const sandboxCtx: ProviderConnectionContext = {
  connectionId: "conn-1",
  organizationId: "org-1",
  provider: "NILVERA",
  environment: "SANDBOX",
  externalTenantId: null,
};

const productionCtx: ProviderConnectionContext = { ...sandboxCtx, environment: "PRODUCTION" };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function malformedJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("bozuk gövde");
    },
  } as unknown as Response;
}

function adapterWithFetch(fetchImpl: typeof fetch) {
  return createNilveraProviderAdapter({ fetchImpl });
}

describe("Nilvera sandbox adaptörü (YF-605-D)", () => {
  it("yetenekler yalnızca TAXPAYER_LOOKUP ve DOCUMENT_STATUS_LOOKUP içerir", () => {
    const adapter = createNilveraProviderAdapter();
    expect(adapter.capabilities).toEqual(
      expect.arrayContaining(["TAXPAYER_LOOKUP", "DOCUMENT_STATUS_LOOKUP"]),
    );
    expect(adapter.capabilities).not.toContain("CONNECTION_TEST");
    expect(adapter.capabilities).not.toContain("OUTBOUND_OPERATION");
  });

  it("testConnection ve executeOutboundOperation desteklenmiyor (READ-ONLY kapsam) — VALIDATION ile reddedilir", async () => {
    const adapter = createNilveraProviderAdapter();
    await expect(adapter.testConnection({ secretValue: "x" }, sandboxCtx)).rejects.toMatchObject({
      category: "VALIDATION",
    });
    await expect(
      adapter.executeOutboundOperation(
        { operationType: "EINVOICE_SUBMIT", idempotencyKey: "k1" },
        { secretValue: "x" },
        sandboxCtx,
      ),
    ).rejects.toMatchObject({ category: "VALIDATION" });
  });

  describe("PRODUCTION ortamı reddi", () => {
    it("PRODUCTION ortamında mükellef/sorgu çağrıları VALIDATION ile reddedilir (bu adaptör yalnızca SANDBOX)", async () => {
      const fetchImpl = vi.fn();
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      await expect(
        adapter.lookupTaxpayer!({ identifier: "1111111111" }, { secretValue: "key" }, productionCtx),
      ).rejects.toMatchObject({ category: "VALIDATION" });
      await expect(
        adapter.lookupDocumentStatus!({ externalDocumentId: "uuid-1" }, { secretValue: "key" }, productionCtx),
      ).rejects.toMatchObject({ category: "VALIDATION" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("kimlik bilgisi/girdi doğrulama", () => {
    it("kimlik bilgisi boşsa AUTH_CONFIG ile reddedilir (ağ çağrısı yapılmaz)", async () => {
      const fetchImpl = vi.fn();
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      await expect(
        adapter.lookupTaxpayer!({ identifier: "1111111111" }, { secretValue: "" }, sandboxCtx),
      ).rejects.toMatchObject({ category: "AUTH_CONFIG" });
      await expect(
        adapter.lookupDocumentStatus!({ externalDocumentId: "uuid-1" }, { secretValue: "" }, sandboxCtx),
      ).rejects.toMatchObject({ category: "AUTH_CONFIG" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("boş/whitespace tanımlayıcı VALIDATION ile reddedilir", async () => {
      const fetchImpl = vi.fn();
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      await expect(
        adapter.lookupTaxpayer!({ identifier: "   " }, { secretValue: "key" }, sandboxCtx),
      ).rejects.toMatchObject({ category: "VALIDATION" });
      await expect(
        adapter.lookupDocumentStatus!({ externalDocumentId: "" }, { secretValue: "key" }, sandboxCtx),
      ).rejects.toMatchObject({ category: "VALIDATION" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("mükellef sorgulama (VKN ile Sorgular)", () => {
    it("başarılı yanıt e-belge mükellefi olarak normalize edilir", async () => {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe(
          "https://apitest.nilvera.com/general/GlobalCompany/Check/TaxNumber/34918613960?globalUserType=Invoice",
        );
        expect(init?.method).toBe("GET");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
        return jsonResponse(200, [{ TaxNumber: "34918613960", Title: "Test A.Ş.", DocumentType: "Invoice" }]);
      });
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      const result = await adapter.lookupTaxpayer!(
        { identifier: "34918613960" },
        { secretValue: "test-key" },
        sandboxCtx,
      );
      expect(result).toEqual({
        identifier: "34918613960",
        isEDocumentTaxpayer: true,
        supportedDocumentType: "Invoice",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("404 — e-belge mükellefi değil olarak normalize edilir (hata DEĞİLDİR)", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(404, { message: "not found" }));
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      const result = await adapter.lookupTaxpayer!(
        { identifier: "00000000000" },
        { secretValue: "test-key" },
        sandboxCtx,
      );
      expect(result).toEqual({
        identifier: "00000000000",
        isEDocumentTaxpayer: false,
        supportedDocumentType: null,
      });
    });

    it("boş liste (200) — e-belge mükellefi değil olarak normalize edilir", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, []));
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      const result = await adapter.lookupTaxpayer!(
        { identifier: "00000000000" },
        { secretValue: "test-key" },
        sandboxCtx,
      );
      expect(result.isEDocumentTaxpayer).toBe(false);
    });
  });

  describe("belge durumu sorgulama (Giden Faturanın Statü Bilgilerini Getirir)", () => {
    it("başarılı yanıt ACCEPTED olarak normalize edilir", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        expect(url).toBe("https://apitest.nilvera.com/einvoice/Sale/uuid-123/Status");
        return jsonResponse(200, {
          InvoiceProfile: "TEMELFATURA",
          IssueDate: "2026-01-15T10:30:00Z",
          Answer: { AnswerCode: "approved", AnswerNote: "ok" },
          InvoiceStatus: { Code: "succeed", Description: "ok" },
          EnvelopeInfo: { UUID: "uuid-123", GIBCode: 200, GIBDescription: "Success", CreatedDate: "2026-01-15T10:31:00Z" },
        });
      });
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      const result = await adapter.lookupDocumentStatus!(
        { externalDocumentId: "uuid-123" },
        { secretValue: "test-key" },
        sandboxCtx,
      );
      expect(result).toEqual({
        externalDocumentId: "uuid-123",
        status: "ACCEPTED",
        providerStatusCode: "succeed",
        lastKnownProviderTimestamp: "2026-01-15T10:31:00Z",
      });
    });

    it("AnswerCode 'rejected' — REJECTED olarak normalize edilir", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(200, { Answer: { AnswerCode: "rejected" }, InvoiceStatus: { Code: "succeed" } }),
      );
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      const result = await adapter.lookupDocumentStatus!(
        { externalDocumentId: "uuid-1" },
        { secretValue: "k" },
        sandboxCtx,
      );
      expect(result.status).toBe("REJECTED");
    });

    it("InvoiceStatus.Code 'error' — ERROR olarak normalize edilir", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, { InvoiceStatus: { Code: "error" } }));
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      const result = await adapter.lookupDocumentStatus!(
        { externalDocumentId: "uuid-1" },
        { secretValue: "k" },
        sandboxCtx,
      );
      expect(result.status).toBe("ERROR");
    });

    it("InvoiceStatus.Code 'waiting' — PENDING olarak normalize edilir", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, { InvoiceStatus: { Code: "waiting" } }));
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      const result = await adapter.lookupDocumentStatus!(
        { externalDocumentId: "uuid-1" },
        { secretValue: "k" },
        sandboxCtx,
      );
      expect(result.status).toBe("PENDING");
    });

    it("bilinmeyen kod kombinasyonu — UNKNOWN olarak normalize edilir", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      const result = await adapter.lookupDocumentStatus!(
        { externalDocumentId: "uuid-1" },
        { secretValue: "k" },
        sandboxCtx,
      );
      expect(result.status).toBe("UNKNOWN");
    });

    it("404 — belge referansı bulunamadı, VALIDATION ile reddedilir (mükellef sorgusundan farklı olarak burada geçerli bir sonuç DEĞİLDİR)", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(404, {}));
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      await expect(
        adapter.lookupDocumentStatus!({ externalDocumentId: "bilinmeyen-uuid" }, { secretValue: "k" }, sandboxCtx),
      ).rejects.toMatchObject({ category: "VALIDATION" });
    });
  });

  describe("HTTP hata sınıflandırması (her iki uç nokta için ortak)", () => {
    const cases: Array<{ status: number; category: string; label: string }> = [
      { status: 401, category: "AUTH_CONFIG", label: "401" },
      { status: 403, category: "AUTH_CONFIG", label: "403" },
      { status: 400, category: "VALIDATION", label: "400" },
      { status: 429, category: "RATE_LIMIT", label: "429" },
      { status: 500, category: "TEMPORARY_PROVIDER", label: "500" },
      { status: 503, category: "TEMPORARY_PROVIDER", label: "503" },
      { status: 418, category: "UNKNOWN", label: "beklenmeyen 418" },
    ];

    for (const { status, category, label } of cases) {
      it(`${label} -> ${category}`, async () => {
        const fetchImpl = vi.fn(async () => jsonResponse(status, { message: "hata" }));
        const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
        await expect(
          adapter.lookupTaxpayer!({ identifier: "34918613960" }, { secretValue: "k" }, sandboxCtx),
        ).rejects.toMatchObject({ category });
      });
    }

    it("zaman aşımı (AbortError) -> TIMEOUT_NETWORK", async () => {
      const fetchImpl = vi.fn(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      });
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      await expect(
        adapter.lookupTaxpayer!({ identifier: "34918613960" }, { secretValue: "k" }, sandboxCtx),
      ).rejects.toMatchObject({ category: "TIMEOUT_NETWORK" });
    });

    it("ağ hatası (DNS/bağlantı reddi) -> TIMEOUT_NETWORK", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError("fetch failed");
      });
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      await expect(
        adapter.lookupDocumentStatus!({ externalDocumentId: "uuid-1" }, { secretValue: "k" }, sandboxCtx),
      ).rejects.toMatchObject({ category: "TIMEOUT_NETWORK" });
    });

    it("bozuk/ayrıştırılamayan gövde -> UNKNOWN", async () => {
      const fetchImpl = vi.fn(async () => malformedJsonResponse(200));
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      await expect(
        adapter.lookupTaxpayer!({ identifier: "34918613960" }, { secretValue: "k" }, sandboxCtx),
      ).rejects.toMatchObject({ category: "UNKNOWN" });
    });

    it("beklenmeyen yanıt biçimi (mükellef sorgusunda dizi değil) -> mükellef değil olarak ele alınır, hata fırlatmaz", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, { unexpected: "shape" }));
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      const result = await adapter.lookupTaxpayer!(
        { identifier: "34918613960" },
        { secretValue: "k" },
        sandboxCtx,
      );
      expect(result.isEDocumentTaxpayer).toBe(false);
    });

    it("beklenmeyen yanıt biçimi (belge durumunda obje değil) -> UNKNOWN", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, ["not-an-object"]));
      const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
      await expect(
        adapter.lookupDocumentStatus!({ externalDocumentId: "uuid-1" }, { secretValue: "k" }, sandboxCtx),
      ).rejects.toMatchObject({ category: "UNKNOWN" });
    });
  });

  it("yalnızca GET istekleri yapılır — hiçbir mutasyon (POST/PUT/DELETE) çağrısı yoktur", async () => {
    const calledMethods: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calledMethods.push(init?.method);
      return jsonResponse(200, [{ DocumentType: "Invoice" }]);
    });
    const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
    await adapter.lookupTaxpayer!({ identifier: "34918613960" }, { secretValue: "k" }, sandboxCtx);
    await adapter.lookupDocumentStatus!({ externalDocumentId: "uuid-1" }, { secretValue: "k" }, sandboxCtx).catch(() => {});
    expect(calledMethods.every((m) => m === "GET")).toBe(true);
  });

  it("ProviderError sınıfı kullanılır — sağlayıcıya özgü ayrı bir hata taksonomisi İCAT edilmez", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, {}));
    const adapter = adapterWithFetch(fetchImpl as unknown as typeof fetch);
    try {
      await adapter.lookupTaxpayer!({ identifier: "34918613960" }, { secretValue: "k" }, sandboxCtx);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
    }
  });
});
