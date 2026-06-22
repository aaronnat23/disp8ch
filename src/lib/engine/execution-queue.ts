// Server-only — do not import in client components.
// Persisted FIFO execution queue for workflows that opt into queue-mode
// concurrency. Default workflow behavior (no concurrency config) stays
// skip-if-running; queue mode holds overflow starts in a durable table and
// drains them oldest-first as running slots free up.
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

const log = logger.child("engine:execution-queue");

export type WorkflowConcurrencyMode = "skip" | "queue";

export interface WorkflowConcurrencyConfig {
  mode: WorkflowConcurrencyMode;
  maxConcurrent: number;
}

export const DEFAULT_WORKFLOW_CONCURRENCY: WorkflowConcurrencyConfig = {
  mode: "skip",
  maxConcurrent: 1,
};

const MAX_CONCURRENT_LIMIT = 10;

export type QueuedExecutionStatus = "queued" | "started" | "done" | "failed";

export interface QueuedExecutionRecord {
  id: string;
  workflowId: string;
  triggerType: "message" | "webhook" | "manual" | "cron";
  triggerData: Record<string, unknown> | null;
  provenance: Record<string, unknown> | null;
  status: QueuedExecutionStatus;
  executionId: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

type QueueRow = {
  id: string;
  workflow_id: string;
  trigger_type: string;
  trigger_data: string | null;
  provenance: string | null;
  status: string;
  execution_id: string | null;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};

function safeJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function mapRow(row: QueueRow): QueuedExecutionRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    triggerType: (["message", "webhook", "manual", "cron"].includes(row.trigger_type)
      ? row.trigger_type
      : "manual") as QueuedExecutionRecord["triggerType"],
    triggerData: safeJson(row.trigger_data),
    provenance: safeJson(row.provenance),
    status: (["queued", "started", "done", "failed"].includes(row.status)
      ? row.status
      : "failed") as QueuedExecutionStatus,
    executionId: row.execution_id,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

/** Validates and clamps a user-supplied concurrency config; null means "use default skip behavior". */
export function normalizeWorkflowConcurrency(raw: unknown): WorkflowConcurrencyConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const mode = value.mode === "queue" ? "queue" : value.mode === "skip" ? "skip" : null;
  if (!mode) return null;
  const requested = Number(value.maxConcurrent);
  const maxConcurrent = Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_CONCURRENT_LIMIT, Math.floor(requested)))
    : 1;
  return { mode, maxConcurrent };
}

export function getWorkflowConcurrency(workflowId: string): WorkflowConcurrencyConfig {
  try {
    initializeDatabase();
    const db = getSqlite();
    const row = db.prepare("SELECT concurrency FROM workflows WHERE id = ?").get(workflowId) as
      | { concurrency: string | null }
      | undefined;
    return normalizeWorkflowConcurrency(safeJson(row?.concurrency ?? null)) ?? DEFAULT_WORKFLOW_CONCURRENCY;
  } catch (error) {
    log.warn("Failed to read workflow concurrency config", { workflowId, error: String(error) });
    return DEFAULT_WORKFLOW_CONCURRENCY;
  }
}

export function enqueueQueuedExecution(params: {
  workflowId: string;
  triggerType: QueuedExecutionRecord["triggerType"];
  triggerData: Record<string, unknown> | null;
  provenance: Record<string, unknown> | null;
}): QueuedExecutionRecord {
  initializeDatabase();
  const db = getSqlite();
  const id = `wq_${nanoid(10)}`;
  const enqueuedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO workflow_execution_queue
       (id, workflow_id, trigger_type, trigger_data, provenance, status, enqueued_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(
    id,
    params.workflowId,
    params.triggerType,
    JSON.stringify(params.triggerData ?? null),
    JSON.stringify(params.provenance ?? null),
    enqueuedAt,
  );
  log.info("Queued workflow execution", { workflowId: params.workflowId, queueId: id });
  return {
    id,
    workflowId: params.workflowId,
    triggerType: params.triggerType,
    triggerData: params.triggerData,
    provenance: params.provenance,
    status: "queued",
    executionId: null,
    enqueuedAt,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

export function listQueuedExecutions(options?: {
  workflowId?: string;
  status?: QueuedExecutionStatus | "all";
  limit?: number;
}): QueuedExecutionRecord[] {
  initializeDatabase();
  const db = getSqlite();
  const where: string[] = [];
  const values: unknown[] = [];
  if (options?.workflowId) {
    where.push("workflow_id = ?");
    values.push(options.workflowId);
  }
  const status = options?.status ?? "queued";
  if (status !== "all") {
    where.push("status = ?");
    values.push(status);
  }
  const limit = Math.max(1, Math.min(500, options?.limit ?? 100));
  const rows = db
    .prepare(
      `SELECT * FROM workflow_execution_queue
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY enqueued_at ASC
        LIMIT ?`,
    )
    .all(...values, limit) as QueueRow[];
  return rows.map(mapRow);
}

export function deleteQueuedExecution(id: string): boolean {
  initializeDatabase();
  const db = getSqlite();
  // Only pending items are deletable; started/done rows are history.
  const result = db
    .prepare("DELETE FROM workflow_execution_queue WHERE id = ? AND status = 'queued'")
    .run(id);
  return result.changes > 0;
}

function claimNextQueued(workflowId: string): QueuedExecutionRecord | null {
  const db = getSqlite();
  const row = db
    .prepare(
      `SELECT * FROM workflow_execution_queue
        WHERE workflow_id = ? AND status = 'queued'
        ORDER BY enqueued_at ASC
        LIMIT 1`,
    )
    .get(workflowId) as QueueRow | undefined;
  if (!row) return null;
  const claimed = db
    .prepare(
      "UPDATE workflow_execution_queue SET status = 'started', started_at = ? WHERE id = ? AND status = 'queued'",
    )
    .run(new Date().toISOString(), row.id);
  if (claimed.changes !== 1) return null;
  return mapRow({ ...row, status: "started" });
}

function markQueueItem(id: string, fields: { status?: QueuedExecutionStatus; executionId?: string; error?: string }) {
  try {
    const db = getSqlite();
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.status) {
      sets.push("status = ?");
      values.push(fields.status);
      if (fields.status === "done" || fields.status === "failed") {
        sets.push("finished_at = ?");
        values.push(new Date().toISOString());
      }
    }
    if (fields.executionId) {
      sets.push("execution_id = ?");
      values.push(fields.executionId);
    }
    if (fields.error !== undefined) {
      sets.push("error = ?");
      values.push(fields.error.slice(0, 800));
    }
    if (!sets.length) return;
    values.push(id);
    db.prepare(`UPDATE workflow_execution_queue SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  } catch (error) {
    log.warn("Failed to update queue item", { id, error: String(error) });
  }
}

// Per-process re-entrancy guard so completion-driven drains don't stack.
const drainingWorkflows = new Set<string>();

/**
 * Starts queued executions for a workflow until its maxConcurrent limit is
 * reached or the queue is empty. Safe to call from any completion path.
 */
export async function drainWorkflowQueue(workflowId: string): Promise<void> {
  if (drainingWorkflows.has(workflowId)) return;
  drainingWorkflows.add(workflowId);
  try {
    const concurrency = getWorkflowConcurrency(workflowId);
    if (concurrency.mode !== "queue") return;
    const { listRunningExecutions } = await import("./runtime-tracker");
    const running = listRunningExecutions().filter((item) => item.workflowId === workflowId).length;
    let slots = Math.max(0, concurrency.maxConcurrent - running);
    if (slots === 0) return;

    initializeDatabase();
    const db = getSqlite();
    const workflow = db
      .prepare("SELECT id, nodes, edges, is_active FROM workflows WHERE id = ?")
      .get(workflowId) as { id: string; nodes: string; edges: string; is_active: number } | undefined;

    while (slots > 0) {
      const item = claimNextQueued(workflowId);
      if (!item) break;
      if (!workflow || workflow.is_active === 0) {
        markQueueItem(item.id, {
          status: "failed",
          error: workflow ? "Workflow is inactive" : "Workflow not found",
        });
        continue;
      }
      slots -= 1;
      void startQueuedItem(item, workflow).catch((error) => {
        markQueueItem(item.id, { status: "failed", error: String(error) });
        log.warn("Queued execution failed to start", { queueId: item.id, error: String(error) });
      });
    }
  } catch (error) {
    log.warn("Queue drain failed", { workflowId, error: String(error) });
  } finally {
    drainingWorkflows.delete(workflowId);
  }
}

async function startQueuedItem(
  item: QueuedExecutionRecord,
  workflow: { id: string; nodes: string; edges: string },
): Promise<void> {
  const { executeWorkflow } = await import("./executor");
  const { getModelConfig } = await import("@/lib/agents/model-router");
  const { getPinnedDataForExecution } = await import("@/lib/workflows/pin-data");
  const result = await executeWorkflow({
    workflowId: workflow.id,
    nodes: JSON.parse(workflow.nodes),
    edges: JSON.parse(workflow.edges),
    triggerType: item.triggerType,
    triggerData: item.triggerData ?? {},
    provenance: { ...(item.provenance ?? {}), queuedExecutionId: item.id, concurrencyGuard: "fifo-queue" },
    modelConfig: getModelConfig(),
    pinnedData: getPinnedDataForExecution(workflow.id),
    onExecutionStart: (executionId) => markQueueItem(item.id, { executionId }),
    // The drain already accounted for the slot; never re-queue from inside a drain start.
    allowConcurrentWorkflowRuns: true,
  });
  markQueueItem(item.id, {
    status: result.status === "failed" ? "failed" : "done",
    executionId: result.id,
    error: result.error ?? undefined,
  });
}

/**
 * Boot recovery: 'started' rows whose execution never reached the executions
 * table belong to a process that died mid-run — put them back in the queue.
 * Returns workflow ids that still have queued work so the caller can drain.
 */
export function recoverExecutionQueueOnBoot(): { requeued: number; workflowIds: string[] } {
  initializeDatabase();
  const db = getSqlite();
  const stale = db
    .prepare("SELECT * FROM workflow_execution_queue WHERE status = 'started'")
    .all() as QueueRow[];
  let requeued = 0;
  for (const row of stale) {
    const execution = row.execution_id
      ? (db.prepare("SELECT status FROM executions WHERE id = ?").get(row.execution_id) as
          | { status: string }
          | undefined)
      : undefined;
    if (execution && execution.status !== "running") {
      markQueueItem(row.id, { status: execution.status === "failed" ? "failed" : "done" });
      continue;
    }
    db.prepare(
      "UPDATE workflow_execution_queue SET status = 'queued', execution_id = NULL, started_at = NULL WHERE id = ?",
    ).run(row.id);
    requeued += 1;
  }
  const pending = db
    .prepare("SELECT DISTINCT workflow_id FROM workflow_execution_queue WHERE status = 'queued'")
    .all() as Array<{ workflow_id: string }>;
  if (requeued > 0) log.info("Recovered stale queued executions", { requeued });
  return { requeued, workflowIds: pending.map((row) => row.workflow_id) };
}
