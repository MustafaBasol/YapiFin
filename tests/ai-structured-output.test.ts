import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseStructuredOutput } from "@/lib/ai/structured-output";

const exampleSchema = z.object({
  summary: z.string().min(1),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
});

describe("lib/ai/structured-output", () => {
  it("geçerli JSON + şemayla eşleşen çıktıyı ayrıştırır", () => {
    const result = parseStructuredOutput(exampleSchema, JSON.stringify({ summary: "ok", riskLevel: "LOW" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBe("ok");
    }
  });

  it("bozuk JSON'da asla fırlatmaz — güvenli bir başarısızlık sonucu döner", () => {
    expect(() => parseStructuredOutput(exampleSchema, "bu json değil {{{")).not.toThrow();
    const result = parseStructuredOutput(exampleSchema, "bu json değil {{{");
    expect(result.success).toBe(false);
  });

  it("şemayla eşleşmeyen geçerli JSON'ı reddeder (eksik alan)", () => {
    const result = parseStructuredOutput(exampleSchema, JSON.stringify({ summary: "ok" }));
    expect(result.success).toBe(false);
  });

  it("şemayla eşleşmeyen geçerli JSON'ı reddeder (yanlış tip/enum dışı değer)", () => {
    const result = parseStructuredOutput(exampleSchema, JSON.stringify({ summary: "ok", riskLevel: "UYDURMA" }));
    expect(result.success).toBe(false);
  });

  it("modelin uydurduğu fazladan alanlar de dahil olmak üzere yalnızca şemadaki alanları döner", () => {
    const result = parseStructuredOutput(
      exampleSchema,
      JSON.stringify({ summary: "ok", riskLevel: "HIGH", uydurulmusAlan: "sızmamalı" }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("uydurulmusAlan");
    }
  });

  it("JSON dizisi/primitif gibi nesne olmayan kök değerleri reddeder", () => {
    const result = parseStructuredOutput(exampleSchema, JSON.stringify([1, 2, 3]));
    expect(result.success).toBe(false);
  });
});
