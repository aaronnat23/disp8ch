import type { PublishProvider } from "../types";
import { vercelPublishProvider } from "./vercel";
import { cloudflareTemporaryPublishProvider } from "./cloudflare-temporary";

const providers = new Map<string, PublishProvider>([
  [cloudflareTemporaryPublishProvider.id, cloudflareTemporaryPublishProvider],
  [vercelPublishProvider.id, vercelPublishProvider],
]);

export function getPublishProvider(id: string): PublishProvider | null {
  return providers.get(String(id).trim().toLowerCase()) ?? null;
}

export function listPublishProviders() {
  return [...providers.values()].map((provider) => ({ id: provider.id, capabilities: provider.capabilities }));
}

export function registerPublishProvider(provider: PublishProvider): () => void {
  const key = provider.id.trim().toLowerCase();
  const previous = providers.get(key);
  providers.set(key, provider);
  return () => previous ? providers.set(key, previous) : void providers.delete(key);
}
