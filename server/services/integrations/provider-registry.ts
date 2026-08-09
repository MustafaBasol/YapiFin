import type { IntegrationProvider } from "@prisma/client";
import { ProviderError, type ProviderAdapter } from "./provider-adapter";
import { createFakeProviderAdapter } from "./providers/fake-provider";
import { createNilveraProviderAdapter } from "./providers/nilvera-provider";

/**
 * Sağlayıcı → adaptör çözümleme haritası (bkz. görev talimatı "Provider
 * registry/resolution mechanism"). `GENERIC` (no-op/test bağlantısı, bkz.
 * lib/validation/integration.ts) ve `NILVERA` (YF-605-D — SANDBOX,
 * salt-okunur; bkz. providers/nilvera-provider.ts) için gerçek adaptör
 * kayıtlıdır. `IntegrationConnection.provider` şemasında seçilebilir diğer
 * sağlayıcılar (`UYUMSOFT`, `IZIBIZ`, `SOVOS`, `QNB_ESOLUTIONS`, `PARASUT`)
 * henüz somut bir adaptöre sahip DEĞİLDİR (görev talimatı "Do NOT integrate
 * a real e-invoice provider" — YF-605-B) — bu, gelecekteki bir sağlayıcının
 * bu haritaya tek satır eklenerek (domain katmanı DEĞİŞMEDEN)
 * takılabileceği sözleşmenin kanıtıdır.
 */
type AdapterFactory = () => ProviderAdapter;

const DEFAULT_REGISTRY: ReadonlyMap<IntegrationProvider, AdapterFactory> = new Map([
  ["GENERIC", () => createFakeProviderAdapter("GENERIC")],
  ["NILVERA", () => createNilveraProviderAdapter()],
]);

let testOverrides = new Map<IntegrationProvider, AdapterFactory>();

/** Sağlayıcı için kayıtlı adaptörü döndürür; kayıtlı değilse sınıflandırılmış (`VALIDATION`, kalıcı) bir `ProviderError` fırlatır — domain katmanı bunu diğer sağlayıcı hatalarıyla aynı yoldan işler (bkz. provider-lifecycle-service.ts). */
export function resolveProviderAdapter(provider: IntegrationProvider): ProviderAdapter {
  const factory = testOverrides.get(provider) ?? DEFAULT_REGISTRY.get(provider);
  if (!factory) {
    throw new ProviderError(`Bu sağlayıcı için henüz bir adaptör tanımlı değil: ${provider}`, "VALIDATION");
  }
  return factory();
}

/**
 * YALNIZCA testler içindir — henüz gerçek bir adaptörü olmayan bir sağlayıcı
 * (ör. `NILVERA`) için sözleşmeyi/lifecycle'ı sahte bir adaptörle uçtan uca
 * doğrulamak amacıyla kayıt geçersiz kılar. Üretim kod yolunun hiçbir
 * yerinden çağrılmaz.
 */
export function registerProviderAdapterForTests(provider: IntegrationProvider, factory: AdapterFactory) {
  testOverrides.set(provider, factory);
}

/** YALNIZCA testler içindir — `afterEach`'te çağrılarak test override'larının sonraki testlere sızmasını engeller. */
export function resetProviderRegistryForTests() {
  testOverrides = new Map();
}
