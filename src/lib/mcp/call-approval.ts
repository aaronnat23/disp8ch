import crypto from "node:crypto";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { recordTelemetryEvent } from "@/lib/telemetry";
import type { MCPApprovalMode } from "@/lib/mcp/client";

/**
 * Durable approval for a SINGLE direct (WebChat) MCP tool call.
 *
 * Distinct from the dynamic-workflow MCP approval (which is keyed by run/worker).
 * This captures the exact agent + session + server + tool + arguments so a human
 * can approve it once. Key safety properties:
 *
 *  - Approval is one-time. Executing consumes it; it never grants standing
 *    capability or edits the agent's allowlist/policy.
 *  - Scope + policy are re-checked AFTER approval, immediately before execution,
 *    so an agent can never auto-expand its own scope between request and approve.
 *  - Execution is idempotent: the pending row is atomically claimed, so a double
 *    approve cannot run the captured call twice.
 *  - The result is delivered back to the originating session and an audit record
 *    is written to telemetry/Activity.
 */

export type McpCallApprovalStatus =
  | "pending"
  | "denied"
  | "executed"
  | "failed"
  | "scope_revoked";

export type McpCallApprovalRecord = {
  id: string;
  agentId: string;
  sessionId: string | null;
  channel: string;
  serverName: string;
  toolName: string;
  argsRedacted: Record<string, unknown>;
  argsHash: string;
  approvalMode: MCPApprovalMode;
  status: McpCallApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
  executedAt: string | null;
  resultPreview: string | null;
  error: string | null;
  reason: string | null;
  decidedBy: string | null;
  reasoning: string | null;
};

const SENSITIVE_KEY_RE = /(token|secret|password|passwd|api[-_]?key|authorization|auth|credential|cookie|session|bearer|private[-_]?key)/i;

/**
 * Redact secret-looking argument values and clamp size, for display in the
 * approval surface. The full arguments are stored separately for execution only.
 */
export function redactMcpArgs(args: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value) && depth < 3) {
      out[key] = redactMcpArgs(value as Record<string, unknown>, depth + 1);
    } else if (typeof value === "string") {
      out[key] = value.length > 300 ? `${value.slice(0, 300)}…` : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Stable hash of the exact arguments, for integrity/audit. */
export function hashMcpArgs(args: Record<string, unknown>): string {
  const stable = JSON.stringify(args, Object.keys(flatten(args)).sort());
  return crypto.createHash("sha256").update(stable || "{}").digest("hex");
}

function flatten(obj: unknown, prefix = "", acc: Record<string, true> = {}): Record<string, true> {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      acc[`${prefix}${k}`] = true;
      flatten(v, `${prefix}${k}.`, acc);
    }
  }
  return acc;
}

export function ensureMcpCallApprovalTable(): void {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_call_approvals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      channel TEXT NOT NULL DEFAULT 'webchat',
      server_name TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_args_json TEXT NOT NULL,
      args_redacted_json TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      executed_at TEXT,
      result_preview TEXT,
      error TEXT,
      reason TEXT,
      decided_by TEXT,
      reasoning TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_call_approvals_status ON mcp_call_approvals(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mcp_call_approvals_session ON mcp_call_approvals(session_id);
  `);
  // Additive columns for DBs created before the guardian (model approval mode).
  for (const col of ["decided_by TEXT", "reasoning TEXT"]) {
    try {
      db.exec(`ALTER TABLE mcp_call_approvals ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
}

function mapRow(row: Record<string, unknown>): McpCallApprovalRecord {
  const parse = (v: unknown) => {
    try {
      return JSON.parse(String(v ?? "{}")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    sessionId: (row.session_id as string) ?? null,
    channel: row.channel as string,
    serverName: row.server_name as string,
    toolName: row.tool_name as string,
    argsRedacted: parse(row.args_redacted_json),
    argsHash: row.args_hash as string,
    approvalMode: row.approval_mode as MCPApprovalMode,
    status: row.status as McpCallApprovalStatus,
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string) ?? null,
    executedAt: (row.executed_at as string) ?? null,
    resultPreview: (row.result_preview as string) ?? null,
    error: (row.error as string) ?? null,
    reason: (row.reason as string) ?? null,
    decidedBy: (row.decided_by as string) ?? null,
    reasoning: (row.reasoning as string) ?? null,
  };
}

export function createMcpCallApproval(params: {
  agentId: string;
  sessionId?: string | null;
  channel?: string;
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  approvalMode: MCPApprovalMode;
  reasoning?: string;
}): McpCallApprovalRecord {
  ensureMcpCallApprovalTable();
  const id = `mcpapp_${crypto.randomBytes(8).toString("hex")}`;
  const createdAt = new Date().toISOString();
  const redacted = redactMcpArgs(params.toolArgs ?? {});
  const argsHash = hashMcpArgs(params.toolArgs ?? {});
  const channel = params.channel || "webchat";

  withSqliteWriteRecovery("mcp-call-approval:create", (db) => {
    db.prepare(`
      INSERT INTO mcp_call_approvals (
        id, agent_id, session_id, channel, server_name, tool_name,
        tool_args_json, args_redacted_json, args_hash, approval_mode, status, created_at, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id,
      params.agentId,
      params.sessionId ?? null,
      channel,
      params.serverName,
      params.toolName,
      JSON.stringify(params.toolArgs ?? {}),
      JSON.stringify(redacted),
      argsHash,
      params.approvalMode,
      createdAt,
      params.reasoning ?? null,
    );
  });

  recordTelemetryEvent("mcp.call.approval_requested", {
    id,
    agentId: params.agentId,
    sessionId: params.sessionId ?? null,
    serverName: params.serverName,
    toolName: params.toolName,
    approvalMode: params.approvalMode,
    argsHash,
  });

  return mapRow(
    getSqlite().prepare("SELECT * FROM mcp_call_approvals WHERE id = ?").get(id) as Record<string, unknown>,
  );
}

export function getMcpCallApproval(id: string): McpCallApprovalRecord | null {
  ensureMcpCallApprovalTable();
  const row = getSqlite().prepare("SELECT * FROM mcp_call_approvals WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapRow(row) : null;
}

export function listPendingMcpCallApprovals(): McpCallApprovalRecord[] {
  ensureMcpCallApprovalTable();
  const rows = getSqlite()
    .prepare("SELECT * FROM mcp_call_approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50")
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

/** Hooks injected for testing (default to the real registry + transcript). */
export type ResolveDeps = {
  evaluateAccess?: (serverName: string, toolName: string, ctx: { agentId?: string }) => {
    allowed: boolean;
    reason?: string;
    approvalMode: MCPApprovalMode;
  };
  execute?: (serverName: string, toolName: string, args: Record<string, unknown>, ctx: { agentId?: string }) => Promise<unknown>;
  deliver?: (record: McpCallApprovalRecord, content: string) => void;
};

async function defaultEvaluateAccess(serverName: string, toolName: string, ctx: { agentId?: string }) {
  const { evaluateMcpToolAccess } = await import("@/lib/mcp/registry");
  return evaluateMcpToolAccess(serverName, toolName, ctx);
}

async function defaultExecute(serverName: string, toolName: string, args: Record<string, unknown>, ctx: { agentId?: string }) {
  const { executeMCPTool } = await import("@/lib/mcp/registry");
  return executeMCPTool(serverName, toolName, args, ctx);
}

function defaultDeliver(record: McpCallApprovalRecord, content: string): void {
  if (!record.sessionId) return;
  try {
    const { persistChannelMessage } = require("@/lib/channels/transcript");
    persistChannelMessage({
      sessionId: record.sessionId,
      role: "system",
      content,
      agentId: record.agentId,
      metadata: { eventType: "mcp-approval-result", approvalId: record.id, serverName: record.serverName, toolName: record.toolName },
    });
  } catch {
    /* best-effort delivery */
  }
}

function truncatePreview(value: string): string {
  return value.length > 600 ? `${value.slice(0, 600)}…` : value;
}

/**
 * Approve or deny a pending MCP call. On approval the captured call is
 * re-validated and executed exactly once, the result is delivered to the
 * originating session, and an audit event is recorded.
 */
export async function resolveMcpCallApproval(
  id: string,
  decision: "approve" | "deny",
  reason: string | undefined,
  deps: ResolveDeps = {},
  meta: { decidedBy?: string; deliver?: boolean } = {},
): Promise<{ ok: boolean; status: McpCallApprovalStatus | "missing" | "already_resolved"; result?: string; error?: string }> {
  ensureMcpCallApprovalTable();
  const decidedBy = meta.decidedBy ?? "human";
  const shouldDeliver = meta.deliver !== false;
  const existing = getMcpCallApproval(id);
  if (!existing) return { ok: false, status: "missing", error: "Approval not found." };
  if (existing.status !== "pending") return { ok: false, status: "already_resolved", error: `Already ${existing.status}.` };

  const resolvedAt = new Date().toISOString();

  if (decision === "deny") {
    const claimed = claimPending(id, "denied", resolvedAt, reason);
    if (!claimed) return { ok: false, status: "already_resolved", error: "Already resolved." };
    setDecidedBy(id, decidedBy);
    recordTelemetryEvent("mcp.call.approval_denied", { id, decidedBy, serverName: existing.serverName, toolName: existing.toolName, reason: reason ?? null });
    if (shouldDeliver) {
      (deps.deliver ?? defaultDeliver)(existing, `MCP call to ${existing.serverName}/${existing.toolName} was denied.${reason ? ` Reason: ${reason}` : ""}`);
    }
    return { ok: true, status: "denied" };
  }

  // Atomically claim the pending row so a concurrent approve cannot double-run.
  const claimed = claimPending(id, "executed", resolvedAt, reason, /* claimOnly */ true);
  if (!claimed) return { ok: false, status: "already_resolved", error: "Already resolved." };
  setDecidedBy(id, decidedBy);

  // Re-check scope + policy AFTER approval, immediately before execution — even a
  // guardian-approved call cannot run if the agent is no longer in scope.
  const access = await (deps.evaluateAccess
    ? Promise.resolve(deps.evaluateAccess(existing.serverName, existing.toolName, { agentId: existing.agentId }))
    : defaultEvaluateAccess(existing.serverName, existing.toolName, { agentId: existing.agentId }));
  if (!access.allowed) {
    finalize(id, "scope_revoked", { error: `Scope re-check failed: ${access.reason}` });
    recordTelemetryEvent("mcp.call.scope_revoked", { id, decidedBy, serverName: existing.serverName, toolName: existing.toolName, reason: access.reason });
    if (shouldDeliver) {
      (deps.deliver ?? defaultDeliver)(existing, `MCP call to ${existing.serverName}/${existing.toolName} was approved but blocked: the agent is no longer in scope (${access.reason}).`);
    }
    return { ok: false, status: "scope_revoked", error: access.reason };
  }

  try {
    const full = getFullArgs(id);
    const result = await (deps.execute ?? defaultExecute)(existing.serverName, existing.toolName, full, { agentId: existing.agentId });
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    finalize(id, "executed", { resultPreview: truncatePreview(text), executedAt: new Date().toISOString() });
    recordTelemetryEvent("mcp.call.executed", { id, decidedBy, agentId: existing.agentId, serverName: existing.serverName, toolName: existing.toolName, argsHash: existing.argsHash });
    if (shouldDeliver) {
      (deps.deliver ?? defaultDeliver)(existing, `MCP call to ${existing.serverName}/${existing.toolName} (approved) completed:\n\n${truncatePreview(text)}`);
    }
    return { ok: true, status: "executed", result: text };
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    finalize(id, "failed", { error: message });
    recordTelemetryEvent("mcp.call.failed", { id, decidedBy, serverName: existing.serverName, toolName: existing.toolName, error: message });
    if (shouldDeliver) {
      (deps.deliver ?? defaultDeliver)(existing, `MCP call to ${existing.serverName}/${existing.toolName} (approved) failed: ${message}`);
    }
    return { ok: false, status: "failed", error: message };
  }
}

function setDecidedBy(id: string, decidedBy: string): void {
  withSqliteWriteRecovery("mcp-call-approval:decided-by", (db) => {
    db.prepare("UPDATE mcp_call_approvals SET decided_by = ? WHERE id = ?").run(decidedBy, id);
  });
}

function getFullArgs(id: string): Record<string, unknown> {
  const row = getSqlite().prepare("SELECT tool_args_json FROM mcp_call_approvals WHERE id = ?").get(id) as
    | { tool_args_json?: string }
    | undefined;
  try {
    return JSON.parse(row?.tool_args_json ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Atomically transition a row out of 'pending'. Returns true only if THIS call
 * won the claim (changes === 1), guaranteeing one-time execution.
 */
function claimPending(
  id: string,
  status: McpCallApprovalStatus,
  resolvedAt: string,
  reason: string | undefined,
  claimOnly = false,
): boolean {
  let changed = 0;
  withSqliteWriteRecovery("mcp-call-approval:claim", (db) => {
    // Claim into an interim 'approved' marker for approve, or the terminal status for deny.
    const target = claimOnly ? "approved" : status;
    const res = db
      .prepare("UPDATE mcp_call_approvals SET status = ?, resolved_at = ?, reason = ? WHERE id = ? AND status = 'pending'")
      .run(target, resolvedAt, reason ?? null, id);
    changed = res.changes;
  });
  return changed === 1;
}

function finalize(
  id: string,
  status: McpCallApprovalStatus,
  fields: { resultPreview?: string; error?: string; executedAt?: string },
): void {
  withSqliteWriteRecovery("mcp-call-approval:finalize", (db) => {
    db.prepare(
      "UPDATE mcp_call_approvals SET status = ?, result_preview = ?, error = ?, executed_at = COALESCE(?, executed_at) WHERE id = ?",
    ).run(status, fields.resultPreview ?? null, fields.error ?? null, fields.executedAt ?? null, id);
  });
}
