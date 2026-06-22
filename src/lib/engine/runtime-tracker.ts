import type { ExecutionRecord } from "@/types/execution";
import { getSqlite, initializeDatabase } from "@/lib/db";
import type { WorkflowExecutionLane } from "@/lib/engine/execution-lanes";

type RunningExecution = {
  executionId: string;
  workflowId: string;
  triggerType: ExecutionRecord["triggerType"];
  lane: WorkflowExecutionLane;
  startedAt: string;
  activeNodeId: string | null;
  completedNodes: number;
  totalNodes: number;
};

const CONTROLLERS_SYMBOL = Symbol.for("disp8ch.executionControllers");

function getExecutionControllers(): Map<string, AbortController> {
  const globalState = globalThis as typeof globalThis & {
    [CONTROLLERS_SYMBOL]?: Map<string, AbortController>;
  };
  if (!globalState[CONTROLLERS_SYMBOL]) {
    globalState[CONTROLLERS_SYMBOL] = new Map<string, AbortController>();
  }
  return globalState[CONTROLLERS_SYMBOL]!;
}

function ensureRunningExecutionsTable() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS running_executions (
      execution_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      lane TEXT NOT NULL DEFAULT 'main',
      started_at TEXT NOT NULL,
      active_node_id TEXT,
      completed_nodes INTEGER NOT NULL DEFAULT 0,
      total_nodes INTEGER NOT NULL DEFAULT 0
    )
  `);
  const cols = db.prepare("PRAGMA table_info(running_executions)").all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === "lane")) {
    db.exec("ALTER TABLE running_executions ADD COLUMN lane TEXT NOT NULL DEFAULT 'main'");
  }
  return db;
}

function cleanupStaleRows() {
  const db = ensureRunningExecutionsTable();
  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM running_executions WHERE started_at < ?").run(cutoff);
}

export function startRunningExecution(entry: RunningExecution) {
  const db = ensureRunningExecutionsTable();
  db.prepare(`
    INSERT INTO running_executions
      (execution_id, workflow_id, trigger_type, lane, started_at, active_node_id, completed_nodes, total_nodes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(execution_id) DO UPDATE SET
      workflow_id = excluded.workflow_id,
      trigger_type = excluded.trigger_type,
      lane = excluded.lane,
      started_at = excluded.started_at,
      active_node_id = excluded.active_node_id,
      completed_nodes = excluded.completed_nodes,
      total_nodes = excluded.total_nodes
  `).run(
    entry.executionId,
    entry.workflowId,
    entry.triggerType,
    entry.lane,
    entry.startedAt,
    entry.activeNodeId,
    entry.completedNodes,
    entry.totalNodes
  );
}

export function registerRunningExecutionController(executionId: string, controller: AbortController) {
  getExecutionControllers().set(executionId, controller);
}

export function markRunningExecutionNodeStart(executionId: string, nodeId: string) {
  const db = ensureRunningExecutionsTable();
  db.prepare("UPDATE running_executions SET active_node_id = ? WHERE execution_id = ?")
    .run(nodeId, executionId);
}

export function markRunningExecutionNodeComplete(executionId: string) {
  const db = ensureRunningExecutionsTable();
  db.prepare(`
    UPDATE running_executions
    SET completed_nodes = CASE
      WHEN completed_nodes < total_nodes THEN completed_nodes + 1
      ELSE total_nodes
    END
    WHERE execution_id = ?
  `).run(executionId);
}

export function finishRunningExecution(executionId: string) {
  getExecutionControllers().delete(executionId);
  const db = ensureRunningExecutionsTable();
  db.prepare("DELETE FROM running_executions WHERE execution_id = ?").run(executionId);
}

export function abortRunningExecution(executionId: string): boolean {
  const controller = getExecutionControllers().get(executionId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function listRunningExecutions() {
  cleanupStaleRows();
  const db = ensureRunningExecutionsTable();
  const rows = db.prepare(
    "SELECT * FROM running_executions ORDER BY started_at DESC"
  ).all() as Array<{
    execution_id: string;
    workflow_id: string;
    trigger_type: ExecutionRecord["triggerType"];
    lane: WorkflowExecutionLane;
    started_at: string;
    active_node_id: string | null;
    completed_nodes: number;
    total_nodes: number;
  }>;

  return rows.map((row) => ({
    executionId: row.execution_id,
    workflowId: row.workflow_id,
    triggerType: row.trigger_type,
    lane: row.lane,
    startedAt: row.started_at,
    activeNodeId: row.active_node_id,
    completedNodes: row.completed_nodes,
    totalNodes: row.total_nodes,
  }));
}
