import type { ProviderTransport } from "@/lib/agents/transports/types";

const transportRegistry = new Map<string, ProviderTransport>();

export function registerTransport(name: string, transport: ProviderTransport): void {
  transportRegistry.set(name, transport);
}

export function getTransport(name: string): ProviderTransport | undefined {
  return transportRegistry.get(name);
}

export function listTransports(): string[] {
  return Array.from(transportRegistry.keys());
}

export function isTransportAvailable(name: string): boolean {
  const transport = transportRegistry.get(name);
  if (!transport) return false;
  return transport.isAvailable();
}
