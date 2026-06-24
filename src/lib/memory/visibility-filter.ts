/**
 * Pure authorization layer for workflow memory visibility. Applied to atomic
 * candidates BEFORE ranking/fusion so a scope cannot leak or suppress results
 * after the fact. The visibility is supplied only by the runtime, never by
 * model arguments.
 */
import { getSqlite } from "@/lib/db";
import type { MemoryVisibility } from "./manager";

/**
 * Returns the set of atomic-entry ids this agent may see under `visibility`:
 *  - undefined          → no filter ("all")
 *  - workflow scope     → exactly the ids owned by this agent + bound workflow
 *  - agent scope        → all this agent's ids EXCEPT another workflow's private ones
 */
export function resolveAtomicVisibility(
  agentId: string,
  visibility: MemoryVisibility | undefined,
): { mode: "all" } | { mode: "allow"; ids: Set<string> } | { mode: "exclude"; ids: Set<string> } {
  if (!visibility) return { mode: "all" };
  if (visibility.kind === "none") return { mode: "allow", ids: new Set() };
  const db = getSqlite();
  if (visibility.kind === "workflow") {
    if (!visibility.workflowId) return { mode: "allow", ids: new Set() };
    const rows = db
      .prepare("SELECT id FROM memory_atomic_scope WHERE agent_id = ? AND visibility_kind = 'workflow' AND visibility_id = ?")
      .all(agentId, visibility.workflowId) as Array<{ id: string }>;
    return { mode: "allow", ids: new Set(rows.map((r) => r.id)) };
  }
  // agent scope: exclude any workflow-private entry (missing rows = agent-visible).
  const rows = db
    .prepare("SELECT id FROM memory_atomic_scope WHERE agent_id = ? AND visibility_kind = 'workflow'")
    .all(agentId) as Array<{ id: string }>;
  return { mode: "exclude", ids: new Set(rows.map((r) => r.id)) };
}

export function atomicVisibilityAllowsId(
  resolved: ReturnType<typeof resolveAtomicVisibility>,
  id: string,
): boolean {
  if (resolved.mode === "all") return true;
  if (resolved.mode === "allow") return resolved.ids.has(id);
  return !resolved.ids.has(id);
}

/** Filter atomic search candidates by visibility. */
export function filterAtomicResultsByVisibility<T extends { id?: string }>(
  agentId: string,
  results: T[],
  visibility: MemoryVisibility | undefined,
): T[] {
  const resolved = resolveAtomicVisibility(agentId, visibility);
  if (resolved.mode === "all") return results;
  return results.filter((r) => r.id != null && atomicVisibilityAllowsId(resolved, r.id));
}
