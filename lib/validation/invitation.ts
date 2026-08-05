import { z } from "zod";

export const createInvitationSchema = z
  .object({
    email: z.string().trim().toLowerCase().email("Geçerli bir e-posta girin"),
    role: z.enum(["OWNER", "ADMIN", "FINANCE", "PROJECT_MANAGER"]),
    projectIds: z.array(z.string().min(1)).default([]),
  })
  .refine((data) => data.role !== "PROJECT_MANAGER" || data.projectIds.length > 0, {
    message: "Proje yöneticisi en az bir projeye atanmalıdır",
    path: ["projectIds"],
  });
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
