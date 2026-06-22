import { Cron } from "croner";
import { getSqlite, withSqliteWriteRecovery } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import { logActivity } from "@/lib/governance/activity-log";
import { claimWakeup, finishWakeup, listWakeupRequests } from "@/lib/governance/wakeup-queue";
import { upsertAgentRuntimeState } from "@/lib/governance/agent-runtime";

export type HeartbeatRunRecord = {
  id: string;
  agentId: string;
  status: "running" | "succeeded" | "failed";
  invocationSource: "scheduled" | "on_demand";
  wakeupRequestId: string | null;
  wakeupsProcessed: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

function createHeartbeatRun(agentId: string, source: "scheduled" | "on_demand" = "scheduled"): string {
  const id = `hbr_${agentId}_${Date.now()}`;
  withSqliteWriteRecovery("heartbeat run create", (db) =>
    db.prepare(
      `INSERT OR IGNORE INTO heartbeat_runs (id, agent_id, status, invocation_source, wakeups_processed, started_at)
       VALUES (?, ?, 'running', ?, 0, ?)`
    ).run(id, agentId, source, new Date().toISOString())
  );
  return id;
}

function finishHeartbeatRun(runId: string, status: "succeeded" | "failed", wakeupsProcessed: number, error?: string): void {
  withSqliteWriteRecovery("heartbeat run finish", (db) =>
    db.prepare(
      `UPDATE heartbeat_runs SET status = ?, wakeups_processed = ?, error = ?, finished_at = ? WHERE id = ?`
    ).run(status, wakeupsProcessed, error ?? null, new Date().toISOString(), runId)
  );
}

export type HeartbeatRunEvent = {
  id: number;
  runId: string;
  agentId: string;
  seq: number;
  eventType: string;
  stream: string | null;
  level: string;
  message: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

const _seqCounters = new Map<string, number>();

function emitRunEvent(
  runId: string,
  agentId: string,
  eventType: string,
  message: string,
  extra?: { stream?: string; level?: string; payload?: Record<string, unknown> },
): void {
  try {
    const seq = (_seqCounters.get(runId) ?? 0) + 1;
    _seqCounters.set(runId, seq);
    withSqliteWriteRecovery("heartbeat run event", (db) =>
      db
        .prepare(
          `INSERT INTO heartbeat_run_events (run_id, agent_id, seq, event_type, stream, level, message, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          agentId,
          seq,
          eventType,
          extra?.stream ?? null,
          extra?.level ?? "info",
          message,
          extra?.payload != null ? JSON.stringify(extra.payload) : null,
          new Date().toISOString(),
        ),
    );
  } catch {
    /* never throw from event emitter */
  }
}

export function listHeartbeatRunEvents(runId: string): HeartbeatRunEvent[] {
  try {
    const db = getSqlite();
    const rows = db
      .prepare(
        `SELECT id, run_id, agent_id, seq, event_type, stream, level, message, payload, created_at
         FROM heartbeat_run_events WHERE run_id = ? ORDER BY seq ASC LIMIT 500`,
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      runId: String(r.run_id),
      agentId: String(r.agent_id),
      seq: Number(r.seq),
      eventType: String(r.event_type),
      stream: r.stream != null ? String(r.stream) : null,
      level: String(r.level ?? "info"),
      message: r.message != null ? String(r.message) : null,
      payload:
        r.payload != null
          ? (() => {
              try {
                return JSON.parse(String(r.payload)) as Record<string, unknown>;
              } catch {
                return null;
              }
            })()
          : null,
      createdAt: String(r.created_at),
    }));
  } catch {
    return [];
  }
}

export function listHeartbeatRuns(agentId: string, limit = 20): HeartbeatRunRecord[] {
  try {
    const db = getSqlite();
    const rows = db.prepare(
      `SELECT id, agent_id, status, invocation_source, wakeup_request_id, wakeups_processed, error, started_at, finished_at
       FROM heartbeat_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?`
    ).all(agentId, Math.max(1, Math.min(100, limit))) as Array<{
      id: string; agent_id: string; status: string; invocation_source: string;
      wakeup_request_id: string | null; wakeups_processed: number;
      error: string | null; started_at: string; finished_at: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      agentId: r.agent_id,
      status: r.status as HeartbeatRunRecord["status"],
      invocationSource: r.invocation_source as HeartbeatRunRecord["invocationSource"],
      wakeupRequestId: r.wakeup_request_id,
      wakeupsProcessed: r.wakeups_processed,
      error: r.error,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  } catch {
    return [];
  }
}

const log = logger.child("heartbeat");

interface HeartbeatJob {
  cron: Cron;
  agentId: string;
  expression: string;
}

type HeartbeatGlobalState = typeof globalThis & {
  __disp8chHeartbeatJobs?: Map<string, HeartbeatJob>;
};

const hbGlobal = globalThis as HeartbeatGlobalState;
const heartbeatJobs = hbGlobal.__disp8chHeartbeatJobs ?? new Map<string, HeartbeatJob>();
hbGlobal.__disp8chHeartbeatJobs = heartbeatJobs;

async function executeHeartbeat(agentId: string): Promise<void> {
  const runId = createHeartbeatRun(agentId, "scheduled");
  emitRunEvent(runId, agentId, "start", "Heartbeat started");
  let wakeupsProcessed = 0;
  try {
    // 1. Check for queued wakeup requests
    const queued = listWakeupRequests({ agentId, status: "queued", limit: 5 });

    if (queued.length > 0) {
      log.info("Heartbeat: processing wakeup requests", { agentId, count: queued.length });
      emitRunEvent(runId, agentId, "wakeup", `Processing ${queued.length} wakeup request(s)`);
      for (const req of queued) {
        const claimed = claimWakeup(req.id);
        if (!claimed) continue;

        try {
          // If payload has workflowId, execute that workflow
          if (claimed.payload && typeof claimed.payload === "object" && "workflowId" in claimed.payload) {
            const { executeWorkflow } = await import("@/lib/engine/executor");
            const { getModelConfig } = await import("@/lib/agents/model-router");
            const { createProvenance } = await import("@/lib/provenance");
            const db = getSqlite();
            const wfId = String(claimed.payload.workflowId);
            const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(wfId) as {
              id: string; nodes: string; edges: string;
            } | undefined;

            if (row) {
              await executeWorkflow({
                workflowId: row.id,
                nodes: JSON.parse(row.nodes),
                edges: JSON.parse(row.edges),
                triggerType: "manual",
                triggerData: { source: "heartbeat", agentId, wakeupRequestId: claimed.id, ...(claimed.payload as Record<string, unknown>) },
                provenance: createProvenance("api", `heartbeat:${agentId}`),
                modelConfig: getModelConfig(),
              });
            }
          }
          finishWakeup(claimed.id);
          wakeupsProcessed++;
          emitRunEvent(runId, agentId, "wakeup_done", `Wakeup ${claimed.id} processed`);
        } catch (err) {
          log.error("Heartbeat: wakeup execution failed", { agentId, requestId: claimed.id, error: String(err) });
          finishWakeup(claimed.id);
          wakeupsProcessed++;
          emitRunEvent(runId, agentId, "wakeup_error", `Wakeup ${claimed.id} failed: ${String(err)}`, { level: "warn" });
        }
      }
    }

    // 2. Log heartbeat
    logActivity({
      actorType: "system",
      action: "agent.heartbeat",
      entityType: "agent",
      entityId: agentId,
      details: { processedWakeups: queued.length, runId },
    });

    finishHeartbeatRun(runId, "succeeded", wakeupsProcessed);
    upsertAgentRuntimeState({ agentId, lastRunId: runId, lastRunStatus: "succeeded", lastError: null });
    emitRunEvent(runId, agentId, "finish", "Heartbeat completed successfully", { level: "info" });
    _seqCounters.delete(runId);
  } catch (error) {
    log.error("Heartbeat execution failed", { agentId, error: String(error) });
    emitRunEvent(runId, agentId, "error", String(error), { level: "error" });
    finishHeartbeatRun(runId, "failed", wakeupsProcessed, String(error));
    upsertAgentRuntimeState({ agentId, lastRunId: runId, lastRunStatus: "failed", lastError: String(error) });
    _seqCounters.delete(runId);
  }
}

export function scheduleAgentHeartbeat(agentId: string, expression: string): void {
  // Stop existing heartbeat for this agent
  unscheduleAgentHeartbeat(agentId);

  if (!expression) return;

  try {
    const cron = new Cron(
      expression,
      {
        timezone: "UTC",
        catch: (err) => {
          log.error("Heartbeat cron error", { agentId, error: String(err) });
        },
      },
      () => { void executeHeartbeat(agentId); }
    );

    heartbeatJobs.set(agentId, { cron, agentId, expression });
    log.info("Heartbeat scheduled", { agentId, expression });
  } catch (error) {
    log.error("Failed to schedule heartbeat", { agentId, expression, error: String(error) });
  }
}

export function unscheduleAgentHeartbeat(agentId: string): void {
  const existing = heartbeatJobs.get(agentId);
  if (existing) {
    existing.cron.stop();
    heartbeatJobs.delete(agentId);
  }
}

export function initHeartbeatManager(): void {
  try {
    // Stop all existing heartbeats
    for (const job of heartbeatJobs.values()) {
      try { job.cron.stop(); } catch { /* ignore */ }
    }
    heartbeatJobs.clear();

    // Load agents with heartbeat_cron set
    const db = getSqlite();

    // Check if heartbeat_cron column exists
    const cols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    const hasCol = cols.some(c => c.name === "heartbeat_cron");
    if (!hasCol) return;

    const agents = db.prepare(
      "SELECT id, heartbeat_cron FROM agents WHERE is_active = 1 AND heartbeat_cron IS NOT NULL AND heartbeat_cron != ''"
    ).all() as Array<{ id: string; heartbeat_cron: string }>;

    let count = 0;
    for (const agent of agents) {
      scheduleAgentHeartbeat(agent.id, agent.heartbeat_cron);
      count++;
    }

    if (count > 0) {
      log.info("Heartbeat manager initialized", { scheduledAgents: count });
    }
  } catch (error) {
    log.warn("Heartbeat manager init failed", { error: String(error) });
  }
}

export type HeartbeatJobInfo = {
  agentId: string;
  expression: string;
  isRunning: boolean;
};

export function listHeartbeatJobs(): HeartbeatJobInfo[] {
  return [...heartbeatJobs.values()]
    .map(job => ({
      agentId: job.agentId,
      expression: job.expression,
      isRunning: job.cron.isRunning(),
    }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}
