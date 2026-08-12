import { z } from "zod";

export const platformLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Geçerli bir e-posta girin"),
  password: z.string().min(1, "Parola zorunludur"),
});
export type PlatformLoginInput = z.infer<typeof platformLoginSchema>;
