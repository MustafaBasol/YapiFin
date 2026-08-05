import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createProject, assignProjectMember, setProjectStatus } from "@/server/services/project-service";
import { generateToken } from "@/lib/auth/tokens";
import { SESSION_COOKIE } from "@/lib/auth/session";
import type { SessionUser } from "@/lib/auth/session";

/**
 * YF-405 — dışa aktarma route handler'larının gerçek bir `next start`
 * sunucusuna karşı, gerçek HTTP istekleriyle doğrulanması. Yalnızca
 * `scripts/run-export-integration-tests.mjs` tarafından, sunucu ayaktayken
 * çalıştırılır (bkz. vitest.integration.config.ts). `getSessionUser()`
 * `next/headers`'ın istek-kapsamlı `cookies()`'ine bağlı olduğundan, bir
 * route handler'ı doğrudan (gerçek bir HTTP isteği olmadan) çağırmak bu
 * mekanizmayı tetiklemez — bu yüzden servis katmanı testleri (bkz.
 * tests/report-export-service.test.ts) `SessionUser`'ı doğrudan geçirirken,
 * BU dosya gerçek `fetch()` + gerçek `Cookie` başlığıyla uçtan uca doğrular.
 */

const BASE_URL = process.env.EXPORT_INTEGRATION_BASE_URL;
if (!BASE_URL) {
  throw new Error("EXPORT_INTEGRATION_BASE_URL tanımlı değil — bu test yalnızca scripts/run-export-integration-tests.mjs üzerinden çalıştırılmalıdır.");
}

beforeAll(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await cleanDatabase();
  await db.$disconnect();
});

async function createRealSessionCookie(userId: string): Promise<string> {
  const { raw, hash } = generateToken();
  await db.session.create({
    data: { userId, tokenHash: hash, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  });
  return `${SESSION_COOKIE}=${raw}`;
}

async function seedProject(owner: SessionUser) {
  const project = await createProject(owner, { code: `INT-${Date.now()}`, name: "Entegrasyon Projesi", contractAmount: 0, estimatedBudget: 0 });
  await setProjectStatus(owner, project.id, "ACTIVE");
  return project;
}

describe("Dışa aktarma route handler'ları — gerçek next start sunucusuna karşı", () => {
  it("kimliği doğrulanmamış istek 401 döner", async () => {
    const res = await fetch(`${BASE_URL}/api/exports/dashboard?format=xlsx`);
    expect(res.status).toBe(401);
  });

  it("OWNER için dashboard xlsx dışa aktarımı doğru başlıklarla 200 döner", async () => {
    const { owner } = await createOwnerOrg();
    const cookie = await createRealSessionCookie(owner.id);

    const res = await fetch(`${BASE_URL}/api/exports/dashboard?format=xlsx`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="yapifin-finans-ozeti-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString("hex")).toBe("504b");
  });

  it("OWNER için dashboard pdf dışa aktarımı doğru başlıklarla 200 döner", async () => {
    const { owner } = await createOwnerOrg();
    const cookie = await createRealSessionCookie(owner.id);

    const res = await fetch(`${BASE_URL}/api/exports/dashboard?format=pdf`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("FINANCE rolü organizasyon geneli cash-flow dışa aktarımını 200 ile yapabilir", async () => {
    const { organizationId } = await createOwnerOrg();
    const finance = await createOrgUser(organizationId, "FINANCE");
    const cookie = await createRealSessionCookie(finance.id);

    const res = await fetch(`${BASE_URL}/api/exports/cash-flow?format=xlsx&range=NEXT_30_DAYS`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });

  it("PROJECT_MANAGER atandığı projenin finans raporunu 200 ile dışa aktarabilir", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const project = await seedProject(owner);
    await assignProjectMember(owner, project.id, pm.id);
    const cookie = await createRealSessionCookie(pm.id);

    const res = await fetch(`${BASE_URL}/api/exports/project-finance?format=xlsx&projectId=${project.id}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });

  it("cross-tenant proje id'si 404 döner", async () => {
    const { owner: ownerA } = await createOwnerOrg();
    const { owner: ownerB } = await createOwnerOrg();
    const projectB = await seedProject(ownerB);
    const cookie = await createRealSessionCookie(ownerA.id);

    const res = await fetch(`${BASE_URL}/api/exports/project-finance?format=xlsx&projectId=${projectB.id}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("PROJECT_MANAGER'ın atanmadığı proje 404 döner", async () => {
    const { owner, organizationId } = await createOwnerOrg();
    const pm = await createOrgUser(organizationId, "PROJECT_MANAGER");
    const unassigned = await seedProject(owner);
    const cookie = await createRealSessionCookie(pm.id);

    const res = await fetch(`${BASE_URL}/api/exports/project-finance?format=xlsx&projectId=${unassigned.id}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it("geçersiz format 400 döner", async () => {
    const { owner } = await createOwnerOrg();
    const cookie = await createRealSessionCookie(owner.id);

    const res = await fetch(`${BASE_URL}/api/exports/budget?format=docx`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(400);
  });
});
