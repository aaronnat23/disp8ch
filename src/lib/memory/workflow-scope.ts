/**
 * Shared helpers for workflow memory visibility. The access mode is set by the
 * workflow author on the node; the workflow id and execution/node ids come from
 * the authoritative runtime context — never from model arguments.
 */
import type { MemoryVisibility } from "./manager";
import type { MemoryWriteVisibility } from "./atomic-operations";

export type MemoryAccessMode = "none" | "workflow" | "agent";

/**
 * Normalize a node's `memoryAccess` value. Absent normalizes to `agent` so
 * existing persisted workflows keep current behaviour; new nodes/templates set
 * the value explicitly (`workflow`).
 */
export function normalizeMemoryAccess(raw: unknown, fallback: MemoryAccessMode = "agent"): MemoryAccessMode {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "none" || value === "no-durable" || value === "no-durable-memory") return "none";
  if (value === "workflow" || value === "this-workflow") return "workflow";
  if (value === "agent" || value === "this-agent") return "agent";
  return fallback;
}

/** Build a search visibility from access mode + authoritative workflow id. */
export function buildSearchVisibility(mode: MemoryAccessMode, workflowId: string | null | undefined): MemoryVisibility {
  if (mode === "workflow") {
    return { kind: "workflow", workflowId: workflowId ?? null };
  }
  if (mode === "agent") {
    return { kind: "agent", workflowId: null };
  }
  return { kind: "none", workflowId: null };
}

/** Build a write visibility from access mode + authoritative runtime ids. */
export function buildWriteVisibility(
  mode: MemoryAccessMode,
  ctx: { workflowId?: string | null; executionId?: string | null; nodeId?: string | null },
): MemoryWriteVisibility | null {
  if (mode === "workflow") {
    return {
      kind: "workflow",
      id: ctx.workflowId ?? null,
      sourceExecutionId: ctx.executionId ?? null,
      sourceNodeId: ctx.nodeId ?? null,
    };
  }
  if (mode === "none") return null;
  return { kind: "agent", id: null };
}
