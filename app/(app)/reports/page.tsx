import Link from "next/link";
import { ArrowRight, ChartNoAxesColumn, PiggyBank } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";

const REPORTS = [
  {
    href: "/reports/cash-flow",
    icon: ChartNoAxesColumn,
    title: "Nakit Akışı",
    description: "Gerçekleşen ve planlanan tahsilat/ödemeler, vade dağılımı ve aylık nakit projeksiyonu.",
  },
  {
    href: "/reports/budget",
    icon: PiggyBank,
    title: "Bütçe Analizi",
    description: "Proje bütçe kullanımı, gider kategori dağılımı ve bütçe aşımı/kritik proje takibi.",
  },
];

export default async function ReportsIndexPage() {
  await requireUser();

  return (
    <div className="mx-auto max-w-[1100px] animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Raporlar</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Finansal durumunuzu farklı açılardan inceleyin.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {REPORTS.map((r) => (
          <Link
            key={r.href}
            href={r.href}
            className="group rounded-2xl border border-border bg-card p-5 shadow-soft transition-colors hover:border-primary/40"
          >
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <r.icon className="h-5 w-5" />
            </span>
            <h2 className="mt-3.5 font-display text-[15px] font-semibold tracking-tight">{r.title}</h2>
            <p className="mt-1 text-[12.5px] text-muted-foreground">{r.description}</p>
            <span className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-semibold text-primary">
              Görüntüle
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
