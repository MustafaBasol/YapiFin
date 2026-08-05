import type { ProjectStatus } from "@prisma/client";

export const PROJECT_STATUS_META: Record<ProjectStatus, { label: string; tone: string }> = {
  DRAFT: { label: "Taslak", tone: "bg-muted text-muted-foreground" },
  ACTIVE: { label: "Aktif", tone: "bg-success/12 text-success" },
  ON_HOLD: { label: "Beklemede", tone: "bg-warning/15 text-warning-foreground" },
  COMPLETED: { label: "Tamamlandı", tone: "bg-info/12 text-info" },
  CANCELLED: { label: "İptal", tone: "bg-destructive/10 text-destructive" },
};

export const PROJECT_STATUS_OPTIONS: ProjectStatus[] = ["DRAFT", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"];
