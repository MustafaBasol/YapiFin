# Güvenlik Başlıkları ve Health Endpoint

**Görev**: YF-511 — Production-safe güvenlik başlıkları ve health endpoint
**Branch**: `feature/yf-511-security-headers-health`
**Baseline**: `origin/main` @ `1c656c18b04b366200a3ef4a434432e0373d50e8`

Bu belge, `proxy.ts` ile eklenen güvenlik başlıklarını ve `GET /api/health`
endpoint'ini belgeler. Önceki durum (`docs/PRODUCTION_READINESS.md` R-6/R-7,
bu klasördeki `README.md`) her ikisinin de **eksik** olduğunu tespit etmişti;
bu görev ikisini de kapatır.

## Kapsam ve tasarım gerekçesi

Aşağıdaki başlıklar/CSP direktifleri, repodaki **gerçek** bağımlılıklara göre
türetildi (körlemesine "en katı" bir şablon uygulanmadı):

- `app/layout.tsx` → `next/font/google` (Hanken Grotesk, JetBrains Mono):
  build-time'da self-host edilir, çalışma zamanında `fonts.googleapis.com`
  gibi bir dışarı istek **yoktur** → `font-src` dış kaynak gerektirmez.
- `postcss.config.mjs` → Tailwind CSS derlenmiş statik CSS üretir; runtime'da
  inline `<style>` enjekte eden bir CSS-in-JS kütüphanesi yok. React'in inline
  `style={{...}}` attribute kullanımı (bkz. `components/app/*`) CSP nonce'u
  desteklemediği için `style-src` içinde `unsafe-inline` kabul edildi (yalnızca
  CSS, kod çalıştırmaz — Next.js'in resmi CSP rehberi de aynı örneği verir).
- `package.json` bağımlılıkları: harici analytics/tracking/CDN script'i,
  üçüncü taraf gömülü widget (reCAPTCHA vb.) yok. `next.config.ts`'de
  `images.remotePatterns` tanımlı değil → yalnızca yerel/aynı-origin görseller.
- `proxy.ts` yoktu, `next.config.ts`'de `headers()` yoktu (`docs/PRODUCTION_READINESS.md`
  §6 tablosu, satır R-6) — sıfırdan eklendi.

## Başlıklar (`proxy.ts`)

Tüm route'lara (statik `_next/static`, `_next/image`, `favicon.ico` hariç)
tek bir merkezi middleware'den uygulanır — `next.config.ts`'deki statik
`headers()` yerine middleware seçildi çünkü CSP nonce'u **istek başına**
üretilmelidir (bkz. aşağıdaki CSP bölümü); iki katmanı birden kullanmak aynı
header'ın iki kez gönderilmesine (bkz. "Proxy/CDN ile çakışma" bölümü) yol
açabilirdi.

| Header | Değer | Neden |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Tarayıcının `Content-Type` dışında MIME sniffing yapmasını engeller. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Cross-origin isteklerde tam URL (query string'de token/hassas parametre olabilir) yerine yalnızca origin gönderilir; same-origin'de tam referrer korunur (mevcut UX'i bozmaz). |
| `X-Frame-Options` | `DENY` | Clickjacking koruması; `frame-ancestors 'none'` (CSP) ile aynı amacı taşır, eski tarayıcı uyumluluğu için ek katman olarak tutulur. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()` | Uygulama bu tarayıcı API'lerinin hiçbirini kullanmaz; muhafazakâr bir allowlist (hepsi kapalı) ile üçüncü taraf bir XSS'in bu API'leri istismar etme yüzeyi kapatılır. `interest-cohort=()` FLoC/Topics izlemesini reddeder. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` — **yalnızca `NODE_ENV=production`** | Uygulama kendi TLS terminasyonunu yapmaz (bkz. [DEPLOYMENT_RUNBOOK.md — TLS/reverse proxy beklentisi](./DEPLOYMENT_RUNBOOK.md#tls--reverse-proxy-beklentisi)); production dağıtımının her zaman bir reverse proxy/CDN arkasında HTTPS ile yapılması varsayılır — bu varsayım `lib/env.ts`'in production'da `NEXT_PUBLIC_APP_URL` için `https://` zorunlu kılmasıyla (localhost istisnası hariç) tutarlıdır. Development/test'te düz HTTP kullanıldığından eklenmez (aksi halde tarayıcı yerel `http://localhost`'u bir süre sonra HTTPS'e yönlendirmeye zorlayabilir). |
| `Content-Security-Policy` | Aşağıya bakın | — |
| `X-Powered-By` | *(kaldırıldı)* | `next.config.ts` → `poweredByHeader: false`. Next.js sürüm bilgisini sızdıran varsayılan header devre dışı bırakıldı. |

## CSP stratejisi

```
default-src 'self';
script-src 'self' 'nonce-<istek-başına-rastgele>' 'strict-dynamic';   (+ 'unsafe-eval' yalnızca development)
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests;   (yalnızca production)
```

### Nonce tabanlı script-src

Next.js App Router, hydration/RSC verisini `<script>` etiketleri içinde
**inline** olarak sayfaya gömer. `script-src 'self'` tek başına bunu engeller
ve uygulamayı kırar; tek güvenli çözüm ya `unsafe-inline` (herhangi bir XSS'in
doğrudan script çalıştırmasına izin verir) ya da **istek başına rastgele bir
nonce**'dur. Bu görev nonce yaklaşımını seçti:

- `proxy.ts`, her istekte `crypto.randomUUID()` tabanlı yeni bir nonce
  üretir, `x-nonce` request header'ı olarak sunucu bileşenlerine iletir ve
  `Content-Security-Policy` response header'ına `'nonce-...'` olarak yazar.
- Next.js, middleware'in ürettiği bu nonce'u kendi enjekte ettiği hydration
  script'lerine otomatik uygular (resmi desteklenen mekanizma, bkz.
  [Next.js CSP rehberi](https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy)) — ayrıca kod değişikliği gerekmez.
  Uygulama ileride kendi `<Script>` etiketini eklerse, `headers().get('x-nonce')`
  ile aynı nonce'u okuyup `<Script nonce={nonce}>` şeklinde işaretlemelidir.
- `'strict-dynamic'` (yalnızca production), nonce'lu bir script'in dinamik
  olarak yüklediği alt script'lerin de güvenilmesini sağlar; eski tarayıcılar
  `strict-dynamic`'i desteklemezse `'self'`'e düşer (bozulma yok, yalnızca
  savunma derinliği azalır).
- Development'ta `'unsafe-eval'` eklenir çünkü Next.js dev sunucusu (Fast
  Refresh, webpack `eval` tabanlı source map) buna ihtiyaç duyar; production
  build'de **kullanılmaz**.

### style-src neden `unsafe-inline`

Tailwind statik CSS üretir, ama React'in inline `style={{...}}` attribute
kullanımı (dinamik grafik renkleri, progress bar genişlikleri vb. —
`components/app/dashboard-charts.tsx` gibi dosyalarda yaygın) CSP nonce
mekanizmasını **desteklemez** (nonce yalnızca `<style>`/`<script>`
etiketlerinde çalışır, attribute'larda çalışmaz). Bu nedenle `style-src`
için `unsafe-inline` kabul edildi — bu yalnızca CSS uygulamasına izin verir,
script çalıştırmaya izin vermez, dolayısıyla CSP'nin asıl amacı olan script
enjeksiyonu koruması bozulmaz. Next.js'in kendi resmi CSP örneği de Tailwind
kullanan projeler için aynı seçimi önerir.

### Neden geniş wildcard yok

`connect-src`, `img-src`, `font-src` yalnızca `'self'` (+ gerekli `data:`/`blob:`)
içerir çünkü depoda doğrulanmış hiçbir üçüncü taraf servis/CDN/analytics
entegrasyonu yok (bkz. yukarıdaki "Kapsam ve tasarım gerekçesi"). İleride
harici bir servis eklenirse (ör. bir ödeme sağlayıcı, harita, analytics),
ilgili domain **açıkça** bu listelere eklenmelidir — asla `*` veya
`https:` gibi geniş bir joker karakterle değil.

### Report-only geçiş valfi (opsiyonel)

`CSP_REPORT_ONLY=true` ortam değişkeni ayarlanırsa, middleware CSP'yi
`Content-Security-Policy` yerine `Content-Security-Policy-Report-Only`
olarak gönderir — tarayıcı ihlalleri **engellemez**, yalnızca konsola/`report-to`
uç noktasına bildirir. Bu görevdeki analiz (gerçek bağımlılıklara dayalı,
Next.js'in resmi nonce mekanizmasını kullanan) doğrudan enforce modunun güvenli
olduğunu gösterdiği için **varsayılan mod enforce'dur**; bu bayrak yalnızca
operatörün ilk production rollout'unda ekstra bir güvenlik ağı istemesi
durumunda kullanılmak üzere sağlanmıştır. Etkinleştirilirse, tarayıcı
konsolundaki `Content-Security-Policy-Report-Only` ihlal uyarıları izlenerek
gerçek trafikte kırılan bir şey olmadığı doğrulanmalı, ardından bayrak
kaldırılmalıdır.

## Proxy/CDN ile çakışma ve tekrarlanan header riski

Depoda bir reverse proxy/CDN yapılandırması **yoktur** (bkz. [DEPLOYMENT_RUNBOOK.md — TLS/reverse proxy beklentisi](./DEPLOYMENT_RUNBOOK.md#tls--reverse-proxy-beklentisi));
gerçek TLS sonlandırma ve muhtemelen bir reverse proxy (nginx/Caddy/CDN)
operatör tarafından eklenecektir. Bu proxy katmanı eklenirken dikkat edilmesi
gerekenler:

- **Aynı header'ı iki kez ekleme.** Eğer proxy seviyesinde de
  `Strict-Transport-Security`, `X-Frame-Options` veya `Content-Security-Policy`
  ekleniyorsa, bu genellikle tarayıcıda **birleştirilmiş/tekrarlanmış** bir
  header olarak görünür (`Access-Control-Allow-Origin` gibi bazı header'larda
  bu bir hataya yol açar; CSP'de birden fazla `Content-Security-Policy`
  header'ı **en kısıtlayıcı kesişimi** uygular — bu genelde istenmeyen bir
  şekilde uygulamayı kırabilir). Kural: **CSP tek bir katmanda** (bu görevde
  uygulama/middleware katmanında) yönetilmeli; proxy bu header'ı set etmemeli
  veya varsa mevcut middleware header'ını `proxy_hide_header`/`Header unset`
  benzeri bir yönergeyle geçersiz kılmamalı.
- **HSTS'i CDN'de de tekrarlamayın** — middleware zaten production'da ekliyor;
  CDN ayrıca ekliyorsa `max-age` değerlerinin çakışmadığından emin olun (ikisi
  aynıysa zararsızdır, farklıysa tarayıcı ilk gördüğü değeri değil, **birleşimi**
  değil, spesifikasyona göre genelde en son alınanı önbelleğe alabilir —
  belirsizlikten kaçınmak için tek katmanda tutulması önerilir).
- **`X-Forwarded-Proto`/`X-Forwarded-For`**: Bu görev, HSTS kararını
  `NODE_ENV` üzerinden verir (proxy header'larına güvenmez) çünkü
  `lib/rate-limit/client-ip.ts` zaten `TRUSTED_PROXY_COUNT` ile güvenilir
  proxy sayısını yapılandırılabilir kılıyor — health/header katmanı bu
  mekanizmayı **tekrar kullanmaz**, daha basit ve proxy yapılandırmasından
  bağımsız bir varsayıma (production = her zaman HTTPS arkasında) dayanır.

## Health endpoint

### `GET /api/health`

- **Kimlik doğrulama**: Yok — kamuya açık altyapı prob'ları (load balancer,
  orchestrator, uptime checker) için güvenli olacak şekilde tasarlandı, tenant
  verisine dokunmaz.
- **Kontrol edilen şey**: `SELECT 1` ile PostgreSQL bağlantısı
  (`lib/health/db-check.ts`). Uygulama-tarafı tek bağımlılık DB olduğu için
  ayrı bir liveness/readiness endpoint çifti (Kubernetes tarzı) bu depoda
  gerekçelendirilemedi — mevcut dağıtım modeli tek `next start` süreci,
  orkestrasyon katmanı yok (bkz. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md)). Süreç zaten yanıt
  verebiliyorsa liveness zaten sağlanmış demektir; bu nedenle tek endpoint
  hem liveness hem readiness sinyali verir.
- **Zaman aşımı**: 2000ms. Tek bir yavaş/asılı DB bağlantısı probe'u süresiz
  bekletmez — `lib/rate-limit/redis-client.ts`'teki aynı gerekçe (kısa,
  sınırlı zaman aşımı; kesintiyi hızlıca `false`/`503`'e çevir).
- **Önbellek**: Sonuç 1000ms boyunca process-içi önbelleğe alınır — sık
  probe'layan izleme araçlarının her seferinde gerçek bir DB sorgusu
  tetiklemesini önler (bkz. `tests/health.test.ts` — "ardışık probe'lar...
  tek DB sorgusu üretir").
- **Yanıt gövdesi**: Yalnızca `{"status":"ok"}` veya `{"status":"error"}`.
  Ortam değişkeni, sürüm, hostname, SQL hata mesajı, stack trace veya tenant
  verisi **asla** döndürülmez veya loglanmaz.
- **Durum kodları**: `200` (DB erişilebilir) / `503 Service Unavailable`
  (DB erişilemiyor veya zaman aşımına uğradı).
- **Önbellekleme**: `Cache-Control: no-store` — ara proxy/CDN katmanlarının
  bayat bir health sonucunu önbelleğe almasını engeller.

### Doğrulama örnekleri

```bash
curl -i http://localhost:3000/api/health
```

Beklenen (sağlıklı):

```
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json

{"status":"ok"}
```

DB erişilemezken:

```
HTTP/1.1 503 Service Unavailable
Cache-Control: no-store
Content-Type: application/json

{"status":"error"}
```

### Docker / load balancer / reverse proxy probe örnekleri

**Docker (Dockerfile veya `docker run --health-cmd`):**

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- --tries=1 http://localhost:3000/api/health | grep -q '"status":"ok"' || exit 1
```

**nginx (upstream health, açık kaynak nginx'te pasif; aktif health check için `nginx-plus`/`ingress-nginx` gibi bir eklenti gerekir):**

```nginx
location = /api/health {
    proxy_pass http://app_upstream;
    access_log off;
}
```

**Genel load balancer / uptime checker yapılandırması:**

- Path: `/api/health`
- Beklenen durum kodu: `200`
- Zaman aşımı: ≥ 3s (uygulama içi 2s DB zaman aşımına, ağ gecikmesi için pay bırakır)
- Aralık: 15–30s (1000ms'lik iç önbellek zaten çok sık probe'ları sindirir)
- **Warning**: 1 ardışık başarısızlık; **Critical**: 3 ardışık başarısızlık veya 5 dakika kesinti (bkz. [MONITORING_RUNBOOK.md §1](./MONITORING_RUNBOOK.md#1-http-availability))

## Güvenli production doğrulaması

Deploy sonrası, hiçbir mutasyon içermeyen aşağıdaki kontroller yapılabilir:

```bash
curl -sI https://<production-domain>/dashboard | grep -Ei 'strict-transport-security|x-content-type-options|x-frame-options|content-security-policy|referrer-policy|permissions-policy|x-powered-by'
```

- `x-powered-by` satırı **görünmemeli**.
- `strict-transport-security` yalnızca gerçek production'da (HTTPS arkasında) görünmeli.
- `content-security-policy` satırında her istekte farklı bir `nonce-...` değeri olmalı (iki ardışık `curl` karşılaştırılarak doğrulanabilir).

```bash
curl -i https://<production-domain>/api/health
```

- `200`/`{"status":"ok"}` bekleniyor; DB kasıtlı olarak durdurulmadan bu uç
  nokta üzerinde **yıkıcı bir test yapılmamalıdır** (bu görev kapsamında da
  yapılmadı — yalnızca mock'lanmış birim testlerle doğrulandı, bkz.
  `tests/health.test.ts`).

## Bilinen sınırlamalar / takip

- Nonce mekanizması Next.js'in App Router hydration script'lerini kapsar;
  uygulama ileride harici bir `<script src="...">` (ör. bir ödeme SDK'sı)
  eklerse, hem `script-src`'e ilgili domain hem de nonce eklenmelidir.
- `CSP_REPORT_ONLY` yalnızca manuel bir ops bayrağıdır; bir `report-uri`/`report-to`
  toplama uç noktası bu görev kapsamında **eklenmedi** (raporlar yalnızca
  tarayıcı konsoluna düşer) — merkezi bir CSP ihlal toplama servisi ayrı bir
  görev olarak değerlendirilebilir.
- `/api/health` tek bir DB kontrolü yapar; Redis (rate limiting) veya SMTP
  erişilebilirliği health yanıtına dahil **edilmedi** (bilinçli tercih —
  bunlar `lib/rate-limit/policy.ts`'nin fail-open tasarımı gereği zaten
  kesintiye dayanıklı; health endpoint'ini bunlara bağımlı kılmak yanlış
  pozitif "unhealthy" durumlarına yol açabilirdi).
