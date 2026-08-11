import Link from "next/link";
import { CheckCircle2, Clock } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { getAddonPurchaseStatus } from "@/server/services/billing/addon-grant-service";
import { LIMIT_LABELS } from "@/lib/entitlements/entitlement-service";
import { isLimitId } from "@/lib/entitlements/capabilities";
import { formatNumber } from "@/lib/utils";
import { ReconcileAddonButton } from "@/components/app/reconcile-addon-button";

/**
 * YF-813 — add-on Checkout başarı dönüşü (YF-809/YF-810
 * `app/(app)/settings/plan/checkout/success/page.tsx` ile AYNI ilke).
 *
 * **Bu sayfanın kendisi hiçbir kota mutasyonu YAPMAZ.** Tarayıcının buraya
 * dönmesi yalnızca Stripe'ın ödeme adımının tamamlandığını gösterir — gerçek
 * bağış onayı burada YAPILMAZ. `getAddonPurchaseStatus` SALT OKUNUR bir DB
 * kontrolüdür (Stripe'a gitmez); bir bağış zaten webhook tarafından
 * işlenmişse "onaylandı" gösterilir, aksi halde "onay bekleniyor" durumu +
 * manuel "durumu şimdi kontrol et" seçeneği (`ReconcileAddonButton`)
 * sunulur — asla erken/yanlış bir "kota hazır" mesajı VERİLMEZ (bkz. görev
 * talimatı "must not claim quota is available unless webhook processing has
 * confirmed").
 */
export default async function AddonCheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const actor = await requireUser();
  const { session_id: sessionId } = await searchParams;

  const status = sessionId
    ? await getAddonPurchaseStatus(actor, sessionId).catch(() => ({ confirmed: false as const }))
    : { confirmed: false as const };

  return (
    <div className="mx-auto max-w-lg animate-fade-in space-y-4 py-12 text-center">
      {status.confirmed ? (
        <>
          <CheckCircle2 className="mx-auto h-10 w-10 text-success" aria-hidden="true" />
          <h1 className="font-display text-xl font-bold tracking-tight">Ek kota eklendi</h1>
          <p className="text-sm text-muted-foreground">
            {status.resource && isLimitId(status.resource)
              ? `${formatNumber(status.amount ?? 0)} ${LIMIT_LABELS[status.resource]} hesabınıza eklendi ve kullanıma hazır.`
              : "Satın aldığınız ek kota hesabınıza eklendi ve kullanıma hazır."}
          </p>
        </>
      ) : (
        <>
          <Clock className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden="true" />
          <h1 className="font-display text-xl font-bold tracking-tight">Ödeme adımı tamamlandı</h1>
          <p className="text-sm text-muted-foreground">
            Ödeme sağlayıcısındaki işleminiz alındı. Satın aldığınız ek kota, güvenlik nedeniyle yalnızca ödeme
            sağlayıcısından gelen kesin onay sonrasında hesabınıza eklenir — bu genellikle birkaç dakika içinde
            tamamlanır.
          </p>
          {sessionId && (
            <>
              <p className="text-sm text-muted-foreground">
                Beklemek istemiyorsanız durumu şimdi kontrol edebilirsiniz:
              </p>
              <ReconcileAddonButton checkoutSessionId={sessionId} />
            </>
          )}
        </>
      )}
      <p className="text-sm text-muted-foreground">
        Bir sorun olduğunu düşünüyorsanız lütfen destek ekibimizle iletişime geçin.
      </p>
      <Link
        href="/settings/plan/addons"
        className="inline-block rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Ek paketlere dön
      </Link>
    </div>
  );
}
