"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { formatNumber } from "@/lib/utils";
import { purchaseAddonAction } from "@/app/actions/billing";
import { initialActionState } from "@/lib/action-state";
import { FormAlert } from "@/components/auth/field-error";
import { LIMIT_LABELS, type LimitCheckResult } from "@/lib/entitlements/entitlement-service";
import type { LimitId } from "@/lib/entitlements/capabilities";
import type { AddonCatalogEntry } from "@/lib/billing/addon-catalog";

/**
 * YF-813 — ek kullanım/kota (add-on/top-up) paketlerini listeleyen ve satın
 * alma akışını başlatan ince bir form/CTA tüketicisi. `plan-comparison-view.tsx`
 * (YF-805/YF-809) ile AYNI desen: fiyat/miktar/yetki kararı BURADA VERİLMEZ —
 * yalnızca sunucu tarafında zaten çözülmüş kataloğu (bkz.
 * lib/billing/addon-catalog.ts) ve GÜNCEL dahil/ek kota durumunu
 * (`lib/entitlements/entitlement-service.ts` `getOrganizationLimitSummary`)
 * gösterir.
 */
export function AddonPurchaseView({
  catalog,
  limits,
  canPurchase,
}: {
  catalog: readonly AddonCatalogEntry[];
  limits: Record<LimitId, LimitCheckResult>;
  canPurchase: boolean;
}) {
  return (
    <section aria-label="Ek paket kartları" className="grid gap-4 sm:grid-cols-2">
      {catalog.map((entry) => (
        <AddonCard key={entry.addonKey} entry={entry} limit={limits[entry.resource]} canPurchase={canPurchase} />
      ))}
    </section>
  );
}

function AddonCard({
  entry,
  limit,
  canPurchase,
}: {
  entry: AddonCatalogEntry;
  limit: LimitCheckResult;
  canPurchase: boolean;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-border bg-card p-5 shadow-soft">
      <h2 className="font-display text-lg font-bold tracking-tight">{entry.displayName}</h2>
      <p className="mt-2 min-h-10 text-sm text-muted-foreground">{entry.description}</p>

      <dl className="mt-4 space-y-2.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Dahil plan kotası</dt>
          <dd className="font-medium">{limit.includedMax === null ? "Sınırsız" : formatNumber(limit.includedMax)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Satın alınmış ek kota</dt>
          <dd className="font-medium">{formatNumber(limit.addonMax)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Bu paketle eklenecek</dt>
          <dd className="font-medium text-primary">+{formatNumber(entry.amount)} {LIMIT_LABELS[entry.resource]}</dd>
        </div>
      </dl>

      <p className="mt-4 text-[11px] leading-tight text-muted-foreground">
        Fiyat, ödeme sağlayıcısının güvenli ödeme sayfasında gösterilir. Ödeme onaylandıktan sonra kota hesabınıza
        eklenir.
      </p>

      <div className="mt-auto pt-5">
        {canPurchase ? (
          <PurchaseForm addonKey={entry.addonKey} />
        ) : (
          <span className="block rounded-lg bg-muted px-3 py-2 text-center text-sm font-semibold text-muted-foreground">
            Yalnızca firma sahibi satın alabilir
          </span>
        )}
      </div>
    </div>
  );
}

function PurchaseForm({ addonKey }: { addonKey: string }) {
  const [state, formAction] = useActionState(purchaseAddonAction, initialActionState);

  return (
    <form action={formAction} className="space-y-1.5">
      <input type="hidden" name="addonKey" value={addonKey} />
      <FormAlert error={state?.error} />
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-70"
    >
      {pending ? "Yönlendiriliyor…" : "Satın Al"}
    </button>
  );
}
