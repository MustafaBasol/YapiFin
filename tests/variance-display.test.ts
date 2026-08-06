import { describe, expect, it } from "vitest";
import { getVarianceCardSemantics, getVarianceTone } from "@/lib/variance-display";

describe("variance-display — getVarianceTone", () => {
  it("pozitif sapma (bütçe aşımı) için destructive döner", () => {
    expect(getVarianceTone("1500")).toBe("destructive");
  });

  it("negatif sapma (tasarruf) için success döner", () => {
    expect(getVarianceTone("-1500")).toBe("success");
  });

  it("tam sıfır sapma için neutral döner", () => {
    expect(getVarianceTone("0")).toBe("neutral");
    expect(getVarianceTone("0.00")).toBe("neutral");
  });
});

describe("variance-display — getVarianceCardSemantics", () => {
  it("pozitif sapma: destructive ton ve 'Planlananın üzerinde' ipucu", () => {
    expect(getVarianceCardSemantics("2000")).toEqual({ tone: "destructive", hint: "Planlananın üzerinde" });
  });

  it("negatif sapma: success ton ve 'Planlananın altında' ipucu", () => {
    expect(getVarianceCardSemantics("-2000")).toEqual({ tone: "success", hint: "Planlananın altında" });
  });

  it("tam sıfır sapma: neutral ton ve 'Planlananla aynı' ipucu", () => {
    expect(getVarianceCardSemantics("0")).toEqual({ tone: "neutral", hint: "Planlananla aynı" });
  });
});
