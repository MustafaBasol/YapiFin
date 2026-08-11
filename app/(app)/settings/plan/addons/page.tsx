import Link from "next/link";
import { requireRole } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { getOrganizationLimitSummary } from "@/lib/entitlements/entitlement-service";
import { ADDON_CATALOG } from "@/lib/billing/addon-catalog";
import { AddonPurchaseView } from "@/components/app/addon-purchase-view";

export default async function AddonPurchasePage() {
  const actor = await requireRole(["OWNER", "ADMIN"]);
  const limits = await getOrganizationLimitSummary(db, actor.organizationId);

  return (
    <div className="mx-auto max-w-[900px] animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Ek Kullanım Paketleri</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Aylık dahil kotanız yetmediğinde, mevcut dönem için ek yapay zekâ kredisi veya OCR belge kotası satın
          alın. Dahil plan kotanız bu satın almadan ETKİLENMEZ — yalnızca üzerine eklenir.
        </p>
      </div>
      <AddonPurchaseView catalog={ADDON_CATALOG} limits={limits} canPurchase={actor.role === "OWNER"} />
      <p className="text-sm text-muted-foreground">
        <Link href="/settings/plan" className="font-medium text-primary hover:underline">
          Plan ve fiyatlandırma sayfasına dön
        </Link>
      </p>
    </div>
  );
}
