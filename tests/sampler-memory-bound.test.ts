import { describe, it, expect, beforeEach } from "vitest";
import { shouldForwardToRemote, resetSamplerForTests, samplerWindowCountForTests } from "@/lib/monitoring/sampler";

const HARD_CAP = 5000;

describe("shouldForwardToRemote — bellek sınırlı örnekleme penceresi (lib/monitoring/sampler.ts)", () => {
  beforeEach(() => resetSamplerForTests());

  it("aynı anahtar için pencere başına maxPerWindow kadar iletime izin verir, ötesini düşürür", () => {
    const opts = { windowMs: 60_000, maxPerWindow: 3 };
    expect(shouldForwardToRemote("k1", opts)).toBe(true);
    expect(shouldForwardToRemote("k1", opts)).toBe(true);
    expect(shouldForwardToRemote("k1", opts)).toBe(true);
    expect(shouldForwardToRemote("k1", opts)).toBe(false);
    expect(shouldForwardToRemote("k1", opts)).toBe(false);
  });

  it("farklı anahtarlar (scope) birbirini yanlışlıkla etkilemez", () => {
    const opts = { windowMs: 60_000, maxPerWindow: 1 };
    expect(shouldForwardToRemote("a", opts)).toBe(true);
    expect(shouldForwardToRemote("a", opts)).toBe(false);
    expect(shouldForwardToRemote("b", opts)).toBe(true);
  });

  it("pencere süresi dolduğunda aynı anahtarın sayacı sıfırlanır (normal sabit-pencere semantiği korunur)", async () => {
    const opts = { windowMs: 30, maxPerWindow: 1 };
    expect(shouldForwardToRemote("k2", opts)).toBe(true);
    expect(shouldForwardToRemote("k2", opts)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(shouldForwardToRemote("k2", opts)).toBe(true);
  });

  it("süresi dolmuş pencereler geri kazanılabilir: kapasite dolunca yeni anahtar eklenirken önce süresi dolanlar temizlenir", async () => {
    const shortLived = { windowMs: 20, maxPerWindow: 1 };
    for (let i = 0; i < HARD_CAP; i++) shouldForwardToRemote(`cap-fill-${i}`, shortLived);
    expect(samplerWindowCountForTests()).toBe(HARD_CAP);

    // Doldurulan pencerelerin tümünün süresi dolsun.
    await new Promise((resolve) => setTimeout(resolve, 50));

    shouldForwardToRemote("new-key-after-expiry", shortLived);

    // Yalnızca "en eskisini at" stratejisi olsaydı boyut hâlâ HARD_CAP
    // civarında kalırdı (bir atılıp bir eklenir); süresi dolmuş binlerce
    // pencere gerçekten temizlendiği için boyut çok daha küçük olmalı.
    expect(samplerWindowCountForTests()).toBeLessThan(100);
  });

  it("benzersiz-anahtar seli (yüksek kardinaliteli saldırı, ör. failed_login subjectHash) Map boyutunu sabit üst sınırın üzerine çıkaramaz", () => {
    // windowMs uzun tutulur: bu turda hiçbir pencerenin süresi dolmaz —
    // saf "üst sınır aşılamaz" davranışı (yalnızca en-eski tahliyesi) test edilir.
    const opts = { windowMs: 5 * 60_000, maxPerWindow: 5 };
    for (let i = 0; i < HARD_CAP * 4; i++) {
      shouldForwardToRemote(`failed_login:unique-subject-hash-${i}`, opts);
    }
    expect(samplerWindowCountForTests()).toBeLessThanOrEqual(HARD_CAP);
  });

  it("üst sınır/tahliye mantığı devrede olsa da normal örnekleme limitleri (maxPerWindow) doğru çalışmaya devam eder", () => {
    const opts = { windowMs: 60_000, maxPerWindow: 5 };
    let forwarded = 0;
    for (let i = 0; i < 20; i++) {
      if (shouldForwardToRemote("normal-key", opts)) forwarded++;
    }
    expect(forwarded).toBe(5);
  });
});
