// Server-only — do not import in client components.
// Compatibility facade: session debouncing and dirty-state ownership now live
// inside MemorySearchManager.

import { getMemorySearchManager } from "./manager";

export function scheduleSessionIndex(sessionId: string, agentId = "default"): void {
  getMemorySearchManager(agentId).scheduleSessionIndex(sessionId);
}

export function getSessionWatcherStatus(agentId = "default") {
  return getMemorySearchManager(agentId).getRuntimeStatus().sessions;
}
