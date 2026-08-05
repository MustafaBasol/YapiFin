import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

export const projectStatusEnum = z.enum(["DRAFT", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"]);

export const createProjectSchema = z.object({
  code: z.string().trim().min(1, "Proje kodu zorunludur").max(40),
  name: z.string().trim().min(2, "Proje adı zorunludur").max(160),
  customerId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  city: z.string().trim().max(80).optional().or(z.literal("")),
  district: z.string().trim().max(80).optional().or(z.literal("")),
  address: z.string().trim().max(300).optional().or(z.literal("")),
  startDate: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
  plannedEndDate: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
  contractAmount: z.coerce.number().nonnegative("Sözleşme bedeli negatif olamaz").default(0),
  estimatedBudget: z.coerce.number().nonnegative("Tahmini bütçe negatif olamaz").default(0),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema.extend({
  id: z.string().min(1),
  status: projectStatusEnum,
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const projectMemberSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
});
export type ProjectMemberInput = z.infer<typeof projectMemberSchema>;
