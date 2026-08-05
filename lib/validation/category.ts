import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

export const categoryTypeEnum = z.enum(["INCOME", "EXPENSE"]);

export const createCategorySchema = z.object({
  type: categoryTypeEnum,
  name: z.string().trim().min(2, "Kategori adı zorunludur").max(120),
  parentId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const renameCategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(2, "Kategori adı zorunludur").max(120),
});
export type RenameCategoryInput = z.infer<typeof renameCategorySchema>;

export const categoryIdSchema = z.object({ id: z.string().min(1) });
export type CategoryIdInput = z.infer<typeof categoryIdSchema>;
