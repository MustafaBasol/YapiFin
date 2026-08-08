"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guard";
import {
  uploadBankStatementSchema,
  confirmBankImportRowAsSettlementSchema,
  confirmBankImportRowAsTransferSchema,
  ignoreBankImportRowSchema,
} from "@/lib/validation/bank-import";
import {
  importBankStatement,
  confirmBankImportRowAsSettlement,
  confirmBankImportRowAsTransfer,
  ignoreBankImportRow,
} from "@/server/services/bank-import-service";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/lib/action-error";

/** `canManageAccounts` ile aynı rol kümesi — bkz. lib/permissions.ts. */
const ACCOUNT_ROLES = ["OWNER", "ADMIN", "FINANCE"] as const;

export async function uploadBankStatementAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...ACCOUNT_ROLES]);

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Lütfen bir dosya seçin" };
  }

  const parsed = uploadBankStatementSchema.safeParse({ financialAccountId: formData.get("financialAccountId") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  let batchId: string;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await importBankStatement(actor, {
      financialAccountId: parsed.data.financialAccountId,
      fileName: file.name,
      buffer,
    });
    batchId = result.batch.id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/bank-import/${batchId}`);
}

export async function confirmBankImportRowAsSettlementAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...ACCOUNT_ROLES]);
  const parsed = confirmBankImportRowAsSettlementSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  const batchId = String(formData.get("batchId") ?? "");
  try {
    await confirmBankImportRowAsSettlement(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  if (batchId) revalidatePath(`/bank-import/${batchId}`);
  return { success: "Satır mutabık kılındı." };
}

export async function confirmBankImportRowAsTransferAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...ACCOUNT_ROLES]);
  const parsed = confirmBankImportRowAsTransferSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  const batchId = String(formData.get("batchId") ?? "");
  try {
    await confirmBankImportRowAsTransfer(actor, parsed.data);
  } catch (err) {
    return toActionError(err);
  }
  if (batchId) revalidatePath(`/bank-import/${batchId}`);
  return { success: "Satır transfer olarak mutabık kılındı." };
}

export async function ignoreBankImportRowAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...ACCOUNT_ROLES]);
  const parsed = ignoreBankImportRowSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  const batchId = String(formData.get("batchId") ?? "");
  try {
    await ignoreBankImportRow(actor, parsed.data.rowId);
  } catch (err) {
    return toActionError(err);
  }
  if (batchId) revalidatePath(`/bank-import/${batchId}`);
  return { success: "Satır yok sayıldı." };
}
