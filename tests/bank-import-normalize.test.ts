import { describe, expect, it } from "vitest";
import {
  parseTurkishAmount,
  parseFlexibleDate,
  parseCsvRows,
  resolveHeaderMap,
  sniffFileKind,
  decodeCsvText,
  computeRowFingerprint,
} from "@/server/services/bank-import/normalize";

describe("parseTurkishAmount", () => {
  it("Türkçe biçimi (binlik nokta, ondalık virgül) ayrıştırır", () => {
    expect(parseTurkishAmount("1.234,56")?.toString()).toBe("1234.56");
  });
  it("İngilizce biçimi (binlik virgül, ondalık nokta) ayrıştırır", () => {
    expect(parseTurkishAmount("1,234.56")?.toString()).toBe("1234.56");
  });
  it("negatif tutarı (eksi işareti) tanır", () => {
    expect(parseTurkishAmount("-750,00")?.toString()).toBe("-750");
  });
  it("parantezli negatif tutarı tanır", () => {
    expect(parseTurkishAmount("(750,00)")?.toString()).toBe("-750");
  });
  it("₺ sembolünü ve boşlukları yoksayar", () => {
    expect(parseTurkishAmount("₺ 1.000,00")?.toString()).toBe("1000");
  });
  it("anlamsız metni null döner (sessizce 0 olmaz)", () => {
    expect(parseTurkishAmount("elli TL")).toBeNull();
  });
  it("sıfır tutarı null döner", () => {
    expect(parseTurkishAmount("0,00")).toBeNull();
  });
  it("boş metni null döner", () => {
    expect(parseTurkishAmount("")).toBeNull();
  });
  it("tek virgülden sonra 2'den farklı hane sayısı varsa virgülü binlik ayırıcı sayar (ondalık değil)", () => {
    expect(parseTurkishAmount("100,123")?.toString()).toBe("100123");
  });
  it("rakam/ayraç dışında karakter içeren dizeyi null döner", () => {
    expect(parseTurkishAmount("12x34")).toBeNull();
  });
});

describe("parseFlexibleDate", () => {
  it("GG.AA.YYYY biçimini ayrıştırır", () => {
    const d = parseFlexibleDate("15.03.2026");
    expect(d?.toISOString().slice(0, 10)).toBe("2026-03-15");
  });
  it("ISO YYYY-MM-DD biçimini ayrıştırır", () => {
    const d = parseFlexibleDate("2026-03-15");
    expect(d?.toISOString().slice(0, 10)).toBe("2026-03-15");
  });
  it("GG/AA/YYYY biçimini ayrıştırır", () => {
    const d = parseFlexibleDate("15/03/2026");
    expect(d?.toISOString().slice(0, 10)).toBe("2026-03-15");
  });
  it("takvimde var olmayan tarihi (31 Şubat) null döner", () => {
    expect(parseFlexibleDate("31.02.2026")).toBeNull();
  });
  it("2 haneli yıl gibi belirsiz biçimleri null döner", () => {
    expect(parseFlexibleDate("15.03.26")).toBeNull();
  });
  it("ay 13 gibi geçersiz değerleri null döner", () => {
    expect(parseFlexibleDate("15.13.2026")).toBeNull();
  });
  it("boş metni null döner", () => {
    expect(parseFlexibleDate("")).toBeNull();
  });
});

describe("parseCsvRows", () => {
  it("virgülle ayrılmış basit satırları ayrıştırır", () => {
    const rows = parseCsvRows("a,b,c\n1,2,3");
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });
  it("noktalı virgülü otomatik algılar (Türk bankası biçimi)", () => {
    const rows = parseCsvRows("Tarih;Tutar\n01.03.2026;1.000,00");
    expect(rows).toEqual([
      ["Tarih", "Tutar"],
      ["01.03.2026", "1.000,00"],
    ]);
  });
  it("tırnaklı alan içindeki virgülü ayraç olarak saymaz", () => {
    const rows = parseCsvRows('a,"b, ile devam",c\n1,2,3');
    expect(rows[0]).toEqual(["a", "b, ile devam", "c"]);
  });
  it("çift tırnak kaçışını (\"\") ayrıştırır", () => {
    const rows = parseCsvRows('a,"içinde ""tırnak"" var"\n1,2');
    expect(rows[0][1]).toBe('içinde "tırnak" var');
  });
});

describe("resolveHeaderMap", () => {
  it("Türkçe başlıkları eşler", () => {
    const map = resolveHeaderMap(["Tarih", "Açıklama", "Tutar", "Referans"]);
    expect(map).toEqual({ date: 0, description: 1, amount: 2, valueDate: null, reference: 3, counterparty: null });
  });
  it("eksik zorunlu başlıkta ServiceError fırlatır", () => {
    expect(() => resolveHeaderMap(["Tarih", "Açıklama"])).toThrow();
  });
  it("parantezli ek metni (ör. Tutar (TL)) yoksayarak eşler", () => {
    const map = resolveHeaderMap(["Tarih", "Açıklama", "Tutar (TL)"]);
    expect(map.amount).toBe(2);
  });
});

describe("sniffFileKind / decodeCsvText", () => {
  it("ZIP magic number'ı xlsx olarak tanır", () => {
    expect(sniffFileKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe("xlsx");
  });
  it("düz metni csv olarak tanır", () => {
    expect(sniffFileKind(Buffer.from("Tarih,Tutar\n"))).toBe("csv");
  });
  it("geçersiz UTF-8 baytlarını reddeder (null döner)", () => {
    expect(decodeCsvText(Buffer.from([0xff, 0xfe, 0x00, 0x81]))).toBeNull();
  });
  it("BOM'u temizler", () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Tarih,Tutar")]);
    expect(decodeCsvText(withBom)).toBe("Tarih,Tutar");
  });
});

describe("computeRowFingerprint", () => {
  it("aynı girdi için deterministik aynı sonucu üretir", () => {
    const base = {
      organizationId: "org1",
      financialAccountId: "acc1",
      transactionDateIso: "2026-03-01T00:00:00.000Z",
      valueDateIso: "",
      amount: "100.00",
      direction: "CREDIT",
      currency: "TRY",
      bankReference: "",
      description: "test",
      occurrenceIndex: 0,
    };
    expect(computeRowFingerprint(base)).toBe(computeRowFingerprint({ ...base }));
  });
  it("occurrenceIndex farklıysa farklı sonuç üretir (aynı görünen mükerrer satırları ayırt eder)", () => {
    const base = {
      organizationId: "org1",
      financialAccountId: "acc1",
      transactionDateIso: "2026-03-01T00:00:00.000Z",
      valueDateIso: "",
      amount: "100.00",
      direction: "CREDIT",
      currency: "TRY",
      bankReference: "",
      description: "test",
      occurrenceIndex: 0,
    };
    expect(computeRowFingerprint(base)).not.toBe(computeRowFingerprint({ ...base, occurrenceIndex: 1 }));
  });
});
