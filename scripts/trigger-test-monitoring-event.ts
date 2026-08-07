/**
 * YF-512 — Monitoring entegrasyonunun uçtan uca çalıştığını doğrulamak için
 * geliştiricinin ELLE çalıştırdığı, kontrollü bir araç.
 *
 * Bu BİR HTTP UÇ NOKTASI DEĞİLDİR — hiçbir sunucu açmaz, dışarıdan
 * tetiklenemez ve production'da çalışmayı REDDEDER (fail-closed). Görev
 * talimatındaki "unauthenticated public error-trigger endpoint OLUŞTURMA"
 * kısıtını bu şekilde karşılar.
 *
 * Kullanım:
 *   npm run monitoring:test-event
 *   # veya gerçek bir Sentry projesine karşı uçtan uca doğrulamak için:
 *   SENTRY_DSN="https://...@.../..." npm run monitoring:test-event
 *
 * SENTRY_DSN tanımlı değilse yalnızca no-op adapter'ın (hiçbir ağ çağrısı
 * yapmadan) beklendiği gibi çalıştığını doğrular — bu da "devre dışı"
 * durumunun kendisinin güvenli olduğunun bir kanıtıdır.
 */
import {
  initMonitoring,
  captureException,
  captureSecurityEvent,
  flushMonitoring,
} from "../lib/monitoring";

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error(
      "[trigger-test-monitoring-event] REDDEDİLDİ: bu script production'da çalıştırılamaz (yalnızca development/test).",
    );
    process.exit(1);
  }

  initMonitoring();
  const dsnConfigured = Boolean(process.env.SENTRY_DSN);
  console.log(`[trigger-test-monitoring-event] SENTRY_DSN yapılandırılmış mı: ${dsnConfigured}`);
  console.log(
    dsnConfigured
      ? "[trigger-test-monitoring-event] Gerçek Sentry adapter'ı kullanılacak — bu bir GERÇEK test olayı gönderecektir."
      : "[trigger-test-monitoring-event] DSN yok — no-op adapter kullanılacak, hiçbir ağ çağrısı yapılmayacak.",
  );

  captureException(
    new Error("YF-512 kontrollü test hatası — bu KONTROLLÜ/BEKLENEN bir olaydır, gerçek bir arıza değildir."),
    { tags: { source: "trigger-test-monitoring-event-script" } },
  );

  captureSecurityEvent({
    type: "rate_limit",
    result: "blocked",
    subjectHash: "controlled-test-subject-hash",
    meta: { policy: "controlled-test", source: "memory-fallback" },
    forward: true,
  });

  const flushed = await flushMonitoring(5000);
  console.log(`[trigger-test-monitoring-event] Tamamlandı. flush başarılı mı: ${flushed}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[trigger-test-monitoring-event] Beklenmeyen hata:", err instanceof Error ? err.message : err);
  process.exit(1);
});
