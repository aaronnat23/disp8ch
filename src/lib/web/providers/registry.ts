import type { WebCapability, WebProvider } from "@/lib/web/providers/types";

const providers = new Map<string, WebProvider>();

export function registerWebProvider(provider: WebProvider): void {
  providers.set(provider.name, provider);
}

export function listWebProviders(): WebProvider[] {
  return Array.from(providers.values());
}

export async function resolveWebProvider(capability: WebCapability, preferred?: string): Promise<WebProvider> {
  const candidates = preferred
    ? [providers.get(preferred), ...Array.from(providers.values()).filter((provider) => provider.name !== preferred)]
    : Array.from(providers.values());
  for (const provider of candidates) {
    if (!provider || !provider.supports[capability]) continue;
    const health = await provider.health();
    if (health.ok) return provider;
  }
  throw new Error(`No available web provider supports ${capability}`);
}

