/**
 * Demo data — what makes Buildr feel alive with zero API keys. Labels are
 * bilingual ({ tr, en }); the UI resolves them to the active language. Proper
 * nouns (project, client, sub names) stay as-is. Replace with real queries once
 * setup wires Supabase + storage + accounting.
 *
 * Everything here is construction project management: projects, phases (a
 * Gantt-style schedule), budget line items, subcontractors, progress-billing
 * milestones (hakediş) and daily logs.
 */
import type { L } from "@/lib/i18n/config";

export type Trade =
  | "frame"
  | "elec"
  | "plumb"
  | "hvac"
  | "finish"
  | "concrete";

export const TRADE_META: Record<Trade, { label: L; color: string }> = {
  concrete: { label: { tr: "Kaba / beton", en: "Concrete" }, color: "var(--color-trade-concrete)" },
  frame: { label: { tr: "İskelet", en: "Framing" }, color: "var(--color-trade-frame)" },
  plumb: { label: { tr: "Tesisat", en: "Plumbing" }, color: "var(--color-trade-plumb)" },
  elec: { label: { tr: "Elektrik", en: "Electrical" }, color: "var(--color-trade-elec)" },
  hvac: { label: { tr: "Mekanik / HVAC", en: "HVAC" }, color: "var(--color-trade-hvac)" },
  finish: { label: { tr: "İnce iş", en: "Finishes" }, color: "var(--color-trade-finish)" },
};

export type ProjectStatus = "on_track" | "at_risk" | "delayed" | "complete";

export const STATUS_META: Record<ProjectStatus, { label: L; tone: string; dot: string }> = {
  on_track: { label: { tr: "Yolunda", en: "On track" }, tone: "text-success bg-success/10", dot: "var(--color-success)" },
  at_risk: { label: { tr: "Riskli", en: "At risk" }, tone: "text-warning-foreground bg-warning/15", dot: "var(--color-warning)" },
  delayed: { label: { tr: "Gecikmiş", en: "Delayed" }, tone: "text-destructive bg-destructive/10", dot: "var(--color-destructive)" },
  complete: { label: { tr: "Tamamlandı", en: "Complete" }, tone: "text-info bg-info/10", dot: "var(--color-info)" },
};

export interface Phase {
  name: L;
  trade: Trade;
  /** 0–100 progress. */
  pct: number;
  /** Start/end as month index 0..11 within the project window (for the timeline). */
  start: number;
  span: number;
}

export interface BudgetLine {
  code: string;
  label: L;
  trade: Trade;
  budget: number;
  actual: number;
}

export interface Milestone {
  id: string;
  label: L;
  /** Scheduled value of this milestone. */
  value: number;
  /** Percent of this milestone that's complete / billed. */
  pct: number;
  status: "billed" | "ready" | "pending";
}

export interface Sub {
  id: string;
  name: string;
  trade: Trade;
  /** Number of open tasks assigned. */
  tasks: number;
  contract: number;
  status: "active" | "scheduled" | "done" | "overdue";
}

export interface Project {
  id: string;
  name: string;
  client: string;
  type: L;
  status: ProjectStatus;
  pct: number;
  budget: number;
  spent: number;
  /** ISO deadline. */
  deadline: string;
  /** Retainage withheld %, for the billing panel. */
  retainage: number;
  phases: Phase[];
  budgetLines: BudgetLine[];
  subs: Sub[];
  milestones: Milestone[];
}

const today = new Date("2026-06-14T00:00:00Z");
function inDays(n: number) {
  return new Date(today.getTime() + n * 86400000).toISOString();
}

/* ── Projects ──────────────────────────────────────────────────────────────── */
export const projects: Project[] = [
  {
    id: "p1",
    name: "Maple Ridge Residences",
    client: "Northwind Developments",
    type: { tr: "12 daireli konut", en: "12-unit residential" },
    status: "on_track",
    pct: 62,
    budget: 2_840_000,
    spent: 1_690_000,
    deadline: inDays(96),
    retainage: 5,
    phases: [
      { name: { tr: "Hafriyat & temel", en: "Excavation & foundation" }, trade: "concrete", pct: 100, start: 0, span: 2 },
      { name: { tr: "Kaba yapı", en: "Structure & framing" }, trade: "frame", pct: 100, start: 2, span: 2 },
      { name: { tr: "Tesisat & elektrik", en: "Plumbing & electrical" }, trade: "elec", pct: 70, start: 3, span: 3 },
      { name: { tr: "Mekanik / HVAC", en: "Mechanical / HVAC" }, trade: "hvac", pct: 45, start: 4, span: 3 },
      { name: { tr: "İnce işler", en: "Interior finishes" }, trade: "finish", pct: 10, start: 6, span: 4 },
    ],
    budgetLines: [
      { code: "03-100", label: { tr: "Beton & temel", en: "Concrete & foundation" }, trade: "concrete", budget: 420_000, actual: 408_500 },
      { code: "06-100", label: { tr: "Ahşap & iskelet", en: "Framing" }, trade: "frame", budget: 520_000, actual: 541_200 },
      { code: "22-000", label: { tr: "Tesisat", en: "Plumbing" }, trade: "plumb", budget: 310_000, actual: 196_000 },
      { code: "26-000", label: { tr: "Elektrik", en: "Electrical" }, trade: "elec", budget: 360_000, actual: 214_000 },
      { code: "23-000", label: { tr: "HVAC", en: "HVAC" }, trade: "hvac", budget: 410_000, actual: 132_000 },
      { code: "09-000", label: { tr: "İnce iş & boya", en: "Finishes" }, trade: "finish", budget: 460_000, actual: 38_000 },
    ],
    subs: [
      { id: "s1", name: "Ironhold Framing Co.", trade: "frame", tasks: 0, contract: 520_000, status: "done" },
      { id: "s2", name: "Beacon Electric", trade: "elec", tasks: 4, contract: 360_000, status: "active" },
      { id: "s3", name: "Tidewater Plumbing", trade: "plumb", tasks: 3, contract: 310_000, status: "active" },
      { id: "s4", name: "Summit Mechanical", trade: "hvac", tasks: 6, contract: 410_000, status: "scheduled" },
      { id: "s5", name: "Polished Interiors", trade: "finish", tasks: 2, contract: 460_000, status: "scheduled" },
    ],
    milestones: [
      { id: "m1", label: { tr: "Temel & kaba yapı", en: "Foundation & structure" }, value: 940_000, pct: 100, status: "billed" },
      { id: "m2", label: { tr: "Çatı & kabuk", en: "Roof & envelope" }, value: 620_000, pct: 100, status: "billed" },
      { id: "m3", label: { tr: "Tesisat altyapısı", en: "MEP rough-in" }, value: 540_000, pct: 70, status: "ready" },
      { id: "m4", label: { tr: "İnce işler", en: "Interior finishes" }, value: 480_000, pct: 12, status: "pending" },
      { id: "m5", label: { tr: "Teslim & kabul", en: "Handover & punch list" }, value: 260_000, pct: 0, status: "pending" },
    ],
  },
  {
    id: "p2",
    name: "Cedar Street Office",
    client: "Formwork Capital",
    type: { tr: "Ofis tadilatı", en: "Office fit-out" },
    status: "at_risk",
    pct: 48,
    budget: 1_180_000,
    spent: 712_000,
    deadline: inDays(34),
    retainage: 10,
    phases: [
      { name: { tr: "Yıkım & sökme", en: "Demolition & strip-out" }, trade: "concrete", pct: 100, start: 0, span: 1 },
      { name: { tr: "Bölme & duvar", en: "Partitions & drywall" }, trade: "frame", pct: 85, start: 1, span: 2 },
      { name: { tr: "Elektrik & veri", en: "Electrical & data" }, trade: "elec", pct: 55, start: 2, span: 2 },
      { name: { tr: "HVAC revizyon", en: "HVAC revisions" }, trade: "hvac", pct: 30, start: 2, span: 3 },
      { name: { tr: "İnce iş & mobilya", en: "Finishes & joinery" }, trade: "finish", pct: 5, start: 4, span: 2 },
    ],
    budgetLines: [
      { code: "02-000", label: { tr: "Yıkım", en: "Demolition" }, trade: "concrete", budget: 90_000, actual: 96_400 },
      { code: "09-200", label: { tr: "Bölme & alçıpan", en: "Partitions & drywall" }, trade: "frame", budget: 220_000, actual: 231_000 },
      { code: "26-000", label: { tr: "Elektrik & veri", en: "Electrical & data" }, trade: "elec", budget: 240_000, actual: 158_000 },
      { code: "23-000", label: { tr: "HVAC", en: "HVAC" }, trade: "hvac", budget: 280_000, actual: 121_000 },
      { code: "12-000", label: { tr: "Mobilya & ince iş", en: "Joinery & finishes" }, trade: "finish", budget: 250_000, actual: 16_000 },
    ],
    subs: [
      { id: "s6", name: "Apex Drywall", trade: "frame", tasks: 2, contract: 220_000, status: "active" },
      { id: "s7", name: "Voltline Systems", trade: "elec", tasks: 5, contract: 240_000, status: "active" },
      { id: "s8", name: "AirFlow HVAC", trade: "hvac", tasks: 7, contract: 280_000, status: "overdue" },
      { id: "s9", name: "Craft Joinery", trade: "finish", tasks: 1, contract: 250_000, status: "scheduled" },
    ],
    milestones: [
      { id: "m6", label: { tr: "Yıkım & bölmeler", en: "Demo & partitions" }, value: 360_000, pct: 100, status: "billed" },
      { id: "m7", label: { tr: "Elektrik altyapısı", en: "Electrical rough-in" }, value: 240_000, pct: 55, status: "ready" },
      { id: "m8", label: { tr: "HVAC revizyon", en: "HVAC revisions" }, value: 300_000, pct: 30, status: "pending" },
      { id: "m9", label: { tr: "İnce iş & teslim", en: "Finishes & handover" }, value: 280_000, pct: 4, status: "pending" },
    ],
  },
  {
    id: "p3",
    name: "Harbor View Warehouse",
    client: "Meridian Logistics",
    type: { tr: "Endüstriyel depo", en: "Industrial warehouse" },
    status: "delayed",
    pct: 31,
    budget: 3_960_000,
    spent: 1_340_000,
    deadline: inDays(18),
    retainage: 7.5,
    phases: [
      { name: { tr: "Saha & temel", en: "Sitework & footings" }, trade: "concrete", pct: 100, start: 0, span: 2 },
      { name: { tr: "Çelik konstrüksiyon", en: "Steel erection" }, trade: "frame", pct: 60, start: 2, span: 3 },
      { name: { tr: "Çatı & cephe", en: "Roof & cladding" }, trade: "frame", pct: 20, start: 4, span: 2 },
      { name: { tr: "Elektrik & yangın", en: "Electrical & fire" }, trade: "elec", pct: 10, start: 5, span: 3 },
      { name: { tr: "Zemin & kapılar", en: "Slab & dock doors" }, trade: "concrete", pct: 0, start: 7, span: 2 },
    ],
    budgetLines: [
      { code: "31-000", label: { tr: "Saha düzenleme", en: "Sitework" }, trade: "concrete", budget: 480_000, actual: 512_000 },
      { code: "05-100", label: { tr: "Çelik konstrüksiyon", en: "Structural steel" }, trade: "frame", budget: 1_280_000, actual: 690_000 },
      { code: "07-400", label: { tr: "Çatı & cephe", en: "Roof & cladding" }, trade: "frame", budget: 640_000, actual: 128_000 },
      { code: "26-000", label: { tr: "Elektrik", en: "Electrical" }, trade: "elec", budget: 520_000, actual: 0 },
      { code: "03-300", label: { tr: "Beton zemin", en: "Concrete slab" }, trade: "concrete", budget: 540_000, actual: 0 },
    ],
    subs: [
      { id: "s10", name: "Granite Siteworks", trade: "concrete", tasks: 0, contract: 480_000, status: "done" },
      { id: "s11", name: "SteelSpan Erectors", trade: "frame", tasks: 8, contract: 1_280_000, status: "overdue" },
      { id: "s12", name: "Beacon Electric", trade: "elec", tasks: 3, contract: 520_000, status: "scheduled" },
    ],
    milestones: [
      { id: "m10", label: { tr: "Saha & temel", en: "Sitework & footings" }, value: 720_000, pct: 100, status: "billed" },
      { id: "m11", label: { tr: "Çelik konstrüksiyon", en: "Steel structure" }, value: 1_280_000, pct: 60, status: "ready" },
      { id: "m12", label: { tr: "Kabuk & çatı", en: "Envelope & roof" }, value: 980_000, pct: 18, status: "pending" },
      { id: "m13", label: { tr: "İç tesisat", en: "Interior systems" }, value: 980_000, pct: 0, status: "pending" },
    ],
  },
  {
    id: "p4",
    name: "Birchwood Custom Home",
    client: "The Halvorsen Family",
    type: { tr: "Lüks villa", en: "Custom home" },
    status: "on_track",
    pct: 78,
    budget: 1_640_000,
    spent: 1_205_000,
    deadline: inDays(58),
    retainage: 5,
    phases: [
      { name: { tr: "Temel", en: "Foundation" }, trade: "concrete", pct: 100, start: 0, span: 1 },
      { name: { tr: "Kaba yapı & çatı", en: "Frame & roof" }, trade: "frame", pct: 100, start: 1, span: 2 },
      { name: { tr: "Tesisat altyapısı", en: "MEP rough-in" }, trade: "plumb", pct: 100, start: 3, span: 2 },
      { name: { tr: "İnce işler", en: "Interior finishes" }, trade: "finish", pct: 60, start: 5, span: 3 },
      { name: { tr: "Peyzaj & teslim", en: "Landscape & handover" }, trade: "finish", pct: 20, start: 8, span: 2 },
    ],
    budgetLines: [
      { code: "03-100", label: { tr: "Temel", en: "Foundation" }, trade: "concrete", budget: 180_000, actual: 176_000 },
      { code: "06-100", label: { tr: "Kaba yapı & çatı", en: "Frame & roof" }, trade: "frame", budget: 340_000, actual: 332_000 },
      { code: "22-000", label: { tr: "Tesisat", en: "Plumbing" }, trade: "plumb", budget: 160_000, actual: 154_000 },
      { code: "26-000", label: { tr: "Elektrik", en: "Electrical" }, trade: "elec", budget: 150_000, actual: 142_000 },
      { code: "09-000", label: { tr: "İnce iş", en: "Finishes" }, trade: "finish", budget: 540_000, actual: 312_000 },
    ],
    subs: [
      { id: "s13", name: "Ironhold Framing Co.", trade: "frame", tasks: 0, contract: 340_000, status: "done" },
      { id: "s14", name: "Tidewater Plumbing", trade: "plumb", tasks: 0, contract: 160_000, status: "done" },
      { id: "s15", name: "Polished Interiors", trade: "finish", tasks: 5, contract: 540_000, status: "active" },
    ],
    milestones: [
      { id: "m14", label: { tr: "Temel & kaba yapı", en: "Foundation & frame" }, value: 560_000, pct: 100, status: "billed" },
      { id: "m15", label: { tr: "Altyapı & kapatma", en: "Rough-in & close-up" }, value: 420_000, pct: 100, status: "billed" },
      { id: "m16", label: { tr: "İnce işler", en: "Interior finishes" }, value: 480_000, pct: 60, status: "ready" },
      { id: "m17", label: { tr: "Peyzaj & teslim", en: "Landscape & handover" }, value: 180_000, pct: 18, status: "pending" },
    ],
  },
  {
    id: "p5",
    name: "Lakeside Clinic Expansion",
    client: "Cedarworks Health",
    type: { tr: "Sağlık ek bina", en: "Healthcare addition" },
    status: "at_risk",
    pct: 54,
    budget: 2_210_000,
    spent: 1_298_000,
    deadline: inDays(47),
    retainage: 10,
    phases: [
      { name: { tr: "Temel & genişletme", en: "Foundation & shell" }, trade: "concrete", pct: 100, start: 0, span: 2 },
      { name: { tr: "İskelet & kabuk", en: "Frame & envelope" }, trade: "frame", pct: 90, start: 2, span: 2 },
      { name: { tr: "Mekanik & medikal gaz", en: "Mechanical & med-gas" }, trade: "hvac", pct: 50, start: 3, span: 3 },
      { name: { tr: "Elektrik & yedek güç", en: "Electrical & backup" }, trade: "elec", pct: 40, start: 4, span: 3 },
      { name: { tr: "İnce iş & sertifikasyon", en: "Finishes & certification" }, trade: "finish", pct: 15, start: 6, span: 3 },
    ],
    budgetLines: [
      { code: "03-100", label: { tr: "Temel & kabuk", en: "Foundation & shell" }, trade: "concrete", budget: 360_000, actual: 354_000 },
      { code: "06-100", label: { tr: "İskelet & kabuk", en: "Frame & envelope" }, trade: "frame", budget: 420_000, actual: 401_000 },
      { code: "23-000", label: { tr: "Mekanik & medikal gaz", en: "Mechanical & med-gas" }, trade: "hvac", budget: 540_000, actual: 287_000 },
      { code: "26-000", label: { tr: "Elektrik & yedek güç", en: "Electrical & backup" }, trade: "elec", budget: 430_000, actual: 188_000 },
      { code: "09-000", label: { tr: "İnce iş & sertifikasyon", en: "Finishes & cert." }, trade: "finish", budget: 460_000, actual: 68_000 },
    ],
    subs: [
      { id: "s16", name: "Granite Siteworks", trade: "concrete", tasks: 0, contract: 360_000, status: "done" },
      { id: "s17", name: "Summit Mechanical", trade: "hvac", tasks: 6, contract: 540_000, status: "active" },
      { id: "s18", name: "Voltline Systems", trade: "elec", tasks: 4, contract: 430_000, status: "active" },
      { id: "s19", name: "Craft Joinery", trade: "finish", tasks: 2, contract: 460_000, status: "scheduled" },
    ],
    milestones: [
      { id: "m18", label: { tr: "Temel & kabuk", en: "Foundation & shell" }, value: 780_000, pct: 100, status: "billed" },
      { id: "m19", label: { tr: "Mekanik altyapı", en: "Mechanical rough-in" }, value: 620_000, pct: 50, status: "ready" },
      { id: "m20", label: { tr: "Elektrik & güç", en: "Electrical & power" }, value: 480_000, pct: 38, status: "pending" },
      { id: "m21", label: { tr: "İnce iş & sertifika", en: "Finishes & certification" }, value: 330_000, pct: 12, status: "pending" },
    ],
  },
];

/* ── Dashboard summary (computed-feel constants) ───────────────────────────── */
export const summary = {
  activeProjects: { label: { tr: "Aktif proje", en: "Active projects" } as L, value: projects.filter((p) => p.status !== "complete").length, hint: { tr: "5 sahada", en: "across 5 sites" } as L },
  budgetVsActual: { label: { tr: "Bütçe vs gerçek", en: "Budget vs actual" } as L, budget: projects.reduce((s, p) => s + p.budget, 0), actual: projects.reduce((s, p) => s + p.spent, 0) },
  billingDue: { label: { tr: "Hakediş hazır", en: "Progress billing due" } as L, value: 1_400_000, count: 3 },
  openItems: { label: { tr: "Açık RFI & görev", en: "Open RFIs / tasks" } as L, value: 47, delta: -6 },
};

/* ── Budget-vs-actual trend (last 6 months, $000s) ─────────────────────────── */
export const budgetTrend = {
  title: { tr: "Bütçe vs gerçek harcama", en: "Budget vs actual spend" } as L,
  subtitle: { tr: "Son 6 ay — tüm projeler", en: "Last 6 months — all projects" } as L,
  delta: "+0.9%",
  labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
  budget: [820, 1180, 1640, 2210, 2680, 3140],
  actual: [790, 1140, 1610, 2180, 2620, 3110],
};

/* ── Daily logs / tasks ────────────────────────────────────────────────────── */
export interface DailyLog {
  id: string;
  project: string;
  who: string;
  action: L;
  target: string;
  at: string;
  tone: "neutral" | "success" | "warning" | "info";
}

export const dailyLogs: DailyLog[] = [
  { id: "d1", project: "Maple Ridge", who: "Beacon Electric", action: { tr: "altyapıyı tamamladı:", en: "completed rough-in for" }, target: "Block A", at: "2026-06-14T08:20:00Z", tone: "success" },
  { id: "d2", project: "Cedar Street", who: "AirFlow HVAC", action: { tr: "teslimi geciktirdi:", en: "is behind on" }, target: "duct delivery", at: "2026-06-14T07:40:00Z", tone: "warning" },
  { id: "d3", project: "Harbor View", who: "Site team", action: { tr: "RFI açtı:", en: "raised RFI on" }, target: "steel connection #14", at: "2026-06-13T16:05:00Z", tone: "info" },
  { id: "d4", project: "Birchwood", who: "Polished Interiors", action: { tr: "kontrolü geçti:", en: "passed inspection on" }, target: "tile & millwork", at: "2026-06-13T14:30:00Z", tone: "success" },
  { id: "d5", project: "Lakeside Clinic", who: "Summit Mechanical", action: { tr: "değişiklik talep etti:", en: "submitted change order" }, target: "med-gas reroute", at: "2026-06-13T11:48:00Z", tone: "neutral" },
  { id: "d6", project: "Maple Ridge", who: "Inspector", action: { tr: "onayladı:", en: "approved" }, target: "framing milestone", at: "2026-06-12T10:10:00Z", tone: "success" },
];

/* ── Today's tasks (daily-logs panel) ──────────────────────────────────────── */
export interface Task {
  id: string;
  label: L;
  project: string;
  trade: Trade;
  due: L;
  done: boolean;
}

export const tasks: Task[] = [
  { id: "t1", label: { tr: "Elektrik kontrolünü planla", en: "Schedule electrical inspection" }, project: "Maple Ridge", trade: "elec", due: { tr: "Bugün", en: "Today" }, done: false },
  { id: "t2", label: { tr: "HVAC kanal teslimini takip et", en: "Chase HVAC duct delivery" }, project: "Cedar Street", trade: "hvac", due: { tr: "Bugün", en: "Today" }, done: false },
  { id: "t3", label: { tr: "Çelik RFI #14'ü yanıtla", en: "Answer steel RFI #14" }, project: "Harbor View", trade: "frame", due: { tr: "Yarın", en: "Tomorrow" }, done: false },
  { id: "t4", label: { tr: "Hakediş #3 müşteriye gönder", en: "Send progress invoice #3" }, project: "Maple Ridge", trade: "finish", due: { tr: "Bugün", en: "Today" }, done: true },
  { id: "t5", label: { tr: "Mobilya teklifini onayla", en: "Approve joinery bid" }, project: "Lakeside Clinic", trade: "finish", due: { tr: "2 gün", en: "2 days" }, done: false },
];

/* ── Interactive landing demo: a project whose milestones can be completed ──── */
export const demoProject = {
  name: "Maple Ridge — Block A",
  total: 2_840_000,
  retainage: 5,
  milestones: [
    { id: "dm1", label: { tr: "Temel & kaba yapı", en: "Foundation & structure" }, value: 940_000, done: true },
    { id: "dm2", label: { tr: "Çatı & kabuk", en: "Roof & envelope" }, value: 620_000, done: true },
    { id: "dm3", label: { tr: "Tesisat altyapısı", en: "MEP rough-in" }, value: 540_000, done: false },
    { id: "dm4", label: { tr: "İnce işler", en: "Interior finishes" }, value: 480_000, done: false },
    { id: "dm5", label: { tr: "Teslim & kabul", en: "Handover & punch list" }, value: 260_000, done: false },
  ] as { id: string; label: L; value: number; done: boolean }[],
};
