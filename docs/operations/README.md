# Production Operations — İndeks

**Görev**: YF-513 — Production Deployment, Monitoring, Backup, Restore ve Rollback Runbook'ları
**Branch**: `docs/yf-513-production-operations-runbooks`
**Baseline**: `origin/main` @ `d75aeb974262ed1e9542f2db5334e1d135fe428e`

Bu klasör, YapiFin'in production ortamında çalıştırılması için gereken operasyonel prosedürleri içerir. Bu belgeler **read-only teknik inceleme** sonucunda hazırlanmıştır; repository'de fiilen var olmayan bir altyapıyı (ör. Docker imajı, health endpoint, otomatik backup) mevcutmuş gibi anlatmaz. Her belgede aşağıdaki dört kategori açıkça ayrılır:

| Etiket | Anlamı |
|---|---|
| ✅ **Mevcut ve doğrulanmış** | Repository'de kod/konfigürasyon olarak fiilen var, dosya yolu ve satırla doğrulanabilir. |
| ❌ **Eksik veya henüz uygulanmamış** | Repository'de karşılığı yok; bir sonraki görev olarak planlanmalı. |
| 💡 **Önerilen production standardı** | Sektör pratiği/best practice önerisi; repository'de henüz uygulanmamış, bilinçli bir öneri olarak işaretlenmiştir. |
| 🔧 **Operatör tarafından doldurulacak değer** | Ortam/gerçek hostname/secret/onay gerektiren, bu dokümanın dolduramayacağı alan. |

## Kapsam ve temel referans dokümanlar

Bu runbook seti, mevcut `docs/PRODUCTION_READINESS.md` dosyasının yerini almaz — onu tekrarlamaz, tamamlar. Ayrıntılı geçmiş bulgular (env/SMTP sertleştirme, bağımlılık yükseltmeleri, risk kaydı R-1..R-10) için `docs/PRODUCTION_READINESS.md` kaynak doğrudur. Mimari/güvenlik arka planı için: `docs/ARCHITECTURE.md`, `docs/SECURITY.md`.

## Doğrulanmış mevcut durum — özet

- **Deployment modeli**: Tek `next start` süreci (standalone build yok), tek PostgreSQL 16 (docker-compose sadece dev/CI amaçlı). **Uygulama için production Dockerfile/imaj yok.**
- **Env doğrulama**: `lib/env.ts` + `instrumentation.ts` üzerinden başlangıçta fail-closed doğrulama (bkz. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md#gerekli-ortam-değişkenleri)).
- **Migration**: Prisma, `prisma migrate deploy` (production-safe, aşağı yönlü otomatik geri alma yok).
- **Health/readiness endpoint**: ✅ `GET /api/health` (YF-511). (bkz. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md#healthreadiness-doğrulaması), [SECURITY_HEADERS.md](./SECURITY_HEADERS.md#health-endpoint))
- **Güvenlik başlıkları (CSP/HSTS/vb.)**: ✅ `proxy.ts` (YF-511). (bkz. [SECURITY_HEADERS.md](./SECURITY_HEADERS.md))
- **Backup/restore otomasyonu**: **Yok**, restore hiç test edilmemiş (`docs/PRODUCTION_READINESS.md` R-5). Bu runbook seti ilk kez uçtan uca bir prosedür tanımlıyor — bkz. [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md).
- **CI**: Tek workflow (`.github/workflows/ci.yml`) — lint/typecheck/test/build; **deploy adımı yok**.
- **Monitoring/APM**: Yok (`docs/PRODUCTION_READINESS.md` R-8).

## Belgeler

1. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md) — Production'a dağıtım adımları, ön koşullar, health/smoke doğrulaması.
2. [MONITORING_RUNBOOK.md](./MONITORING_RUNBOOK.md) — İzlenmesi gereken sinyaller, önerilen eşikler, ilk müdahale.
3. [BACKUP_RESTORE_RUNBOOK.md](./BACKUP_RESTORE_RUNBOOK.md) — Yedekleme, doğrulama, restore prosedürü.
4. [ROLLBACK_RUNBOOK.md](./ROLLBACK_RUNBOOK.md) — Başarısız deploy sonrası geri alma senaryoları.
5. [INCIDENT_RESPONSE_RUNBOOK.md](./INCIDENT_RESPONSE_RUNBOOK.md) — Olay türüne göre ilk müdahale akışları.
6. [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) — Deploy sonrası non-destructive smoke test kontrol listesi.
7. [SECURITY_HEADERS.md](./SECURITY_HEADERS.md) — Güvenlik başlıkları (CSP dahil), health endpoint semantiği, proxy/CDN etkileşimi (YF-511).

## Bu runbook setinin kapsamadığı işler (takip görevleri)

Bu görev dokümantasyon odaklıdır; aşağıdaki eksik altyapı parçaları **uygulanmamıştır**, yalnızca ilgili runbook'ta 💡 önerisi olarak işaretlenmiştir. Somut takip görevleri için her runbook'un "Bilinen eksikler" bölümüne ve bu klasördeki dosyaların sonundaki özet tabloya bakın.
