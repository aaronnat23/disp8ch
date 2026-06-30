import { getSqlite } from "@/lib/db";

/**
 * Attention Center aggregation. This is a read-only presentation adapter over
 * existing authoritative sources (task approvals, tool approvals, background
 * jobs, workflow executions). It must not create a second approvals/job queue;
 * dismiss state lives in the lightweight `attention_receipts` table only.
 */

export type AttentionSeverity = "info" | "warn" | "critical";
export type AttentionActionKind = "open" | "approve" | "retry" | "diagnose";

export type AttentionItem = {
  id: string;
  sourceType: string;
  sourceId: string;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  href: string;
  action: { label: string; kind: AttentionActionKind };
  createdAt: string;
};

export type AttentionSummary = {
  items: AttentionItem[];
  counts: { total: number; critical: number; warn: number; info: number };
  generatedAt: string;
};

function dismissedKeys(): Set<string> {
  const keys = new Set<string>();
  try {
    const db = getSqlite();
    const rows = db
      .prepare("SELECT source_type, source_id FROM attention_receipts WHERE state = 'dismissed'")
      .all() as Array<{ source_type: string; source_id: string }>;
    for (const row of rows) keys.add(`${row.source_type}:${row.source_id}`);
  } catch {
    /* receipts table may not exist yet */
  }
  return keys;
}

function collectApprovals(items: AttentionItem[]): void {
  try {
    const db = getSqlite();
    const rows = db
      .prepare(
        `SELECT id, task_id, created_at FROM task_approvals
         WHERE status = 'pending' ORDER BY created_at DESC LIMIT 25`,
      )
      .all() as Array<{ id: string; task_id: string; created_at: string }>;
    for (const row of rows) {
      items.push({
        id: `approval:${row.id}`,
        sourceType: "approval",
        sourceId: row.id,
        severity: "warn",
        title: "Approval required",
        detail: `Task ${row.task_id} is waiting for a decision.`,
        href: "/approvals",
        action: { label: "Review", kind: "approve" },
        createdAt: row.created_at,
      });
    }
  } catch {
    /* table may not exist */
  }
}

function collectToolApprovals(items: AttentionItem[]): void {
  try {
    const { listPendingApprovals } = require("@/lib/engine/tools") as {
      listPendingApprovals: () => Array<{
        id?: string;
        toolName?: string;
        sessionId?: string;
        createdAt?: string;
      }>;
    };
    const approvals = listPendingApprovals?.() ?? [];
    for (const approval of approvals) {
      const id = String(approval.id ?? approval.sessionId ?? Math.random());
      items.push({
        id: `tool-approval:${id}`,
        sourceType: "tool-approval",
        sourceId: id,
        severity: "warn",
        title: "Agent waiting for tool approval",
        detail: approval.toolName ? `Tool: ${approval.toolName}` : "An agent is paused for a tool approval.",
        href: "/approvals",
        action: { label: "Review", kind: "approve" },
        createdAt: approval.createdAt ?? new Date().toISOString(),
      });
    }
  } catch {
    /* tools module may not be available */
  }
}

function collectMcpCallApprovals(items: AttentionItem[]): void {
  try {
    const { listPendingMcpCallApprovals } = require("@/lib/mcp/call-approval") as {
      listPendingMcpCallApprovals: () => Array<{
        id: string;
        serverName: string;
        toolName: string;
        agentId: string;
        approvalMode: string;
        createdAt: string;
      }>;
    };
    const approvals = listPendingMcpCallApprovals?.() ?? [];
    for (const approval of approvals) {
      items.push({
        id: `mcp-call-approval:${approval.id}`,
        sourceType: "mcp-call-approval",
        sourceId: approval.id,
        severity: "warn",
        title: "MCP call needs approval",
        detail: `${approval.serverName}/${approval.toolName} (agent ${approval.agentId}) — ${approval.approvalMode} approval`,
        href: "/approvals",
        action: { label: "Review", kind: "approve" },
        createdAt: approval.createdAt,
      });
    }
  } catch {
    /* call-approval module may be unavailable */
  }
}

function collectWorkflowNodeApprovals(items: AttentionItem[]): void {
  try {
    const { listPendingApprovals } = require("@/lib/engine/workflow-approvals") as {
      listPendingApprovals: (limit?: number) => Array<{
        id: string;
        workflowId: string;
        nodeId: string;
        effectKind: string;
        target: string | null;
        requestedAt: string;
        effect: { summary?: string };
      }>;
    };
    const approvals = listPendingApprovals?.(25) ?? [];
    for (const approval of approvals) {
      items.push({
        id: `workflow-approval:${approval.id}`,
        sourceType: "workflow-approval",
        sourceId: approval.id,
        severity: "warn",
        title: "Workflow action needs approval",
        detail: `${approval.effect?.summary || approval.effectKind}${approval.target ? ` → ${approval.target}` : ""}`.slice(0, 160),
        href: "/approvals",
        action: { label: "Review", kind: "approve" },
        createdAt: approval.requestedAt,
      });
    }
  } catch {
    /* workflow-approvals module may be unavailable */
  }
}

function collectBackgroundJobs(items: AttentionItem[]): void {
  try {
    const { listBackgroundJobs } = require("@/lib/runtime/background-jobs") as {
      listBackgroundJobs: (opts: { limit: number }) => Array<{
        id: string;
        status: string;
        commandPreview?: string;
        exitCode?: number | null;
        completedAt?: string | null;
        sessionId?: string | null;
      }>;
    };
    const jobs = listBackgroundJobs?.({ limit: 40 }) ?? [];
    const cutoff = Date.now() - 1000 * 60 * 60 * 6;
    for (const job of jobs) {
      const failed = job.status === "failed" || job.status === "error" || (typeof job.exitCode === "number" && job.exitCode !== 0);
      const completed = job.status === "completed" || job.status === "succeeded";
      if (!failed && !completed) continue;
      const when = job.completedAt ? Date.parse(job.completedAt) : Date.now();
      if (Number.isFinite(when) && when < cutoff) continue;
      items.push({
        id: `background-job:${job.id}`,
        sourceType: "background-job",
        sourceId: job.id,
        severity: failed ? "critical" : "info",
        title: failed ? "Background task failed" : "Background task completed",
        detail: job.commandPreview ? String(job.commandPreview).slice(0, 160) : `Job ${job.id}`,
        href: job.sessionId ? `/chat?sessionId=${encodeURIComponent(job.sessionId)}` : "/activity",
        action: failed ? { label: "Open diagnostics", kind: "diagnose" } : { label: "Open", kind: "open" },
        createdAt: job.completedAt ?? new Date().toISOString(),
      });
    }
  } catch {
    /* background jobs module may not be available */
  }
}

function collectWorkflowFailures(items: AttentionItem[]): void {
  try {
    const db = getSqlite();
    const rows = db
      .prepare(
        `SELECT id, workflow_id, error, completed_at, started_at FROM executions
         WHERE status = 'failed'
           AND COALESCE(completed_at, started_at) >= datetime('now', '-6 hours')
         ORDER BY COALESCE(completed_at, started_at) DESC LIMIT 15`,
      )
      .all() as Array<{ id: string; workflow_id: string; error: string | null; completed_at: string | null; started_at: string }>;
    for (const row of rows) {
      items.push({
        id: `workflow:${row.id}`,
        sourceType: "workflow",
        sourceId: row.id,
        severity: "critical",
        title: "Workflow failed",
        detail: (row.error || "Execution failed").slice(0, 160),
        href: `/workflows/${row.workflow_id}`,
        action: { label: "Retry", kind: "retry" },
        createdAt: row.completed_at || row.started_at,
      });
    }
  } catch {
    /* executions table may not exist */
  }
}

function collectBoardBlockEscalations(items: AttentionItem[]): void {
  try {
    const db = getSqlite();
    const rows = db
      .prepare(
        `SELECT id, title, board_id, block_kind, block_reason, block_recurrence_count, escalation_status, last_blocked_at
           FROM board_tasks
          WHERE status = 'blocked' AND escalation_status IN ('attention','triage')
          ORDER BY last_blocked_at DESC LIMIT 25`,
      )
      .all() as Array<{
      id: string;
      title: string;
      board_id: string;
      block_kind: string | null;
      block_reason: string | null;
      block_recurrence_count: number | null;
      escalation_status: string;
      last_blocked_at: string | null;
    }>;
    for (const row of rows) {
      const recurrence = Number(row.block_recurrence_count ?? 0);
      const kind = row.block_kind || "unknown";
      items.push({
        id: `board-block:${row.id}`,
        sourceType: "board-block",
        sourceId: row.id,
        severity: row.escalation_status === "triage" ? "critical" : "warn",
        title: row.escalation_status === "triage" ? "Blocked task needs human triage" : "Task blocked, needs human",
        detail: `${row.title} — ${kind}${recurrence > 1 ? ` ×${recurrence}` : ""}: ${(row.block_reason || "blocked").slice(0, 120)}`,
        href: `/boards?task=${encodeURIComponent(row.id)}`,
        action: { label: "Resolve", kind: "diagnose" },
        createdAt: row.last_blocked_at || new Date().toISOString(),
      });
    }
  } catch {
    /* board_tasks table may not exist yet */
  }
}

const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, warn: 1, info: 2 };

export function getAttentionSummary(): AttentionSummary {
  const collected: AttentionItem[] = [];
  collectApprovals(collected);
  collectToolApprovals(collected);
  collectMcpCallApprovals(collected);
  collectWorkflowNodeApprovals(collected);
  collectBackgroundJobs(collected);
  collectWorkflowFailures(collected);
  collectBoardBlockEscalations(collected);

  const dismissed = dismissedKeys();
  const items = collected
    .filter((item) => !dismissed.has(item.id))
    .sort((a, b) => {
      const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (sev !== 0) return sev;
      return (b.createdAt || "").localeCompare(a.createdAt || "");
    });

  const counts = {
    total: items.length,
    critical: items.filter((i) => i.severity === "critical").length,
    warn: items.filter((i) => i.severity === "warn").length,
    info: items.filter((i) => i.severity === "info").length,
  };

  return { items, counts, generatedAt: new Date().toISOString() };
}

export function dismissAttentionItem(sourceType: string, sourceId: string): void {
  const db = getSqlite();
  db.prepare(
    `INSERT INTO attention_receipts (source_type, source_id, state, updated_at)
     VALUES (?, ?, 'dismissed', ?)
     ON CONFLICT(source_type, source_id) DO UPDATE SET state = 'dismissed', updated_at = excluded.updated_at`,
  ).run(sourceType, sourceId, new Date().toISOString());
}
