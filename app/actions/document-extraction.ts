"use server";

import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { uploadDocumentSchema, confirmDocumentExtractionSchema } from "@/lib/validation/document-extraction";
import { uploadAndExtractDocument, confirmDocumentExtraction } from "@/server/services/document-extraction-service";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/lib/action-error";

/** `canCreateExpense` ile aynı rol kümesi — bkz. lib/permissions.ts. */
const EXPENSE_ROLES = ["OWNER", "ADMIN", "FINANCE", "PROJECT_MANAGER"] as const;

export async function uploadDocumentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...EXPENSE_ROLES]);

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Lütfen bir dosya seçin" };
  }

  const parsed = uploadDocumentSchema.safeParse({ projectId: formData.get("projectId") ?? "" });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  let id: string;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const record = await uploadAndExtractDocument(actor, {
      ...parsed.data,
      fileName: file.name,
      buffer,
    });
    id = record.id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/documents/ocr/${id}`);
}

export async function confirmDocumentExtractionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireRole([...EXPENSE_ROLES]);
  const parsed = confirmDocumentExtractionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Form geçersiz" };

  let transactionId: string;
  try {
    const result = await confirmDocumentExtraction(actor, parsed.data);
    transactionId = result.transactionId;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/expenses/${transactionId}`);
}
