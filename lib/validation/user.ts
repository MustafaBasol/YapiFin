import { z } from "zod";

export const changeUserRoleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["OWNER", "ADMIN", "FINANCE", "PROJECT_MANAGER"]),
});
export type ChangeUserRoleInput = z.infer<typeof changeUserRoleSchema>;

export const userIdSchema = z.object({
  userId: z.string().min(1),
});
export type UserIdInput = z.infer<typeof userIdSchema>;
