import { getSqlite } from "@/lib/db";

/**
 * Work Monitor presentation adapter (Phase 3). Read-only projection over the
 * existing background-job records and workflow executions. It does not own a
 * job runner or duplicate progress storage; cancellation continues to flow
 * through the existing /api/background-jobs DELETE path.
 */

export type WorkItemState = "running" | "queued" | "waiting" | "completed" | "failed";

export type WorkItem = {
  id: string;
  kind: "background-job" | "workflow";
  title: string;
  detail: string;
  state: WorkItemState;
  model?: string | null;
  sessionId?: string | null;
  workflowId?: string | null;
  startedAt?: string | null;
  elapsedMs: number;
  href: string;
  canCancel: boolean;
};

export type WorkMonitorSnapshot = {
  items: WorkItem[];
  counts: { running: number; completed: number; failed: number };
  generatedAt: string;
};

function elapsed(startedAt?: string | null, completedAt?: string | null): number {
  if (!startedAt) return 0;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return 0;
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  return Math.max(0, (Number.isFinite(end) ? end : Date.now()) - start);
}

export type RawBackgroundJob = {
  id: string;
  status: string;
  toolName?: string;
  commandPreview?: string;
  startedAt?: string;
  completedAt?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** Pure mapping from a background-job record to a Work Monitor item. */
export function jobToWorkItem(job: RawBackgroundJob): WorkItem {
  const state: WorkItemState =
    job.status === "running" ? "running" : job.status === "completed" ? "completed" : "failed";
  return {
    id: `background-job:${job.id}`,
    kind: "background-job",
    title: job.toolName === "sessions_spawn" ? "Background agent" : job.toolName || "Background task",
    detail: (job.commandPreview || "").slice(0, 160),
    state,
    model: (job.metadata?.model as string) || (job.metadata?.backend as string) || null,
    sessionId: job.sessionId ?? null,
    startedAt: job.startedAt ?? null,
    elapsedMs: elapsed(job.startedAt, job.completedAt),
    href: job.sessionId ? `/chat?sessionId=${encodeURIComponent(job.sessionId)}` : "/activity",
    canCancel: state === "running",
  };
}

function collectBackgroundJobs(items: WorkItem[]): void {
  try {
    const { listBackgroundJobs } = require("@/lib/runtime/background-jobs") as {
      listBackgroundJobs: (opts: { limit: number }) => RawBackgroundJob[];
    };
    const jobs = listBackgroundJobs?.({ limit: 40 }) ?? [];
    for (const job of jobs) items.push(jobToWorkItem(job));
  } catch {
    /* background jobs unavailable */
  }
}

function collectWorkflowExecutions(items: WorkItem[]): void {
  try {
    const db = getSqlite();
    const rows = db
      .prepare(
        `SELECT e.id, e.workflow_id, e.status, e.started_at, e.completed_at, w.name AS workflow_name
         FROM executions e LEFT JOIN workflows w ON w.id = e.workflow_id
         WHERE e.status = 'running'
            OR COALESCE(e.completed_at, e.started_at) >= datetime('now', '-1 hour')
         ORDER BY e.started_at DESC LIMIT 25`,
      )
      .all() as Array<{
      id: string;
      workflow_id: string;
      status: string;
      started_at: string;
      completed_at: string | null;
      workflow_name: string | null;
    }>;
    for (const row of rows) {
      const state: WorkItemState =
        row.status === "running" ? "running" : row.status === "failed" ? "failed" : "completed";
      items.push({
        id: `workflow:${row.id}`,
        kind: "workflow",
        title: row.workflow_name || "Workflow",
        detail: `Execution ${row.id.slice(0, 8)} · ${row.status}`,
        state,
        workflowId: row.workflow_id,
        startedAt: row.started_at,
        elapsedMs: elapsed(row.started_at, row.completed_at),
        href: `/workflows/${row.workflow_id}`,
        canCancel: false,
      });
    }
  } catch {
    /* executions unavailable */
  }
}

const STATE_RANK: Record<WorkItemState, number> = {
  running: 0,
  queued: 1,
  waiting: 2,
  failed: 3,
  completed: 4,
};

export function getWorkMonitorSnapshot(): WorkMonitorSnapshot {
  const items: WorkItem[] = [];
  collectBackgroundJobs(items);
  collectWorkflowExecutions(items);
  items.sort((a, b) => {
    const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (rank !== 0) return rank;
    return (b.startedAt || "").localeCompare(a.startedAt || "");
  });
  return {
    items,
    counts: {
      running: items.filter((i) => i.state === "running").length,
      completed: items.filter((i) => i.state === "completed").length,
      failed: items.filter((i) => i.state === "failed").length,
    },
    generatedAt: new Date().toISOString(),
  };
}
