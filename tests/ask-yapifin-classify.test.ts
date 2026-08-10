import { describe, it, expect } from "vitest";
import { classifyQuestion, ASK_UNSUPPORTED_REASON, ASK_AMBIGUOUS_PROJECT_REASON } from "@/lib/ai/ask/classify";

/**
 * YF-703 — `classifyQuestion` SAF bir fonksiyondur (DB/AI erişimi yok), bu
 * yüzden burada doğrudan birim testiyle doğrulanır. Servis katmanı testleri
 * (bkz. tests/ask-yapifin.test.ts) bunun kanonik servislerle entegrasyonunu
 * kapsar.
 */

const projects = [
  { id: "p1", name: "Akasya Konutları", code: "AKS-1" },
  { id: "p2", name: "Deniz Sitesi", code: "DNZ-2" },
];

describe("classifyQuestion", () => {
  it("'Bu ay toplam giderimiz ne kadar?' -> ORG_SUMMARY", () => {
    expect(classifyQuestion("Bu ay toplam giderimiz ne kadar?", [])).toEqual({
      supported: true,
      intent: "ORG_SUMMARY",
      projectId: null,
      projectName: null,
    });
  });

  it("'En fazla bütçe aşımı hangi projede?' -> TOP_BUDGET_OVERRUN", () => {
    expect(classifyQuestion("En fazla bütçe aşımı hangi projede?", [])).toEqual({
      supported: true,
      intent: "TOP_BUDGET_OVERRUN",
      projectId: null,
      projectName: null,
    });
  });

  it("'Vadesi geçen alacaklarımız ne kadar?' -> OVERDUE_RECEIVABLES", () => {
    expect(classifyQuestion("Vadesi geçen alacaklarımız ne kadar?", [])).toEqual({
      supported: true,
      intent: "OVERDUE_RECEIVABLES",
      projectId: null,
      projectName: null,
    });
  });

  it("'Nakit akışında risk var mı?' -> CASH_FLOW_STATUS", () => {
    expect(classifyQuestion("Nakit akışında risk var mı?", [])).toEqual({
      supported: true,
      intent: "CASH_FLOW_STATUS",
      projectId: null,
      projectName: null,
    });
  });

  it("'Hangi kategoride gider yoğunlaşması var?' -> EXPENSE_CONCENTRATION", () => {
    expect(classifyQuestion("Hangi kategoride gider yoğunlaşması var?", [])).toEqual({
      supported: true,
      intent: "EXPENSE_CONCENTRATION",
      projectId: null,
      projectName: null,
    });
  });

  it("proje adı geçen soru -> PROJECT_STATUS, doğru projectId ile eşleşir", () => {
    expect(classifyQuestion("Akasya Konutları projesinin finansal durumu nasıl?", projects)).toEqual({
      supported: true,
      intent: "PROJECT_STATUS",
      projectId: "p1",
      projectName: "Akasya Konutları",
    });
  });

  it("proje kodu geçen soru -> PROJECT_STATUS ile eşleşir", () => {
    expect(classifyQuestion("DNZ-2 nasıl gidiyor?", projects)).toEqual({
      supported: true,
      intent: "PROJECT_STATUS",
      projectId: "p2",
      projectName: "Deniz Sitesi",
    });
  });

  it("birden fazla proje eşleşirse belirsiz kabul edilir, AI'ye yönlendirilmez", () => {
    expect(classifyQuestion("Akasya Konutları ve Deniz Sitesi projelerinin durumu nasıl?", projects)).toEqual({
      supported: false,
      reason: ASK_AMBIGUOUS_PROJECT_REASON,
    });
  });

  it("proje sözü geçen ama hiçbir proje adı eşleşmeyen soru desteklenmiyor olarak işaretlenir (uydurma yok)", () => {
    expect(classifyQuestion("Bilinmeyen Proje X'in durumu nasıl?", projects)).toEqual({
      supported: false,
      reason: ASK_UNSUPPORTED_REASON,
    });
  });

  it("konuyla ilgisiz bir soru desteklenmiyor olarak işaretlenir", () => {
    expect(classifyQuestion("Yarın hava nasıl olacak?", [])).toEqual({
      supported: false,
      reason: ASK_UNSUPPORTED_REASON,
    });
  });

  it("Türkçe büyük/küçük harf (İ/I) doğru normalize edilir", () => {
    expect(classifyQuestion("NAKİT AKIŞINDA RİSK VAR MI?", [])).toEqual({
      supported: true,
      intent: "CASH_FLOW_STATUS",
      projectId: null,
      projectName: null,
    });
  });
});
