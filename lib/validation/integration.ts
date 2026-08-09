import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

export const integrationTypeEnum = z.enum(["E_INVOICE", "ACCOUNTING"]);
export const integrationProviderEnum = z.enum([
  "NILVERA",
  "UYUMSOFT",
  "IZIBIZ",
  "SOVOS",
  "QNB_ESOLUTIONS",
  "PARASUT",
  "GENERIC",
]);
export const integrationEnvironmentEnum = z.enum(["SANDBOX", "PRODUCTION"]);

/**
 * Hangi sağlayıcının hangi entegrasyon türüne ait olduğu — mimari doküman
 * §2.1/§2.2'deki sağlayıcı taksonomisiyle tutarlı. `GENERIC` her iki türde
 * de (no-op/test bağlantısı) kullanılabilir.
 */
const PROVIDERS_BY_TYPE: Record<z.infer<typeof integrationTypeEnum>, Set<string>> = {
  E_INVOICE: new Set(["NILVERA", "UYUMSOFT", "IZIBIZ", "SOVOS", "QNB_ESOLUTIONS", "GENERIC"]),
  ACCOUNTING: new Set(["PARASUT", "GENERIC"]),
};

function refineProviderMatchesType<T extends { integrationType: string; provider: string }>(
  data: T,
  ctx: z.RefinementCtx,
) {
  const allowed = PROVIDERS_BY_TYPE[data.integrationType as keyof typeof PROVIDERS_BY_TYPE];
  if (allowed && !allowed.has(data.provider)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provider"],
      message: "Seçilen sağlayıcı bu entegrasyon türü için geçerli değil",
    });
  }
}

export const createIntegrationConnectionSchema = z
  .object({
    integrationType: integrationTypeEnum,
    provider: integrationProviderEnum,
    environment: integrationEnvironmentEnum,
    displayName: z.string().trim().min(2, "Görünen ad zorunludur").max(120),
    externalTenantId: z.preprocess(emptyToUndefined, z.string().trim().max(120).optional()),
  })
  .superRefine(refineProviderMatchesType);
export type CreateIntegrationConnectionInput = z.infer<typeof createIntegrationConnectionSchema>;

export const updateIntegrationConnectionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().trim().min(2, "Görünen ad zorunludur").max(120),
  externalTenantId: z.preprocess(emptyToUndefined, z.string().trim().max(120).optional()),
});
export type UpdateIntegrationConnectionInput = z.infer<typeof updateIntegrationConnectionSchema>;

export const integrationConnectionIdSchema = z.object({ id: z.string().min(1) });
export type IntegrationConnectionIdInput = z.infer<typeof integrationConnectionIdSchema>;

export const setIntegrationCredentialSchema = z.object({
  connectionId: z.string().min(1),
  secretValue: z.string().trim().min(1, "Kimlik bilgisi zorunludur").max(4000),
});
export type SetIntegrationCredentialInput = z.infer<typeof setIntegrationCredentialSchema>;

/**
 * YF-605-D-UI — Nilvera sandbox salt-okunur sorgu formları için istek
 * gövdesi şemaları (bkz. görev talimatı "Taxpayer lookup" / "Document
 * status lookup"). Yalnızca istemci girdisini biçimsel olarak doğrular;
 * asıl yetki/tenant/yetenek kontrolü `provider-lifecycle-service.ts`
 * içindedir (tek kaynak — bkz. proje talimatı "Form ve API doğrulaması
 * ortak Zod şemalarıyla").
 */
export const taxpayerLookupRequestSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, "Vergi/kimlik numarası zorunludur")
    .regex(/^\d{10,11}$/, "Vergi/kimlik numarası 10 (VKN) veya 11 (TCKN) haneli olmalıdır"),
});
export type TaxpayerLookupRequestInput = z.infer<typeof taxpayerLookupRequestSchema>;

export const documentStatusLookupRequestSchema = z.object({
  externalDocumentId: z
    .string()
    .trim()
    .min(1, "Belge referans kimliği (ETTN/UUID) zorunludur")
    .max(100, "Belge referans kimliği çok uzun"),
});
export type DocumentStatusLookupRequestInput = z.infer<typeof documentStatusLookupRequestSchema>;
