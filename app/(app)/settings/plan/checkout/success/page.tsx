import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { ReconcileBillingButton } from "@/components/app/reconcile-billing-button";

/**
 * YF-809/YF-810 — Stripe Checkout başarı dönüşü.
 *
 * **Bu sayfanın kendisi hiçbir plan/entitlement mutasyonu YAPMAZ.** Tarayıcının
 * buraya dönmesi yalnızca kullanıcının Stripe'ın ödeme adımını tamamladığını
 * gösterir — abonelik/ödeme doğrulaması burada YAPILMAZ. Gerçek aktivasyon
 * her zaman sunucu tarafında, YF-810 webhook senkronizasyonu (veya aşağıdaki
 * "Durumu şimdi kontrol et" butonu — o da yalnızca Stripe'ı SORAR, hiçbir
 * şeyi doğrudan KAZANDIRMAZ, bkz. app/actions/billing.ts
 * `reconcileBillingAction`) tamamlandığında gerçekleşir (bkz.
 * server/services/billing/checkout-service.ts dosya başı not).
 */
export default async function CheckoutSuccessPage() {
  await requireUser();

  return (
    <div className="mx-auto max-w-lg animate-fade-in space-y-4 py-12 text-center">
      <CheckCircle2 className="mx-auto h-10 w-10 text-success" aria-hidden="true" />
      <h1 className="font-display text-xl font-bold tracking-tight">Ödeme adımı tamamlandı</h1>
      <p className="text-sm text-muted-foreground">
        Ödeme sağlayıcısındaki işleminiz alındı. Aboneliğiniz, güvenlik nedeniyle yalnızca ödeme sağlayıcısından
        gelen kesin onay sonrasında etkinleştirilir — bu genellikle birkaç dakika içinde tamamlanır. Mevcut
        planınız ve kullanım haklarınız bu onaya kadar DEĞİŞMEZ.
      </p>
      <p className="text-sm text-muted-foreground">
        Beklemek istemiyorsanız durumu şimdi kontrol edebilirsiniz:
      </p>
      <ReconcileBillingButton />
      <p className="text-sm text-muted-foreground">
        Bir sorun olduğunu düşünüyorsanız lütfen destek ekibimizle iletişime geçin.
      </p>
      <Link
        href="/settings/plan"
        className="inline-block rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Plan sayfasına dön
      </Link>
    </div>
  );
}
