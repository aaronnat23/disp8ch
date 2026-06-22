import { getMemorySearchManager, type RuntimeStatus } from "@/lib/memory/manager";
import { getSqliteVecStatus } from "@/lib/memory/sqlite-vec";

export type MemoryCoreStatus = {
  status: "ready" | "degraded";
  mode: "hybrid" | "fts5-only";
  active: { provider: string; modelId: string } | null;
  configured: string;
  vectorIndexed: number;
  sessionChunks: number;
  collectionChunks: number;
  vectorBackend: ReturnType<typeof getSqliteVecStatus>;
  issues: string[];
  runtime: RuntimeStatus;
};

export async function getMemoryCoreStatus(agentId = "default", workspacePath?: string): Promise<MemoryCoreStatus> {
  const manager = getMemorySearchManager(agentId, workspacePath);
  const status = await manager.getStatus();
  const vectorBackend = getSqliteVecStatus();
  const issues: string[] = [];

  if (!status.active) issues.push("No embedding provider is available; memory search will use text search only.");
  if (!vectorBackend.available || !vectorBackend.loaded) issues.push("sqlite-vec is unavailable; vector search is disabled.");

  return {
    status: issues.length > 0 ? "degraded" : "ready",
    mode: status.mode,
    active: status.active,
    configured: status.configured,
    vectorIndexed: status.vectorIndexed,
    sessionChunks: status.sessionChunks,
    collectionChunks: status.collectionChunks,
    vectorBackend,
    issues,
    runtime: status.runtime,
  };
}
