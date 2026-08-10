import Link from "next/link";
import { XCircle } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";

/** YF-809 — Stripe Checkout iptal dönüşü. Hiçbir plan/entitlement mutasyonu YAPMAZ (bkz. success/page.tsx aynı not). */
export default async function CheckoutCancelPage() {
  await requireUser();

  return (
    <div className="mx-auto max-w-lg animate-fade-in space-y-4 py-12 text-center">
      <XCircle className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <h1 className="font-display text-xl font-bold tracking-tight">Ödeme işlemi iptal edildi</h1>
      <p className="text-sm text-muted-foreground">
        Ödeme adımından çıktınız, herhangi bir ücret alınmadı. Mevcut planınız ve kullanım haklarınız
        değişmedi. Dilediğiniz zaman tekrar deneyebilirsiniz.
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
