import type { IntegrationProvider } from "@prisma/client";
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderConnectionContext,
  type ProviderConnectionTestResult,
  type ProviderCredentials,
  type ProviderOutboundOperationInput,
  type ProviderOutboundOperationResult,
} from "../provider-adapter";

/**
 * YF-605-B — bu fazdaki TEK somut adaptör (bkz. görev talimatı "Fake/mock
 * provider implementation for testing"). Hiçbir ağ çağrısı yapmaz. Varsayılan
 * davranış her zaman başarılıdır (`GENERIC` bağlantı için no-op, bkz.
 * lib/validation/integration.ts — "GENERIC her iki türde de no-op/test
 * bağlantısı için kullanılabilir"); `behavior` parametresiyle testler
 * başarısızlık/kategori senaryolarını enjekte edebilir (bkz.
 * provider-registry.ts registerProviderAdapterForTests).
 */
export interface FakeProviderBehavior {
  capabilities?: readonly ProviderCapability[];
  testConnection?: (
    credentials: ProviderCredentials,
    ctx: ProviderConnectionContext,
  ) => Promise<ProviderConnectionTestResult> | ProviderConnectionTestResult;
  executeOutboundOperation?: (
    input: ProviderOutboundOperationInput,
    credentials: ProviderCredentials,
    ctx: ProviderConnectionContext,
  ) => Promise<ProviderOutboundOperationResult> | ProviderOutboundOperationResult;
}

export function createFakeProviderAdapter(
  provider: IntegrationProvider,
  behavior: FakeProviderBehavior = {},
): ProviderAdapter {
  return {
    provider,
    capabilities: behavior.capabilities ?? ["CONNECTION_TEST", "OUTBOUND_OPERATION"],
    async testConnection(credentials, ctx) {
      if (behavior.testConnection) return behavior.testConnection(credentials, ctx);
      if (!credentials.secretValue) {
        throw new ProviderError("Kimlik bilgisi eksik", "AUTH_CONFIG");
      }
      return { ok: true, summary: "Sahte sağlayıcı bağlantısı doğrulandı (no-op, gerçek ağ çağrısı yapılmadı)" };
    },
    async executeOutboundOperation(input, credentials, ctx) {
      if (behavior.executeOutboundOperation) return behavior.executeOutboundOperation(input, credentials, ctx);
      if (!credentials.secretValue) {
        throw new ProviderError("Kimlik bilgisi eksik", "AUTH_CONFIG");
      }
      return { ok: true, resultSummary: { operationType: input.operationType } };
    },
  };
}
