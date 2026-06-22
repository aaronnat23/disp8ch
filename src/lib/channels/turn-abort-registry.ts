/**
 * Turn abort registry — maps clientTurnId to AbortController.
 * Lets cancel-turn actually stop in-flight model/planner work.
 */

const registry = new Map<string, { controller: AbortController; reason?: string; createdAt: number }>();

export function registerTurnAbort(clientTurnId: string, controller: AbortController = new AbortController()): AbortController {
  registry.set(clientTurnId, { controller, createdAt: Date.now() });
  return controller;
}

export function abortTurn(clientTurnId: string, reason = "user"): boolean {
  const entry = registry.get(clientTurnId);
  if (!entry) return false;
  try { entry.controller.abort(`${reason}:${clientTurnId}`); } catch { /* already aborted */ }
  entry.reason = reason;
  return true;
}

export function isTurnAborted(clientTurnId: string): boolean {
  const entry = registry.get(clientTurnId);
  return entry?.controller.signal.aborted === true;
}

export function unregisterTurnAbort(clientTurnId: string): void {
  registry.delete(clientTurnId);
}

export function getAbortSignal(clientTurnId: string): AbortSignal | undefined {
  return registry.get(clientTurnId)?.controller.signal;
}

// Cleanup stale entries older than 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of registry) {
    if (now - entry.createdAt > 300_000) registry.delete(id);
  }
}, 60_000).unref();
