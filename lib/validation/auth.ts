import { z } from "zod";

const passwordSchema = z
  .string()
  .min(8, "Parola en az 8 karakter olmalıdır")
  .regex(/[a-zA-Z]/, "Parola en az bir harf içermelidir")
  .regex(/[0-9]/, "Parola en az bir rakam içermelidir");

export const registerOwnerSchema = z.object({
  firstName: z.string().trim().min(1, "Ad zorunludur").max(80),
  lastName: z.string().trim().min(1, "Soyad zorunludur").max(80),
  email: z.string().trim().toLowerCase().email("Geçerli bir e-posta girin"),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  password: passwordSchema,
  organizationName: z.string().trim().min(2, "Firma ticari adı zorunludur").max(160),
  city: z.string().trim().max(80).optional().or(z.literal("")),
  district: z.string().trim().max(80).optional().or(z.literal("")),
  taxOffice: z.string().trim().max(120).optional().or(z.literal("")),
  taxNumber: z.string().trim().max(20).optional().or(z.literal("")),
});
export type RegisterOwnerInput = z.infer<typeof registerOwnerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Geçerli bir e-posta girin"),
  password: z.string().min(1, "Parola zorunludur"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email("Geçerli bir e-posta girin"),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(1),
  firstName: z.string().trim().min(1, "Ad zorunludur").max(80),
  lastName: z.string().trim().min(1, "Soyad zorunludur").max(80),
  password: passwordSchema,
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
