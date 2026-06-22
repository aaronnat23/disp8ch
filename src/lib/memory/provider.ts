import { UnifiedMemoryProvider } from "./unified-provider";
import type { MemoryProvider } from "./types";
import type { MemoryConfig } from "@/types/memory";

/**
 * Returns the single UnifiedMemoryProvider.
 * The config param is accepted for backward compat but ignored at runtime —
 * UnifiedMemoryProvider reads config directly from the DB.
 */
export function createMemoryProvider(_config?: Partial<MemoryConfig>, agentId = "default"): MemoryProvider {
  return new UnifiedMemoryProvider(agentId);
}
