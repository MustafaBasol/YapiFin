import Link from "next/link";
import { HardHat, Landmark, ListChecks, Plus, Users as UsersIcon } from "lucide-react";
import { requireUser } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { canCreateProject, canViewCashAndBank, canViewAllProjects } from "@/lib/permissions";
import { cn, formatMoney } from "@/lib/utils";
import { PROJECT_STATUS_META } from "@/components/app/project-status";

export default async function DashboardPage() {
  const user = await requireUser();

  const projectScope = canViewAllProjects(user.role)
    ? { organizationId: user.organizationId }
    : { organizationId: user.organizationId, members: { some: { userId: user.id } } };

  const [activeProjectCount, totalProjectCount, recentProjects, accounts, userCount] = await Promise.all([
    db.project.count({ where: { ...projectScope, status: "ACTIVE" } }),
    db.project.count({ where: projectScope }),
    db.project.findMany({
      where: projectScope,
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, name: true, code: true, status: true, contractAmount: true },
    }),
    canViewCashAndBank(user.role)
      ? db.financialAccount.findMany({ where: { organizationId: user.organizationId, isActive: true } })
      : Promise.resolve([]),
    db.user.count({ where: { organizationId: user.organizationId, status: "ACTIVE" } }),
  ]);

  const totalBalance = accounts.reduce((sum, a) => sum + Number(a.openingBalance), 0);

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Panel</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {user.organizationName} · Hoş geldin, {user.firstName}
          </p>
        </div>
        {canCreateProject(user.role) && (
          <Link
            href="/projects/new"
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Yeni proje
          </Link>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={HardHat} label="Aktif proje" value={String(activeProjectCount)} hint={`${totalProjectCount} toplam proje`} />
        {canViewCashAndBank(user.role) && (
          <StatCard icon={Landmark} label="Toplam kasa/banka bakiyesi" value={formatMoney(totalBalance)} hint={`${accounts.length} hesap`} />
        )}
        <StatCard icon={UsersIcon} label="Aktif kullanıcı" value={String(userCount)} hint="organizasyonda" />
        <StatCard icon={ListChecks} label="Bütçesi kritik proje" value="0" hint="bütçe modülü yakında" />
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="font-display text-[15px] font-semibold tracking-tight">Son eklenen projeler</h2>
          <Link href="/projects" className="text-[13px] font-medium text-primary hover:underline">
            Tümünü gör
          </Link>
        </div>
        {recentProjects.length === 0 ? (
          <div className="grid place-items-center py-16 text-center">
            <HardHat className="h-8 w-8 text-muted-foreground/50" />
            <p className="mt-3 text-sm text-muted-foreground">Henüz proje eklenmemiş.</p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {recentProjects.map((p) => {
              const st = PROJECT_STATUS_META[p.status];
              return (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
                >
                  <span
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white"
                    style={{ backgroundImage: "var(--grad-brand)" }}
                  >
                    {p.code.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold leading-tight">{p.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{p.code}</p>
                  </div>
                  <span className="tnum text-[13px] font-medium text-muted-foreground">{formatMoney(p.contractAmount.toString())}</span>
                  <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", st.tone)}>
                    {st.label}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof HardHat;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] font-medium text-muted-foreground">{label}</p>
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-2.5 tnum text-[26px] font-bold leading-none">{value}</p>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}
