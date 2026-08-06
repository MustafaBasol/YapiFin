import { describe, it, expect } from "vitest";
import { resolveClientIp } from "@/lib/rate-limit/client-ip";

describe("resolveClientIp (güvenilir proxy tabanlı X-Forwarded-For çözümlemesi)", () => {
  it("trustedProxyCount=0 iken X-Forwarded-For'a hiç güvenmez (doğrudan internete açık dağıtım)", () => {
    expect(resolveClientIp("203.0.113.5", 0)).toBeNull();
    expect(resolveClientIp("1.2.3.4, 10.0.0.1", 0)).toBeNull();
  });

  it("header yoksa null döner", () => {
    expect(resolveClientIp(null, 1)).toBeNull();
  });

  it("tek güvenilir proxy: client, proxy sırasında sondan bir önceki değeri alır", () => {
    // Format: client, proxy1 — proxy1 bizim altyapımız, gerçek istemci solda.
    expect(resolveClientIp("198.51.100.7, 10.0.0.1", 1)).toBe("198.51.100.7");
  });

  it("iki güvenilir proxy: sondan ikinci değeri alır", () => {
    expect(resolveClientIp("198.51.100.7, 10.0.0.5, 10.0.0.1", 2)).toBe("198.51.100.7");
  });

  it("saldırgan sahte hop'lar eklese bile yalnızca güvenilen proxy sayısı kadar sondan sayılır", () => {
    // Saldırgan "gerçek" IP'sinin önüne istediği kadar sahte IP ekleyebilir
    // (soldaki her şey); bunlar her zaman göz ardı edilir, yalnızca sondan
    // trustedProxyCount kadarı (bizim eklediğimiz hoplar) atlanır.
    const spoofed = "1.1.1.1, 2.2.2.2, 3.3.3.3, real-attacker-ip, 10.0.0.1";
    expect(resolveClientIp(spoofed, 1)).toBe("real-attacker-ip");
  });

  it("hop sayısı trustedProxyCount'tan az/eşitse belirsiz kabul edilir (null)", () => {
    // Yalnızca 1 hop var ama 2 güvenilir proxy bekleniyor — yanlış
    // yapılandırma ya da manipülasyon şüphesi; soldaki değeri körlemesine
    // kabul etmek yerine null döner.
    expect(resolveClientIp("198.51.100.7", 2)).toBeNull();
    expect(resolveClientIp("198.51.100.7, 10.0.0.1", 2)).toBeNull();
  });

  it("boşluklu/virgüllü girdileri doğru şekilde ayrıştırır", () => {
    expect(resolveClientIp("  198.51.100.7  ,  10.0.0.1  ", 1)).toBe("198.51.100.7");
  });
});
