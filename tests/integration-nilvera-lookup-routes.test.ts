import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resetEnvCacheForTests } from "@/lib/env";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createConnection, setConnectionCredential } from "@/server/services/integrations/integration-service";
import { registerProviderAdapterForTests, resetProviderRegistryForTests } from "@/server/services/integrations/provider-registry";
import { createNilveraProviderAdapter } from "@/server/services/integrations/providers/nilvera-provider";

/**
 * YF-605-D-UI — `POST /api/integrations/connections/[id]/lookups/taxpayer`
 * ve `.../lookups/document-status` uç noktalarının testleri. Domain
 * fonksiyonlarının (`lookupTaxpayer`/`lookupDocumentStatus`) kendisi zaten
 * `tests/integration-nilvera-lookup-service.test.ts` içinde uçtan uca
 * doğrulanmıştır — burada yalnızca ROTA katmanı (HTTP durum kodu eşleme,
 * kimlik doğrulama, istek gövdesi ayrıştırma/doğrulama, sağlayıcı
 * sonucunun JSON gövdesine sızmadan taşınması) test edilir.
 */
const TEST_KEY = "e".repeat(64);
let originalKey: string | undefined;

const sessionUserMock = vi.fn();
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, getSessionUser: () => sessionUserMock() };
});

const { POST: taxpayerLookupPOST } = await import("@/app/api/integrations/connections/[id]/lookups/taxpayer/route");
const { POST: documentStatusLookupPOST } = await import(
  "@/app/api/integrations/connections/[id]/lookups/document-status/route"
);
const taxpayerRouteModule = await import("@/app/api/integrations/connections/[id]/lookups/taxpayer/route");
const documentStatusRouteModule = await import("@/app/api/integrations/connections/[id]/lookups/document-status/route");

beforeAll(async () => {
  originalKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = TEST_KEY;
  process.env.AUTH_SECRET ??= "a".repeat(32);
  process.env.NEXT_PUBLIC_APP_URL ??= "https://app.example.com";
  resetEnvCacheForTests();
  await cleanDatabase();
});
beforeEach(() => {
  process.env.INTEGRATION_ENCRYPTION_KEY = TEST_KEY;
  resetEnvCacheForTests();
  sessionUserMock.mockReset();
});
afterEach(async () => {
  resetProviderRegistryForTests();
  await cleanDatabase();
});
afterAll(async () => {
  if (originalKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  else process.env.INTEGRATION_ENCRYPTION_KEY = originalKey;
  resetEnvCacheForTests();
  await db.$disconnect();
});

const nilveraConnectionInput = {
  integrationType: "E_INVOICE" as const,
  provider: "NILVERA" as const,
  environment: "SANDBOX" as const,
  displayName: "Nilvera Sandbox Bağlantısı",
  externalTenantId: undefined,
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function registerNilveraWithFetch(fetchImpl: typeof fetch) {
  registerProviderAdapterForTests("NILVERA", () => createNilveraProviderAdapter({ fetchImpl }));
}

async function createConnectionWithCredential(
  owner: Awaited<ReturnType<typeof createOwnerOrg>>["owner"],
  secretValue = "nilvera-test-sir-degeri",
) {
  const connection = await createConnection(owner, nilveraConnectionInput);
  await setConnectionCredential(owner, { connectionId: connection.id, secretValue });
  return connection;
}

function taxpayerRequest(body: unknown) {
  return new NextRequest(new URL("http://localhost/api/integrations/connections/x/lookups/taxpayer"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function documentStatusRequest(body: unknown) {
  return new NextRequest(new URL("http://localhost/api/integrations/connections/x/lookups/document-status"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/integrations/connections/[id]/lookups/taxpayer", () => {
  it("oturum yoksa 401 döner", async () => {
    sessionUserMock.mockResolvedValue(null);
    const res = await taxpayerLookupPOST(taxpayerRequest({ identifier: "34918613960" }), params("any"));
    expect(res.status).toBe(401);
  });

  it("geçersiz vergi/kimlik numarası biçimi 400 ile reddedilir (adaptöre hiç ulaşmaz)", async () => {
    const { owner } = await createOwnerOrg();
    sessionUserMock.mockResolvedValue(owner);
    const connection = await createConnectionWithCredential(owner);
    const res = await taxpayerLookupPOST(taxpayerRequest({ identifier: "abc" }), params(connection.id));
    expect(res.status).toBe(400);
  });

  it("yetkili kullanıcı için başarılı sorgu 200 + normalize edilmiş sonuç döner", async () => {
    const { owner } = await createOwnerOrg();
    sessionUserMock.mockResolvedValue(owner);
    registerNilveraWithFetch(vi.fn(async () => jsonResponse(200, [{ DocumentType: "Invoice" }])) as unknown as typeof fetch);
    const connection = await createConnectionWithCredential(owner);

    const res = await taxpayerLookupPOST(taxpayerRequest({ identifier: "34918613960" }), params(connection.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      result: { identifier: "34918613960", isEDocumentTaxpayer: true, supportedDocumentType: "Invoice" },
    });
  });

  it("kayıtlı olmayan mükellef (404) — 200 + isEDocumentTaxpayer:false, hata DEĞİL", async () => {
    const { owner } = await createOwnerOrg();
    sessionUserMock.mockResolvedValue(owner);
    registerNilveraWithFetch(vi.fn(async () => jsonResponse(404, {})) as unknown as typeof fetch);
    const connection = await createConnectionWithCredential(owner);

    const res = await taxpayerLookupPOST(taxpayerRequest({ identifier: "34918613960" }), params(connection.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      result: { identifier: "34918613960", isEDocumentTaxpayer: false, supportedDocumentType: null },
    });
  });

  it("sağlayıcı istek sınırı (429) — 200 + ok:false, category:RATE_LIMIT", async () => {
    const { owner } = await createOwnerOrg();
    sessionUserMock.mockResolvedValue(owner);
    registerNilveraWithFetch(vi.fn(async () => jsonResponse(429, {})) as unknown as typeof fetch);
    const connection = await createConnectionWithCredential(owner);

    const res = await taxpayerLookupPOST(taxpayerRequest({ identifier: "34918613960" }), params(connection.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.category).toBe("RATE_LIMIT");
  });

  it("sağlayıcı geçici hatası (5xx) — 200 + ok:false, category:TEMPORARY_PROVIDER", async () => {
    const { owner } = await createOwnerOrg();
    sessionUserMock.mockResolvedValue(owner);
    registerNilveraWithFetch(vi.fn(async () => jsonResponse(502, {})) as unknown as typeof fetch);
    const connection = await createConnectionWithCredential(owner);

    const res = await taxpayerLookupPOST(taxpayerRequest({ identifier: "34918613960" }), params(connection.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.category).toBe("TEMPORARY_PROVIDER");
  });

  it("başka organizasyonun bağlantısı için sorgu 404 ile reddedilir (cross-tenant fail-closed)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const connection = await createConnectionWithCredential(ownerA);
    sessionUserMock.mockResolvedValue(ownerB);

    const res = await taxpayerLookupPOST(taxpayerRequest({ identifier: "34918613960" }), params(connection.id));
    expect(res.status).toBe(404);
  });

  it("FINANCE rolü sorgu başlatamaz — 403", async () => {
    const { owner } = await createOwnerOrg();
    const finance = await createOrgUser(owner.organizationId, "FINANCE");
    const connection = await createConnectionWithCredential(owner);
    sessionUserMock.mockResolvedValue(finance);

    const res = await taxpayerLookupPOST(taxpayerRequest({ identifier: "34918613960" }), params(connection.id));
    expect(res.status).toBe(403);
  });

  it("sır değeri hiçbir hata yanıtı gövdesinde görünmez", async () => {
    const { owner } = await createOwnerOrg();
    sessionUserMock.mockResolvedValue(owner);
    const secret = "asla-sizmamasi-gereken-nilvera-sir-42";
    registerNilveraWithFetch(
      vi.fn(async () => {
        throw new TypeError(`network error while using token ${secret}`);
      }) as unknown as typeof fetch,
    );
    const connection = await createConnectionWithCredential(owner, secret);

    const res = await taxpayerLookupPOST(taxpayerRequest({ identifier: "34918613960" }), params(connection.id));
    const rawText = JSON.stringify(await res.json());
    expect(rawText).not.toContain(secret);
  });
});

describe("POST /api/integrations/connections/[id]/lookups/document-status", () => {
  it("oturum yoksa 401 döner", async () => {
    sessionUserMock.mockResolvedValue(null);
    const res = await documentStatusLookupPOST(documentStatusRequest({ externalDocumentId: "uuid-1" }), params("any"));
    expect(res.status).toBe(401);
  });

  it("yetkili kullanıcı için başarılı sorgu 200 + normalize edilmiş durum döner (ACCEPTED)", async () => {
    const { owner } = await createOwnerOrg();
    sessionUserMock.mockResolvedValue(owner);
    registerNilveraWithFetch(
      vi.fn(async () =>
        jsonResponse(200, {
          Answer: { AnswerCode: "approved" },
          InvoiceStatus: { Code: "succeed" },
          EnvelopeInfo: { CreatedDate: "2026-02-01T00:00:00Z" },
        }),
      ) as unknown as typeof fetch,
    );
    const connection = await createConnectionWithCredential(owner);

    const res = await documentStatusLookupPOST(documentStatusRequest({ externalDocumentId: "uuid-99" }), params(connection.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      result: {
        externalDocumentId: "uuid-99",
        status: "ACCEPTED",
        providerStatusCode: "succeed",
        lastKnownProviderTimestamp: "2026-02-01T00:00:00Z",
      },
    });
  });

  it("bilinmeyen belge referansı (404) — 200 + ok:false, category:VALIDATION", async () => {
    const { owner } = await createOwnerOrg();
    sessionUserMock.mockResolvedValue(owner);
    registerNilveraWithFetch(vi.fn(async () => jsonResponse(404, {})) as unknown as typeof fetch);
    const connection = await createConnectionWithCredential(owner);

    const res = await documentStatusLookupPOST(
      documentStatusRequest({ externalDocumentId: "bilinmeyen" }),
      params(connection.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.category).toBe("VALIDATION");
  });

  it("boş belge referans kimliği 400 ile reddedilir", async () => {
    const { owner } = await createOwnerOrg();
    sessionUserMock.mockResolvedValue(owner);
    const connection = await createConnectionWithCredential(owner);

    const res = await documentStatusLookupPOST(documentStatusRequest({ externalDocumentId: "" }), params(connection.id));
    expect(res.status).toBe(400);
  });

  it("başka organizasyonun bağlantısı için sorgu 404 ile reddedilir (cross-tenant fail-closed)", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const connection = await createConnectionWithCredential(ownerA);
    sessionUserMock.mockResolvedValue(ownerB);

    const res = await documentStatusLookupPOST(documentStatusRequest({ externalDocumentId: "uuid-1" }), params(connection.id));
    expect(res.status).toBe(404);
  });

  it("PROJECT_MANAGER rolü sorgu başlatamaz — 403", async () => {
    const { owner } = await createOwnerOrg();
    const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
    const connection = await createConnectionWithCredential(owner);
    sessionUserMock.mockResolvedValue(pm);

    const res = await documentStatusLookupPOST(documentStatusRequest({ externalDocumentId: "uuid-1" }), params(connection.id));
    expect(res.status).toBe(403);
  });
});

describe("giden/mutasyon kapasitesi eklenmedi", () => {
  it("hiçbir lookup rotası GET/PUT/PATCH/DELETE dışa aktarmaz — yalnızca salt-okunur POST sorgusu", () => {
    for (const mod of [taxpayerRouteModule, documentStatusRouteModule]) {
      expect(mod.POST).toBeTypeOf("function");
      expect((mod as Record<string, unknown>).GET).toBeUndefined();
      expect((mod as Record<string, unknown>).PUT).toBeUndefined();
      expect((mod as Record<string, unknown>).PATCH).toBeUndefined();
      expect((mod as Record<string, unknown>).DELETE).toBeUndefined();
    }
  });
});
