import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { redactSecretsDeep } from "@/lib/workflows/secret-redaction";
import type { NodeResult } from "@/types/execution";
import type { WorkflowNode } from "@/types/workflow";

export type WorkflowExecutionNodeTrace = {
  id: string;
  executionId: string;
  workflowId: string;
  nodeId: string;
  nodeName: string | null;
  nodeType: string;
  status: "completed" | "failed" | "skipped";
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  durationMs: number | null;
  costUsd: number;
  tokenCount: number;
  startedAt: string | null;
  completedAt: string | null;
};

type TraceRow = {
  id: string;
  execution_id: string;
  workflow_id: string;
  node_id: string;
  node_name: string | null;
  node_type: string;
  status: string;
  input_json: string | null;
  output_json: string | null;
  error_json: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
  token_count: number | null;
  started_at: string | null;
  completed_at: string | null;
};

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { value: raw };
  }
}

function mapTrace(row: TraceRow): WorkflowExecutionNodeTrace {
  return {
    id: row.id,
    executionId: row.execution_id,
    workflowId: row.workflow_id,
    nodeId: row.node_id,
    nodeName: row.node_name,
    nodeType: row.node_type,
    status: (row.status as WorkflowExecutionNodeTrace["status"]) ?? "completed",
    input: parseJsonObject(row.input_json),
    output: parseJsonObject(row.output_json),
    error: parseJsonObject(row.error_json),
    durationMs: row.duration_ms,
    costUsd: row.cost_usd ?? 0,
    tokenCount: row.token_count ?? 0,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function summarizeTokens(output: Record<string, unknown> | null): number {
  const usage = output?.usage;
  if (usage && typeof usage === "object") {
    const record = usage as Record<string, unknown>;
    const total = Number(record.totalTokens ?? record.total_tokens ?? record.tokens ?? 0);
    if (Number.isFinite(total) && total > 0) return Math.round(total);
  }
  const tokenCount = Number(output?.tokenCount ?? output?.tokens ?? 0);
  return Number.isFinite(tokenCount) && tokenCount > 0 ? Math.round(tokenCount) : 0;
}

function summarizeCost(output: Record<string, unknown> | null): number {
  const raw = Number(output?.costUsd ?? output?.cost_usd ?? output?.cost ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function recordWorkflowExecutionNodeTraces(input: {
  executionId: string;
  workflowId: string;
  nodes: WorkflowNode[];
  nodeResults: Record<string, NodeResult>;
  startedAt: string;
  completedAt: string | null;
}) {
  initializeDatabase();
  const db = getSqlite();
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const completedAt = input.completedAt ?? new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM workflow_execution_node_traces WHERE execution_id = ?").run(input.executionId);
    const insert = db.prepare(`
      INSERT INTO workflow_execution_node_traces (
        id, execution_id, workflow_id, node_id, node_name, node_type, status,
        input_json, output_json, error_json, duration_ms, cost_usd, token_count, started_at, completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [nodeId, result] of Object.entries(input.nodeResults ?? {})) {
      const baseNodeId = nodeId.includes(".loop.") ? nodeId.split(".loop.")[0] : nodeId;
      const node = nodesById.get(baseNodeId);
      const output = redactSecretsDeep(result.output ?? {});
      const error = result.error ? { message: result.error } : null;
      insert.run(
        nanoid(12),
        input.executionId,
        input.workflowId,
        nodeId,
        String(node?.data?.label || node?.id || nodeId),
        node?.type ?? "unknown",
        result.error ? "failed" : "completed",
        null,
        JSON.stringify(output),
        error ? JSON.stringify(redactSecretsDeep(error)) : null,
        Math.max(0, Math.round(Number(result.duration ?? 0))),
        summarizeCost(output),
        summarizeTokens(output),
        input.startedAt,
        completedAt,
      );
    }
  });
  tx();
}

export function listWorkflowExecutionNodeTraces(executionId: string): WorkflowExecutionNodeTrace[] {
  initializeDatabase();
  const db = getSqlite();
  return (
    db
      .prepare("SELECT * FROM workflow_execution_node_traces WHERE execution_id = ? ORDER BY completed_at ASC, rowid ASC")
      .all(executionId) as TraceRow[]
  ).map(mapTrace);
}

export function getWorkflowExecutionTraceSummary(input: {
  executionId?: string | null;
  workflowId?: string | null;
  limit?: number;
}) {
  initializeDatabase();
  const db = getSqlite();
  const limit = Math.max(1, Math.min(100, input.limit ?? 20));
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.executionId) {
    where.push("execution_id = ?");
    params.push(input.executionId);
  }
  if (input.workflowId) {
    where.push("workflow_id = ?");
    params.push(input.workflowId);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const traces = (
    db
      .prepare(`SELECT * FROM workflow_execution_node_traces ${clause} ORDER BY completed_at DESC, rowid DESC LIMIT ?`)
      .all(...params, limit) as TraceRow[]
  ).map(mapTrace);
  const failed = traces.filter((trace) => trace.status === "failed");
  const totalDurationMs = traces.reduce((sum, trace) => sum + (trace.durationMs ?? 0), 0);
  const totalCostUsd = traces.reduce((sum, trace) => sum + trace.costUsd, 0);
  const totalTokens = traces.reduce((sum, trace) => sum + trace.tokenCount, 0);
  return {
    traces,
    totals: {
      nodeCount: traces.length,
      failedCount: failed.length,
      totalDurationMs,
      totalCostUsd,
      totalTokens,
    },
    bottlenecks: [...traces].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 5),
    failures: failed.slice(0, 10),
  };
}
