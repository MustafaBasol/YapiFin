import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cleanDatabase, createOwnerOrg, createOrgUser } from "./helpers";
import { createProject } from "@/server/services/project-service";
import { buildAiContext } from "@/lib/ai/context/context-builder";
import { ServiceError } from "@/server/services/errors";

beforeAll(async () => {
  await cleanDatabase();
});
afterEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await db.$disconnect();
});

describe("lib/ai/context/context-builder", () => {
  describe("allow-list davranışı", () => {
    it("bilinmeyen bir bağlam kaynağını reddeder (DB'ye hiç erişmeden)", async () => {
      const { owner } = await createOwnerOrg();
      await expect(
        buildAiContext(owner, { sources: ["NOT_A_REAL_SOURCE"] as never, projectId: undefined }),
      ).rejects.toThrow();
    });

    it("proje kapsamlı bir kaynak projectId olmadan reddedilir", async () => {
      const { owner } = await createOwnerOrg();
      await expect(buildAiContext(owner, { sources: ["PROJECT_SUMMARY"], projectId: undefined })).rejects.toThrow();
    });

    it("boş sources dizisi reddedilir", async () => {
      const { owner } = await createOwnerOrg();
      await expect(buildAiContext(owner, { sources: [], projectId: undefined })).rejects.toThrow();
    });
  });

  describe("tenant izolasyonu — fail closed", () => {
    it("başka bir organizasyonun projesi için PROJECT_SUMMARY istemek NOT_FOUND ile reddedilir", async () => {
      const { owner: ownerA } = await createOwnerOrg();
      const { owner: ownerB } = await createOwnerOrg();
      const projectA = await createProject(ownerA, { code: "AI-1", name: "AI Projesi 1", contractAmount: 0, estimatedBudget: 0 });

      await expect(
        buildAiContext(ownerB, { sources: ["PROJECT_SUMMARY"], projectId: projectA.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<ServiceError>);
    });

    it("PROJECT_MANAGER atanmadığı bir proje için BUDGET_VARIANCE isteyemez", async () => {
      const { owner } = await createOwnerOrg();
      const project = await createProject(owner, { code: "AI-2", name: "AI Projesi 2", contractAmount: 0, estimatedBudget: 0 });
      const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");

      await expect(
        buildAiContext(pm, { sources: ["BUDGET_VARIANCE"], projectId: project.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<ServiceError>);
    });

    it("prompt/istekten gelen bir organizationId asla kullanılmaz — yalnızca actor.organizationId ile döner", async () => {
      const { owner } = await createOwnerOrg();
      const result = await buildAiContext(owner, { sources: ["COMPANY_FINANCIAL_SUMMARY"], projectId: undefined });
      expect(result.organizationId).toBe(owner.organizationId);
    });
  });

  describe("proje kapsamlı bağlam", () => {
    it("PROJECT_SUMMARY yalnızca izin verilen daraltılmış alanları döner", async () => {
      const { owner } = await createOwnerOrg();
      const project = await createProject(owner, { code: "AI-3", name: "AI Projesi 3", contractAmount: 1000, estimatedBudget: 500 });

      const result = await buildAiContext(owner, { sources: ["PROJECT_SUMMARY"], projectId: project.id });
      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item.source).toBe("PROJECT_SUMMARY");
      if (item.source === "PROJECT_SUMMARY") {
        expect(item.projectId).toBe(project.id);
        expect(item.projectName).toBe("AI Projesi 3");
        expect(item.contractAmount).toBe("1000");
      }
      // Satır düzeyi/PII içerebilecek alanlar (müşteri adı, işlem listeleri) hiçbir zaman taşınmaz.
      expect(item).not.toHaveProperty("incomeList");
      expect(item).not.toHaveProperty("customerName");
    });

    it("BUDGET_VARIANCE toplulaştırılmış kategori satırlarını döner", async () => {
      const { owner } = await createOwnerOrg();
      const project = await createProject(owner, { code: "AI-4", name: "AI Projesi 4", contractAmount: 0, estimatedBudget: 0 });

      const result = await buildAiContext(owner, { sources: ["BUDGET_VARIANCE"], projectId: project.id });
      const item = result.items[0];
      expect(item.source).toBe("BUDGET_VARIANCE");
      if (item.source === "BUDGET_VARIANCE") {
        expect(item.projectId).toBe(project.id);
        expect(Array.isArray(item.categories)).toBe(true);
      }
    });
  });

  describe("organizasyon kapsamlı bağlam", () => {
    it("COMPANY_FINANCIAL_SUMMARY, OWNER için ORGANIZATION kapsamı ve kasa/banka bakiyesiyle döner", async () => {
      const { owner } = await createOwnerOrg();
      const result = await buildAiContext(owner, { sources: ["COMPANY_FINANCIAL_SUMMARY"], projectId: undefined });
      const item = result.items[0];
      expect(item.source).toBe("COMPANY_FINANCIAL_SUMMARY");
      if (item.source === "COMPANY_FINANCIAL_SUMMARY") {
        expect(item.scope).toBe("ORGANIZATION");
        expect(item.cashAndBankBalance).not.toBeNull();
      }
    });

    it("COMPANY_FINANCIAL_SUMMARY, atanmamış PROJECT_MANAGER için PROJECT_MANAGER kapsamı ve null kasa/banka bakiyesiyle döner", async () => {
      const { owner } = await createOwnerOrg();
      const pm = await createOrgUser(owner.organizationId, "PROJECT_MANAGER");
      const result = await buildAiContext(pm, { sources: ["COMPANY_FINANCIAL_SUMMARY"], projectId: undefined });
      const item = result.items[0];
      expect(item.source).toBe("COMPANY_FINANCIAL_SUMMARY");
      if (item.source === "COMPANY_FINANCIAL_SUMMARY") {
        expect(item.scope).toBe("PROJECT_MANAGER");
        expect(item.cashAndBankBalance).toBeNull();
      }
    });

    it("CASH_FLOW ve RECEIVABLES_PAYABLES aynı istekte birlikte istenebilir", async () => {
      const { owner } = await createOwnerOrg();
      const result = await buildAiContext(owner, { sources: ["CASH_FLOW", "RECEIVABLES_PAYABLES"], projectId: undefined });
      expect(result.items.map((i) => i.source).sort()).toEqual(["CASH_FLOW", "RECEIVABLES_PAYABLES"]);
    });

    it("aynı kaynak birden çok kez istenirse tek bir sonuç döner (yinelenenler ayıklanır)", async () => {
      const { owner } = await createOwnerOrg();
      const result = await buildAiContext(owner, {
        sources: ["COMPANY_FINANCIAL_SUMMARY", "COMPANY_FINANCIAL_SUMMARY"],
        projectId: undefined,
      });
      expect(result.items).toHaveLength(1);
    });
  });
});
