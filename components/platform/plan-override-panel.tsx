"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  applyPlatformPlanOverrideAction,
  revokePlatformPlanOverrideAction,
} from "@/app/actions/platform-plan";
import { initialActionState, type ActionState } from "@/lib/action-state";
import { FormAlert } from "@/components/auth/field-error";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatNumber } from "@/lib/utils";

export interface PlanOverridePanelPlan {
  code: string;
  name: string;
}

export interface PlanOverridePanelOverride {
  id: string;
  planCode: string;
  planName: string;
  reason: string;
  expiresAt: Date | null;
  createdAt: Date;
  platformAdminName: string;
}

export interface PlanPreviewLimit {
  limitId: string;
  label: string;
  used: number;
  currentMax: number | null;
  targetMax: number | null;
  wouldExceed: boolean;
}

interface PlanPreviewResponse {
  targetPlanCode: string;
  targetPlanName: string;
  billingSource: "STRIPE_MANAGED" | "MANUAL";
  limits: PlanPreviewLimit[];
  isDowngradeRisk: boolean;
}

function maxLabel(max: number | null): string {
  return max === null ? "Sınırsız" : formatNumber(max);
}

export function PlanOverridePanel({
  organizationId,
  currentPlanCode,
  currentPlanName,
  billingSource,
  activeOverride,
  plans,
}: {
  organizationId: string;
  currentPlanCode: string;
  currentPlanName: string;
  billingSource: "STRIPE_MANAGED" | "MANUAL";
  activeOverride: PlanOverridePanelOverride | null;
  plans: PlanOverridePanelPlan[];
}) {
  const [mode, setMode] = useState<"idle" | "changing" | "revoking">("idle");
  const [applyState, applyAction] = useActionState<ActionState, FormData>(applyPlatformPlanOverrideAction, initialActionState);
  const [revokeState, revokeAction] = useActionState<ActionState, FormData>(revokePlatformPlanOverrideAction, initialActionState);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-[11.5px] text-muted-foreground">Faturalama kaynağı</p>
          <p className="text-[13px] font-medium text-foreground">
            {billingSource === "STRIPE_MANAGED" ? "Stripe tarafından yönetiliyor" : "Dahili / manuel"}
          </p>
        </div>
        <div>
          <p className="text-[11.5px] text-muted-foreground">Platform geçersiz kılma durumu</p>
          <p className="text-[13px] font-medium text-foreground">
            {activeOverride ? (
              <span className="text-warning-foreground">Aktif — {activeOverride.planName}</span>
            ) : (
              "Yok"
            )}
          </p>
        </div>
      </div>

      {activeOverride && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-3.5 text-[12.5px]">
          <p className="font-medium text-foreground">
            {activeOverride.platformAdminName} tarafından {formatDateTime(activeOverride.createdAt)} tarihinde uygulandı.
          </p>
          <p className="mt-1 text-muted-foreground">Gerekçe: {activeOverride.reason}</p>
          <p className="mt-1 text-muted-foreground">
            Son geçerlilik: {activeOverride.expiresAt ? formatDateTime(activeOverride.expiresAt) : "Süresiz"}
          </p>
        </div>
      )}

      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setMode("changing")}>
            Planı geçersiz kıl / değiştir
          </Button>
          {activeOverride && (
            <Button type="button" size="sm" variant="destructive" onClick={() => setMode("revoking")}>
              Geçersiz kılmayı sonlandır
            </Button>
          )}
        </div>
      )}

      {mode === "changing" && (
        <PlanChangeForm
          organizationId={organizationId}
          currentPlanCode={currentPlanCode}
          currentPlanName={currentPlanName}
          plans={plans}
          formAction={applyAction}
          state={applyState}
          onCancel={() => setMode("idle")}
        />
      )}

      {mode === "revoking" && activeOverride && (
        <RevokeForm
          organizationId={organizationId}
          override={activeOverride}
          formAction={revokeAction}
          state={revokeState}
          onCancel={() => setMode("idle")}
        />
      )}
    </div>
  );
}

function PlanChangeForm({
  organizationId,
  currentPlanCode,
  currentPlanName,
  plans,
  formAction,
  state,
  onCancel,
}: {
  organizationId: string;
  currentPlanCode: string;
  currentPlanName: string;
  plans: PlanOverridePanelPlan[];
  formAction: (formData: FormData) => void;
  state: ActionState;
  onCancel: () => void;
}) {
  const candidatePlans = plans.filter((p) => p.code !== currentPlanCode);
  const [selectedPlanCode, setSelectedPlanCode] = useState("");
  const [preview, setPreview] = useState<PlanPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  /** Kullanıcı olayı (seçim değişikliği) TARAFINDAN doğrudan tetiklenir — bir `useEffect` İÇİNDE ÇAĞRILMAZ (bu kod tabanının React lint kuralı senkron effect-içi setState'i reddeder). */
  async function loadPreview(planCode: string) {
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    setConfirmed(false);
    try {
      const res = await fetch(`/api/platform/organizations/${organizationId}/plan-preview?planCode=${encodeURIComponent(planCode)}`);
      const json = await res.json();
      if (!res.ok) {
        setPreviewError(json.error ?? "Önizleme alınamadı.");
        return;
      }
      setPreview(json as PlanPreviewResponse);
    } catch {
      setPreviewError("Önizleme alınamadı.");
    } finally {
      setPreviewLoading(false);
    }
  }

  return (
    <form action={formAction} className="space-y-3 rounded-xl border border-border p-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="expectedCurrentPlanCode" value={currentPlanCode} />

      <div>
        <label className="text-[12.5px] font-medium text-foreground">Hedef plan</label>
        <select
          name="planCode"
          value={selectedPlanCode}
          onChange={(e) => {
            setSelectedPlanCode(e.target.value);
            if (e.target.value) void loadPreview(e.target.value);
          }}
          className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
        >
          <option value="">— Plan seçin —</option>
          {candidatePlans.map((p) => (
            <option key={p.code} value={p.code}>
              {p.name} ({p.code})
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11.5px] text-muted-foreground">Güncel plan: {currentPlanName}</p>
      </div>

      {previewLoading && <p className="text-[12.5px] text-muted-foreground">Etki önizleniyor…</p>}
      {previewError && <FormAlert error={previewError} />}

      {preview && !previewLoading && (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          {preview.billingSource === "STRIPE_MANAGED" && (
            <p className="text-[12px] text-warning-foreground">
              Bu organizasyon Stripe tarafından yönetiliyor. Bu işlem yalnızca dahili bir destek geçersiz kılmasıdır —
              Stripe aboneliğini DEĞİŞTİRMEZ; bir sonraki Stripe olayı (yenileme vb.) bu geçersiz kılmayı sonlandırabilir.
            </p>
          )}
          <table className="w-full text-[12px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Kota</th>
                <th className="py-1 font-medium">Kullanılan</th>
                <th className="py-1 font-medium">Güncel üst sınır</th>
                <th className="py-1 font-medium">Yeni üst sınır</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {preview.limits.map((l) => (
                <tr key={l.limitId} className={l.wouldExceed ? "text-destructive" : undefined}>
                  <td className="py-1">{l.label}</td>
                  <td className="py-1 tnum">{formatNumber(l.used)}</td>
                  <td className="py-1 tnum">{maxLabel(l.currentMax)}</td>
                  <td className="py-1 tnum">
                    {maxLabel(l.targetMax)}
                    {l.wouldExceed && " · limit aşılacak"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.isDowngradeRisk && (
            <p className="text-[12px] font-medium text-destructive">
              Uyarı: mevcut kullanım yeni planın bir veya daha fazla kotasını aşıyor. Mevcut kayıtlar SİLİNMEZ; yalnızca
              yeni kayıt oluşturma bu kotalarda engellenir.
            </p>
          )}
        </div>
      )}

      <div>
        <label className="text-[12.5px] font-medium text-foreground">Gerekçe (zorunlu)</label>
        <textarea
          name="reason"
          required
          minLength={10}
          maxLength={500}
          rows={2}
          className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
          placeholder="Bu geçersiz kılmanın nedeni…"
        />
      </div>

      <div>
        <label className="text-[12.5px] font-medium text-foreground">Son geçerlilik tarihi (isteğe bağlı)</label>
        <input
          type="datetime-local"
          name="expiresAt"
          className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
        />
      </div>

      <label className="flex items-start gap-2 text-[12.5px] text-foreground">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5"
        />
        Bu plan değişikliğinin etkisini gözden geçirdim ve onaylıyorum.
      </label>

      <FormAlert error={state?.error} success={state?.success} />

      <div className="flex gap-2">
        <SubmitButton disabled={!confirmed || previewLoading || !selectedPlanCode} label="Geçersiz kılmayı uygula" />
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Vazgeç
        </Button>
      </div>
    </form>
  );
}

function RevokeForm({
  organizationId,
  override,
  formAction,
  state,
  onCancel,
}: {
  organizationId: string;
  override: PlanOverridePanelOverride;
  formAction: (formData: FormData) => void;
  state: ActionState;
  onCancel: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <form action={formAction} className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="expectedOverrideId" value={override.id} />
      <p className="text-[12.5px] text-foreground">
        {override.planName} geçersiz kılması sonlandırılacak ve plan önceki durumuna geri döndürülecek.
      </p>
      <div>
        <label className="text-[12.5px] font-medium text-foreground">Gerekçe (zorunlu)</label>
        <textarea
          name="reason"
          required
          minLength={10}
          maxLength={500}
          rows={2}
          className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
          placeholder="Bu sonlandırmanın nedeni…"
        />
      </div>
      <label className="flex items-start gap-2 text-[12.5px] text-foreground">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
        Bu geçersiz kılmayı sonlandırmak istediğimi onaylıyorum.
      </label>
      <FormAlert error={state?.error} success={state?.success} />
      <div className="flex gap-2">
        <SubmitButton disabled={!confirmed} label="Sonlandır" variant="destructive" />
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Vazgeç
        </Button>
      </div>
    </form>
  );
}

function SubmitButton({
  disabled,
  label,
  variant = "primary",
}: {
  disabled?: boolean;
  label: string;
  variant?: "primary" | "destructive";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} disabled={disabled || pending}>
      {pending ? "İşleniyor…" : label}
    </Button>
  );
}
