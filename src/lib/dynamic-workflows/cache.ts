import crypto from "node:crypto";
import { getSqlite, withSqliteWriteRecovery } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import type {
  DynamicWorkflowWorkerRecord,
  DynamicWorkflowWorkerResult,
} from "./types";

const log = logger.child("dynamic-workflows:cache");

const DEFAULT_CACHE_TTL_HOURS = 2;

let cacheTableEnsured = false;

function ensureCacheTable(): void {
  if (cacheTableEnsured) return;
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS dynamic_workflow_cache (
      cache_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dw_cache_run ON dynamic_workflow_cache(run_id);
    CREATE INDEX IF NOT EXISTS idx_dw_cache_phase ON dynamic_workflow_cache(run_id, phase_id);
    CREATE INDEX IF NOT EXISTS idx_dw_cache_worker ON dynamic_workflow_cache(run_id, worker_id);
  `);
  cacheTableEnsured = true;
}

export function computeCacheKey(
  worker: Pick<DynamicWorkflowWorkerRecord, "prompt" | "modelRef" | "agentKind">,
): string {
  const canonical = JSON.stringify({
    prompt: worker.prompt,
    modelRef: worker.modelRef ?? "",
    agentKind: worker.agentKind ?? "",
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function getCachedResult(
  runId: string,
  phaseId: string,
  worker: Pick<DynamicWorkflowWorkerRecord, "prompt" | "modelRef" | "agentKind">,
): DynamicWorkflowWorkerResult | null {
  ensureCacheTable();
  const cacheKey = computeCacheKey(worker);
  const db = getSqlite();
  const row = db.prepare(`
    SELECT result_json, expires_at
    FROM dynamic_workflow_cache
    WHERE cache_key = ? AND run_id = ? AND expires_at > ?
    LIMIT 1
  `).get(cacheKey, runId, new Date().toISOString()) as
    { result_json: string; expires_at: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.result_json) as DynamicWorkflowWorkerResult;
  } catch {
    log.warn("Failed to parse cached result", { cacheKey });
    return null;
  }
}

export function setCachedResult(
  runId: string,
  phaseId: string,
  workerId: string,
  cacheKey: string,
  result: DynamicWorkflowWorkerResult,
): void {
  ensureCacheTable();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEFAULT_CACHE_TTL_HOURS * 60 * 60 * 1000);
  withSqliteWriteRecovery("dynamic-workflow-cache:set", (db) => {
    db.prepare(`
      INSERT OR REPLACE INTO dynamic_workflow_cache
        (cache_key, run_id, phase_id, worker_id, result_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(cacheKey, runId, phaseId, workerId, JSON.stringify(result), now.toISOString(), expiresAt.toISOString());
  });
}

export function invalidateWorkerCache(runId: string, workerId: string): void {
  ensureCacheTable();
  withSqliteWriteRecovery("dynamic-workflow-cache:invalidate-worker", (db) => {
    db.prepare(`
      DELETE FROM dynamic_workflow_cache
      WHERE run_id = ? AND worker_id = ?
    `).run(runId, workerId);
  });
}

export function invalidatePhaseCache(runId: string, phaseId: string): void {
  ensureCacheTable();
  withSqliteWriteRecovery("dynamic-workflow-cache:invalidate-phase", (db) => {
    db.prepare(`
      DELETE FROM dynamic_workflow_cache
      WHERE run_id = ? AND phase_id = ?
    `).run(runId, phaseId);
  });
}

export function invalidateRunCache(runId: string): void {
  ensureCacheTable();
  withSqliteWriteRecovery("dynamic-workflow-cache:invalidate-run", (db) => {
    db.prepare(`
      DELETE FROM dynamic_workflow_cache
      WHERE run_id = ?
    `).run(runId);
  });
}
