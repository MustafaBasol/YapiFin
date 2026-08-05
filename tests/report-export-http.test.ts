import { describe, expect, it } from "vitest";
import { errorToResponse, buildExportResponse } from "@/server/exports/http";
import { ServiceError } from "@/server/services/errors";
import { buildExportFilename, buildContentDisposition, slugifyTurkish } from "@/server/exports/filename";

describe("server/exports/http — hata → HTTP durum kodu eşlemesi", () => {
  it("ServiceError VALIDATION → 400", async () => {
    const res = errorToResponse(new ServiceError("Geçersiz filtre", "VALIDATION"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Geçersiz filtre");
  });

  it("ServiceError FORBIDDEN → 403", async () => {
    const res = errorToResponse(new ServiceError("Yetkiniz yok", "FORBIDDEN"));
    expect(res.status).toBe(403);
  });

  it("ServiceError NOT_FOUND → 404", async () => {
    const res = errorToResponse(new ServiceError("Bulunamadı", "NOT_FOUND"));
    expect(res.status).toBe(404);
  });

  it("ServiceError CONFLICT → 409", async () => {
    const res = errorToResponse(new ServiceError("Çakışma", "CONFLICT"));
    expect(res.status).toBe(409);
  });

  it("beklenmeyen hata → 500, genel Türkçe mesaj, iç hata/stack sızdırılmaz", async () => {
    const internal = new Error("connection string leaked: postgres://user:pass@host/db");
    const res = errorToResponse(internal);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain("postgres://");
    expect(body.error).not.toContain("leaked");
    expect(JSON.stringify(body)).not.toContain("at ");
  });
});

describe("server/exports/http — dışa aktarma yanıt başlıkları", () => {
  it("xlsx için doğru Content-Type/Disposition/Cache-Control/nosniff üretir", () => {
    const res = buildExportResponse({
      buffer: Buffer.from("test"),
      filename: "yapifin-finans-ozeti-2026-08-05.xlsx",
      contentDisposition: 'attachment; filename="yapifin-finans-ozeti-2026-08-05.xlsx"',
    });
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="yapifin-finans-ozeti-2026-08-05.xlsx"');
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("pdf için application/pdf döner", () => {
    const res = buildExportResponse({
      buffer: Buffer.from("test"),
      filename: "yapifin-nakit-akisi-2026-08-05.pdf",
      contentDisposition: 'attachment; filename="yapifin-nakit-akisi-2026-08-05.pdf"',
    });
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });
});

describe("server/exports/filename — Türkçe slugify ve dosya adı güvenliği", () => {
  it("Türkçe karakterleri ASCII'ye çevirir", () => {
    expect(slugifyTurkish("Şirin Öztürk İnşaat Çözümleri Ğ")).toBe("sirin-ozturk-insaat-cozumleri-g");
  });

  it("boşlukları ve tekrarlanan tireleri normalize eder", () => {
    expect(slugifyTurkish("  A   B---C  ")).toBe("a-b-c");
  });

  it("başlık enjeksiyon denemesini (CR/LF, tırnak) tamamen temizler", () => {
    const malicious = 'Proje"; injected\r\nX-Evil: 1';
    const slug = slugifyTurkish(malicious);
    expect(slug).not.toMatch(/["\r\n]/);
    expect(slug).toMatch(/^[a-z0-9-]*$/);
  });

  it("buildExportFilename beklenen deseni üretir", () => {
    const filename = buildExportFilename("yapifin-proje-finans", "pdf", "2026-08-05", "Şantiye A");
    expect(filename).toBe("yapifin-proje-finans-santiye-a-2026-08-05.pdf");
  });

  it("buildContentDisposition güvenli tırnaklı değer üretir", () => {
    const filename = buildExportFilename("yapifin-finans-ozeti", "xlsx", "2026-08-05");
    const header = buildContentDisposition(filename);
    expect(header).toBe('attachment; filename="yapifin-finans-ozeti-2026-08-05.xlsx"');
    expect(header).not.toMatch(/[\r\n]/);
  });

  it("bozuk/beklenmeyen bir ad deseni sabit bir yedek dosya adına düşer, kısmen temizlenmiş içerik sızdırmaz", () => {
    // slugifyTurkish alfabesi zaten CR/LF/tırnak üretemez; bu test yalnızca
    // buildExportFilename'in kendi savunma kontrolünün gerçekten çalıştığını,
    // yani sabit desene uymayan hiçbir sonucun döndürülmediğini doğrular.
    const filename = buildExportFilename("", "xlsx", "2026-08-05");
    expect(filename).toMatch(/^[a-z0-9][a-z0-9-]*-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});
