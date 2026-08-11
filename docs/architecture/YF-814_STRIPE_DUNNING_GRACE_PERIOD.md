# YF-814 — Stripe Dunning, Ödeme Gecikmesi Grace Period ve Faturalama Kurtarma

> Bu doküman, YF-810 (Stripe Abonelik Yaşam Döngüsü) üzerine inşa edilen
> `PAST_DUE` (başarısız/gecikmiş ödeme) durumu için ürün-politikası bazlı
> grace period ve erişim kısıtlama davranışını belgeler. YF-815 (iade/
> uyuşmazlık) ile AYNI kompozisyon disiplinini kullanır — ikisi de
> `lib/billing/billing-restriction-policy.ts` altında birleşir.

## 1. Değişmez mimari sözleşme (YF-808/YF-809/YF-810 ile AYNI)

- Stripe yalnızca ödeme/faturalama **gerçeğinin** kaynağıdır. Grace süresi
  UZUNLUĞU gibi ürün politikası kararları YapiFin'e aittir
  (`lib/billing/dunning-policy.ts` `GRACE_PERIOD_DURATION_DAYS`).
- Bu görev `Organization.planId`'ye YENİ bir mutasyon noktası EKLEMEZ — YF-810
  ile AYNI, TEK yer (`webhook-service.ts`) hâlâ geçerlidir. Dunning yalnızca
  `OrganizationStripeSubscription.delinquentSince`/`gracePeriodEndsAt`/
  `recoveredAt` alanlarını ve ücretli kaynak OLUŞTURMA çağrı noktalarındaki
  bir kısıtlama KARARINI etkiler — `Organization.planId`'ye ASLA dokunmaz.

## 2. Katmanlar ve dosyalar

| Katman | Dosya | Sorumluluk |
|---|---|---|
| Saf politika | `lib/billing/dunning-policy.ts` | Grace süresi sabiti, `computePaymentFailureState`, `openDunningEpisode`/`clearDunningEpisode` (saf, test edilebilir), `hasActiveDunningRestriction` |
| Kompozisyon | `lib/billing/billing-restriction-policy.ts` | `assertNotBillingRestricted`/`hasActiveBillingRestriction` — dunning + dispute (YF-815) sinyallerini BİRLEŞTİRİR |
| Domain servisi | `server/services/billing/webhook-service.ts` `reconcileDunningState` | `syncSubscriptionFromStripe`in HER çağrısının SONUNDA, refetch edilen `status`a göre bölüm açar/kapatır |
| Okuma servisi | `server/services/billing/billing-health-service.ts` | UI için tenant-scoped, salt-okunur faturalama sağlığı özeti |
| Portal CTA | `lib/billing/stripe-gateway.ts` `createBillingPortalSession`, `server/services/billing/billing-portal-service.ts` | YF-811'in minimal ön-koşulu — Stripe barındırmalı Faturalama Portalına yönlendirme |
| UI | `components/app/billing-dunning-banner.tsx`, `app/(app)/settings/plan/page.tsx` | Sağlıklı/uyarı/kısıtlı/kurtarıldı durumları + CTA |
| Şema | `prisma/schema.prisma`, migration `20260811202011_yf814_dunning_grace_period` | `OrganizationStripeSubscription`e 3 nullable `DateTime` kolonu |

**Yeni tablo YOK** — mevcut `OrganizationStripeSubscription` (organizationId
PK) genişletildi; ayrı bir "delinquency episode" geçmiş tablosu bu görev
kapsamında GEREKMEDİ (YF-810'un `OrganizationCheckoutAttempt`/webhook olay
defteri ile AYNI "gerekmeyeni İCAT ETME" ilkesi).

## 3. Ele alınan Stripe olayları

Bu görev YENİ bir olay türü EKLEMEZ — YF-810'un ZATEN ele aldığı
`invoice.payment_succeeded`/`invoice.payment_failed`/`customer.subscription.*`
olaylarının, `syncSubscriptionFromStripe`in refetch-on-write sonucunda ortaya
çıkan `PAST_DUE` durumunu YF-810'da NÖTR bırakılan boşluğu doldurur (bkz.
YF-810 dokümanı §7 — "past_due → NÖTR, mevcut plan KORUNUR" ifadesi HÂLÂ
DOĞRUdur, dunning bunun ÜZERİNE, `Organization.planId`'den BAĞIMSIZ ikinci
bir kısıtlama katmanı ekler).

## 4. Grace period politikası — durum makinesi

`lib/billing/dunning-policy.ts` `computePaymentFailureState`, İKİ mutlak
zaman damgasından SAF olarak hesaplanır (üçüncü bir denormalize "durum"
alanı İCAT EDİLMEZ — `lib/billing/dispute-policy.ts`'in `riskState`
felsefesiyle AYNI):

```
delinquentSince = null            → NONE (sağlıklı)
now < gracePeriodEndsAt           → GRACE_PERIOD (erişim TAM, uyarı gösterilir)
now >= gracePeriodEndsAt          → RESTRICTED (yeni ücretli kaynak ENGELLENİR)
```

**Varsayılan grace süresi: 7 gün** (`GRACE_PERIOD_DURATION_DAYS`) — mevcut
bir iş kuralı bulunmadığından seçilen, tek yerde tanımlı, açıkça
işaretlenmiş bir ürün politikası sabitidir. Değiştirilmesi gerekirse TEK
değişiklik noktası budur.

### Yakınsama kuralı — TEK karar noktası

`webhook-service.ts` `reconcileDunningState`, `syncSubscriptionFromStripe`in
HER çağrısının (webhook VEYA mutabakat, hangi olay/tetikleyici olursa olsun)
SONUNDA, o çağrının YENİDEN ÇEKTİĞİ `status`a göre çalışır:

- `status === PAST_DUE` ve açık bir bölüm YOKSA → **yeni bölüm açılır**
  (`delinquentSince = olay zaman damgası`, `gracePeriodEndsAt = delinquentSince + 7 gün`).
  ZATEN açık bir bölüm varsa İDEMPOTENT no-op — grace süresi ASLA UZATILMAZ
  (görev talimatı "repeated failures must not keep extending grace forever").
- `status` bir GRANT (`ACTIVE`/`TRIALING`) ise → açık bölüm varsa
  **kapatılır** (`recoveredAt` damgalanır).
- `status` bir REVOKE (`CANCELED`/`UNPAID`/`INCOMPLETE_EXPIRED`/`PAUSED`/`UNKNOWN`)
  ise → açık bölüm varsa **kapatılır** (erişim zaten `NO_PLAN` ile TAM
  kapalıdır — dunning bunu SÜPÜRMEZ, yalnızca UI/audit netliği içindir).
- `INCOMPLETE` (ilk ödeme öncesi, YF-809 checkout akışı) bilinçli olarak
  DOKUNULMAZ.

**Bu tasarımın kilit özelliği:** dunning kararı invoice olayının KENDİ
`FAILED`/`SUCCEEDED` etiketine DEĞİL, o an YENİDEN ÇEKİLEN abonelik
`status`una dayanır (YF-810'un "refetch-on-write" stratejisiyle AYNI). Bu,
sıra-dışı/geç teslim edilen bir `invoice.payment_failed` olayının, KURTARMA
SONRASI (Stripe artık `active` döndüğü için) yanlışlıkla yeniden
kısıtlama ÜRETEMEMESİNİ yapısal olarak garanti eder — event-zaman damgası
karşılaştırması gibi ayrı bir sıralama mekanizması İCAT EDİLMEDİ.

## 5. Erişim kısıtlama kompozisyonu (YF-814 + YF-815)

`lib/billing/billing-restriction-policy.ts` — YF-815'in `assertNotBillingRestricted`'inin
ARTIK dışa açıldığı TEK yer. Dunning ve dispute BAĞIMSIZ sinyallerdir;
İKİSİNDEN HERHANGİ biri kısıtlıyorsa organizasyon kısıtlıdır (biri diğerini
ASLA zayıflatmaz):

| Dunning | Dispute | Sonuç |
|---|---|---|
| RESTRICTED | herhangi | Kısıtlı |
| GRACE_PERIOD/NONE | RESTRICTED | Kısıtlı |
| GRACE_PERIOD/NONE | temiz | Kısıtlı DEĞİL |

Çağrı noktaları YF-815'ten DEĞİŞMEDİ (yalnızca import kaynağı
`lib/billing/dispute-policy.ts` → `lib/billing/billing-restriction-policy.ts`
oldu):

- `server/services/project-service.ts` `createProject`
- `server/services/invitation-service.ts` `acceptInvitation`
- `server/services/document-extraction-service.ts` `uploadAndExtractDocument`
- `server/services/bank-import-service.ts` (banka içe aktarım başlatma)

Salt-okunur yollar (`checkCapability`/`checkLimit`) ETKİLENMEZ — mevcut
veri/rapor erişimi grace süresi dolsa DAHİ TAM korunur.

## 6. Mutabakat (reconciliation) — kaçırılmış webhook kurtarma

`reconcileOrganizationStripeSubscription` (YF-810, DEĞİŞTİRİLMEDİ) zaten
`syncSubscriptionFromStripe`i çağırır — bu da artık `reconcileDunningState`i
İÇERİR. Sonuç: `invoice.payment_failed` webhook'u TAMAMEN kaçırılmış olsa
BİLE, bir SONRAKİ manuel mutabakat (veya HERHANGİ bir sonraki webhook — ör.
`customer.subscription.updated`) Stripe'ın `past_due` döndüğünü GÖRÜR ve
grace bölümünü geriye dönük olarak (mutabakat ANINDAN itibaren tam 7 gün)
açar. Ayrı bir cron/zamanlanmış süpürme İCAT EDİLMEDİ — YF-810 ile AYNI,
yalnızca OWNER-tetiklemeli manuel mutabakat deseni.

## 7. Finansal sınır

Dunning yaşam döngüsünün (başarısızlık → grace → kısıtlama → kurtarma) HİÇBİR
adımı `FinancialTransaction`/`Settlement`/proje bütçe kaydı OLUŞTURMAZ —
YF-810 §8 ile AYNI sınır, testlerle KANITLANMIŞTIR
(`tests/billing-dunning.test.ts` "finansal sınır").

## 8. Faturalama portalı CTA (YF-811 ön-koşulu)

YF-811 (tam Customer Portal) bu görevde İNŞA EDİLMEDİ. `lib/billing/stripe-gateway.ts`
`createBillingPortalSession` + `server/services/billing/billing-portal-service.ts`,
"ödeme yöntemini güncelle" CTA'sı için minimal, güvenli bir Stripe
barındırmalı Faturalama Portalı yönlendirmesi sağlar (tek Stripe API çağrısı,
ikinci bir portal mimarisi İCAT EDİLMEDİ). YF-811, kendi kapsamını
(yapılandırma yönetimi, dahili portal ekranları) bu TEK gateway metodunun
ÜZERİNE inşa edebilir.

## 9. Bildirim/olay sınırı

Özel bir e-posta/bildirim platformu bu görevde İNŞA EDİLMEDİ (mevcut
`lib/email/mailer.ts` altyapısına entegrasyon SONRAKİ görev sınırıdır).
Bunun yerine `billing.dunning.grace_started`/`billing.dunning.recovered`
audit log olayları (YF-810'un `billing.subscription.entitlement_granted`/
`_revoked` İLE AYNI desen), yalnızca GERÇEK bir durum GEÇİŞİNDE (idempotent,
replay'de mükerrer ÜRETİLMEZ) yazılır — bu, bir e-posta/bildirim
entegrasyonunun tüketebileceği TEK doğruluk kaynağıdır.

## 10. Eşzamanlılık — deadlock kurtarma

`syncSubscriptionFromStripe`, AYNI organizasyon için eşzamanlı İKİ çağrının
(`lockOrganizationForEntitlement` satır kilidi + ARDINDAN
`organizationStripeSubscription` satır yazması — iki farklı kaynak üzerinde
iki satır kilidi) nadiren gerçek bir PostgreSQL deadlock'u (`40P01`)
tetikleyebildiği test edilerek KANITLANDI (bkz. `tests/billing-dunning.test.ts`
"eşzamanlı mükerrer teslimat"). Bu YF-814'e ÖZGÜ DEĞİLDİR — herhangi İKİ
eşzamanlı webhook/mutabakat çağrısı AYNI riski taşır. Düzeltme
`checkout-service.ts`in ZATEN kanıtlanmış `isTransientLockConflict`/
`withLockConflictRetry` desenini `webhook-service.ts` içinde YENİDEN
uygular (kasıtlı olarak paylaşılan bir modüle ÇIKARILMADI — kapsam dışı bir
refactor olurdu).
