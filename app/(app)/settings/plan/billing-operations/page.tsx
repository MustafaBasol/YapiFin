import Link from "next/link";
import { requireRole } from "@/lib/auth/guard";
import { listOrganizationBillingOperations } from "@/server/services/billing/billing-operations-service";
import { BillingOperationsView } from "@/components/app/billing-operations-view";

/**
 * YF-815 — iade/uyuşmazlık (chargeback) operasyonel görünürlüğü. Görev
 * talimatı madde 9: "belongs to future Platform Admin tasks -> implement
 * backend/service layer now, smallest appropriate tenant-visible UI" —
 * bu sayfa yalnızca ÇAĞIRANIN KENDİ organizasyonunu gösterir (bkz.
 * `listOrganizationBillingOperations` — organizationId HER ZAMAN `actor`dan
 * türetilir), tam platform-genel bir admin paneli İCAT EDİLMEZ.
 */
export default async function BillingOperationsPage() {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const { refunds, disputes } = await listOrganizationBillingOperations(actor);

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">İade ve Ödeme İtirazları</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Organizasyonunuzun Stripe faturalama hesabındaki iade ve ödeme itirazı (chargeback) geçmişi. Bu kayıtlar
          yalnızca platform aboneliği/ek paket faturalamasını kapsar — proje gelir/gider kayıtlarınızı ETKİLEMEZ.
        </p>
      </div>
      <BillingOperationsView refunds={refunds} disputes={disputes} canReconcile={actor.role === "OWNER"} />
      <p className="text-sm text-muted-foreground">
        <Link href="/settings/plan" className="font-medium text-primary hover:underline">
          Plan ve fiyatlandırma sayfasına dön
        </Link>
      </p>
    </div>
  );
}
