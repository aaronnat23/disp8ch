import crypto from "node:crypto";
import { getSqlite, withSqliteWriteRecovery } from "@/lib/db";
import type { MCPApprovalMode, MCPServerConfig } from "@/lib/mcp/client";

// ---------------------------------------------------------------------------
// In-memory active approval queue
// ---------------------------------------------------------------------------

interface McpApprovalRequest {
  approvalId: string;
  runId: string;
  workerId: string;
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  status: "pending" | "approved" | "denied";
  resolvedAt: string | null;
  reason: string | null;
  createdAt: string;
}

const pendingByApprovalId = new Map<string, McpApprovalRequest>();
const pendingByRunId = new Map<string, Set<string>>();
const pausedWorkers = new Map<string, Set<string>>(); // runId -> Set<workerId>

function nowIso(): string {
  return new Date().toISOString();
}

// Lazy resolve createEvent to avoid circular import with store.ts during
// ensureDynamicWorkflowTables → ensureMcpApprovalTables startup.
function emitApprovalEvent(event: {
  id: string;
  runId: string;
  workerId?: string;
  eventType: string;
  title: string;
  detail: string;
  payloadJson: string;
  createdAt: string;
}): void {
  try {
    const { createEvent } = require("@/lib/dynamic-workflows/store");
    createEvent({
      id: event.id,
      runId: event.runId,
      workerId: event.workerId ?? null,
      phaseId: null,
      eventType: event.eventType,
      title: event.title,
      detail: event.detail,
      payloadJson: event.payloadJson,
      createdAt: event.createdAt,
    });
  } catch {
    // Best-effort event emission; drop on circular-import edge case.
  }
}

// ---------------------------------------------------------------------------
// Table creation
// ---------------------------------------------------------------------------

export function ensureMcpApprovalTables(): void {
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_approval_requests (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      server_name TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_args_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_at TEXT,
      resolution_reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_approval_requests_run ON mcp_approval_requests(run_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_approval_requests_status ON mcp_approval_requests(status);
  `);
}

// ---------------------------------------------------------------------------
// Reads from SQLite for durability
// ---------------------------------------------------------------------------

function loadPendingApproval(approvalId: string): McpApprovalRequest | undefined {
  ensureMcpApprovalTables();
  const row = getSqlite()
    .prepare("SELECT * FROM mcp_approval_requests WHERE id = ?")
    .get(approvalId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  let toolArgs: Record<string, unknown> = {};
  try {
    toolArgs = JSON.parse(row.tool_args_json as string);
  } catch {
    /* keep empty */
  }
  return {
    approvalId: row.id as string,
    runId: row.run_id as string,
    workerId: row.worker_id as string,
    serverName: row.server_name as string,
    toolName: row.tool_name as string,
    toolArgs,
    status: row.status as McpApprovalRequest["status"],
    resolvedAt: (row.resolved_at as string) ?? null,
    reason: (row.resolution_reason as string) ?? null,
    createdAt: row.created_at as string,
  };
}

function loadPendingApprovalsForRun(runId: string): McpApprovalRequest[] {
  ensureMcpApprovalTables();
  const rows = getSqlite()
    .prepare(
      "SELECT * FROM mcp_approval_requests WHERE run_id = ? AND status = 'pending' ORDER BY created_at ASC",
    )
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    let toolArgs: Record<string, unknown> = {};
    try {
      toolArgs = JSON.parse(row.tool_args_json as string);
    } catch {
      /* keep empty */
    }
    return {
      approvalId: row.id as string,
      runId: row.run_id as string,
      workerId: row.worker_id as string,
      serverName: row.server_name as string,
      toolName: row.tool_name as string,
      toolArgs,
      status: row.status as McpApprovalRequest["status"],
      resolvedAt: (row.resolved_at as string) ?? null,
      reason: (row.resolution_reason as string) ?? null,
      createdAt: row.created_at as string,
    };
  });
}

// ---------------------------------------------------------------------------
// MCP server config helpers
// ---------------------------------------------------------------------------

function readConfiguredMcpServers(): MCPServerConfig[] {
  try {
    const row = getSqlite()
      .prepare("SELECT mcp_servers FROM app_config WHERE id = 'default'")
      .get() as { mcp_servers?: string } | undefined;
    if (!row?.mcp_servers) return [];
    const parsed = JSON.parse(row.mcp_servers);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry: unknown): entry is MCPServerConfig =>
        Boolean(entry) && typeof entry === "object" && entry !== null,
    );
  } catch {
    return [];
  }
}

function getMcpServerConfig(serverName: string): MCPServerConfig | undefined {
  const configs = readConfiguredMcpServers();
  return configs.find((c) => c.name === serverName);
}

/**
 * Check if an MCP tool call needs approval.
 *
 * Conservative: returns false if no MCP server config is available.
 * For P1, returns true only when the server's default or per-tool approval
 * mode is explicitly "human" or "model" (not "off").
 */
export function needsMcpApproval(serverName: string, toolName: string): boolean {
  const config = getMcpServerConfig(serverName);
  if (!config) return false;

  const approvedModes = new Set<MCPApprovalMode | undefined>(["human", "model"]);
  const perToolMode = config.tools?.policies?.[toolName]?.approvalMode;
  if (perToolMode && approvedModes.has(perToolMode)) return true;

  if (config.defaultApprovalMode && approvedModes.has(config.defaultApprovalMode)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Core approval lifecycle
// ---------------------------------------------------------------------------

/**
 * Create an approval request for a worker's MCP tool call.
 * Stores durably in SQLite and queues in the in-memory map.
 */
export function createMcpApprovalRequest(
  runId: string,
  workerId: string,
  serverName: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): { approvalId: string; queued: boolean } {
  ensureMcpApprovalTables();
  const approvalId = crypto.randomUUID();
  const createdAt = nowIso();

  withSqliteWriteRecovery("mcp-approval:create", (db) => {
    db.prepare(`
      INSERT INTO mcp_approval_requests (
        id, run_id, worker_id, server_name, tool_name,
        tool_args_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(approvalId, runId, workerId, serverName, toolName, JSON.stringify(toolArgs), createdAt);
  });

  const request: McpApprovalRequest = {
    approvalId,
    runId,
    workerId,
    serverName,
    toolName,
    toolArgs,
    status: "pending",
    resolvedAt: null,
    reason: null,
    createdAt,
  };

  pendingByApprovalId.set(approvalId, request);

  let runSet = pendingByRunId.get(runId);
  if (!runSet) {
    runSet = new Set();
    pendingByRunId.set(runId, runSet);
  }
  runSet.add(approvalId);

  emitApprovalEvent({
    id: crypto.randomUUID(),
    runId,
    workerId,
    eventType: "mcp.approval.requested",
    title: `MCP approval requested: ${serverName}/${toolName}`,
    detail: `Worker ${workerId} requires approval for MCP tool "${toolName}" on server "${serverName}".`,
    payloadJson: JSON.stringify({ serverName, toolName, toolArgs, approvalId }),
    createdAt,
  });

  return { approvalId, queued: true };
}

/**
 * Check the current status of an MCP approval request.
 */
export function getMcpApprovalStatus(approvalId: string): {
  status: "pending" | "approved" | "denied";
  resolvedAt?: string;
  reason?: string;
} {
  const cached = pendingByApprovalId.get(approvalId);
  if (cached) {
    return {
      status: cached.status,
      resolvedAt: cached.resolvedAt ?? undefined,
      reason: cached.reason ?? undefined,
    };
  }

  const row = loadPendingApproval(approvalId);
  if (!row) return { status: "pending" };

  return {
    status: row.status,
    resolvedAt: row.resolvedAt ?? undefined,
    reason: row.reason ?? undefined,
  };
}

/**
 * Resolve an MCP approval (approve or deny).
 * Updates both the in-memory map and the SQLite table.
 * Returns true if the approval was found and resolved.
 */
export function resolveMcpApproval(
  approvalId: string,
  decision: "approved" | "denied",
  reason?: string,
): boolean {
  ensureMcpApprovalTables();
  const resolvedAt = nowIso();

  const cached = pendingByApprovalId.get(approvalId);
  let row = cached;

  if (!row) {
    const loaded = loadPendingApproval(approvalId);
    if (!loaded) return false;
    row = loaded;
  }

  if (row.status !== "pending") return false;

  withSqliteWriteRecovery("mcp-approval:resolve", (db) => {
    db.prepare(`
      UPDATE mcp_approval_requests
      SET status = ?, resolved_at = ?, resolution_reason = ?
      WHERE id = ?
    `).run(decision, resolvedAt, reason ?? null, approvalId);
  });

  row.status = decision;
  row.resolvedAt = resolvedAt;
  row.reason = reason ?? null;
  pendingByApprovalId.set(approvalId, row);

  const runSet = pendingByRunId.get(row.runId);
  if (runSet) {
    runSet.delete(approvalId);
    if (runSet.size === 0) pendingByRunId.delete(row.runId);
  }

  const eventType = decision === "approved" ? "mcp.approval.granted" : "mcp.approval.denied";
  emitApprovalEvent({
    id: crypto.randomUUID(),
    runId: row.runId,
    workerId: row.workerId,
    eventType,
    title: `MCP approval ${decision}: ${row.serverName}/${row.toolName}`,
    detail: reason
      ? `Approval ${decision} for "${row.toolName}" on "${row.serverName}". Reason: ${reason}`
      : `Approval ${decision} for "${row.toolName}" on "${row.serverName}".`,
    payloadJson: JSON.stringify({ serverName: row.serverName, toolName: row.toolName, approvalId, decision, reason }),
    createdAt: resolvedAt,
  });

  return true;
}

/**
 * Get all pending approvals for a run.
 * Merges in-memory records with durable SQLite records.
 */
export function getPendingApprovalsForRun(runId: string): Array<{
  approvalId: string;
  workerId: string;
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  createdAt: string;
}> {
  const rows = loadPendingApprovalsForRun(runId);

  for (const row of rows) {
    if (!pendingByApprovalId.has(row.approvalId)) {
      pendingByApprovalId.set(row.approvalId, row);
      let runSet = pendingByRunId.get(runId);
      if (!runSet) {
        runSet = new Set();
        pendingByRunId.set(runId, runSet);
      }
      runSet.add(row.approvalId);
    }
  }

  return rows.map((r) => ({
    approvalId: r.approvalId,
    workerId: r.workerId,
    serverName: r.serverName,
    toolName: r.toolName,
    toolArgs: r.toolArgs,
    createdAt: r.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Worker pause / resume for MCP approval
// ---------------------------------------------------------------------------

/**
 * Pause a worker pending MCP approval.
 * The worker stays logically "running" but the approval gate prevents further
 * tool calls until the approval is resolved.
 */
export function pauseWorkerForMcpApproval(
  runId: string,
  workerId: string,
  approvalId: string,
): void {
  let runWorkers = pausedWorkers.get(runId);
  if (!runWorkers) {
    runWorkers = new Set();
    pausedWorkers.set(runId, runWorkers);
  }
  runWorkers.add(workerId);
}

/**
 * Resume a worker after MCP approval has been resolved.
 * Returns true if the worker was paused and is now resumed.
 */
export function resumeWorkerAfterMcpApproval(
  runId: string,
  workerId: string,
  approvalId: string,
): boolean {
  const approval = getMcpApprovalStatus(approvalId);
  if (approval.status === "pending") return false;

  const runWorkers = pausedWorkers.get(runId);
  if (!runWorkers || !runWorkers.has(workerId)) return false;

  runWorkers.delete(workerId);
  if (runWorkers.size === 0) pausedWorkers.delete(runId);

  return true;
}

/**
 * Check whether a specific worker is currently paused for MCP approval.
 * Useful for the worker executor to poll while waiting.
 */
export function isWorkerPausedForMcpApproval(runId: string, workerId: string): boolean {
  const runWorkers = pausedWorkers.get(runId);
  return runWorkers ? runWorkers.has(workerId) : false;
}

/**
 * Get all worker IDs currently paused for MCP approval within a run.
 */
export function getPausedWorkerIds(runId: string): string[] {
  const runWorkers = pausedWorkers.get(runId);
  return runWorkers ? [...runWorkers] : [];
}
