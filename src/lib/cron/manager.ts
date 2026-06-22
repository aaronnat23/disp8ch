import { Cron } from "croner";
import { getSqlite } from "@/lib/db";
import { getModelConfig } from "@/lib/agents/model-router";
import { createProvenance } from "@/lib/provenance";
import { logger } from "@/lib/utils/logger";

const log = logger.child("cron");

interface CronJob {
  cron: Cron;
  workflowId: string;
  nodeId: string;
  expression: string;
  timezone: string;
}

type CronGlobalState = typeof globalThis & {
  __disp8chCronJobs?: Map<string, CronJob>;
};

const cronGlobal = globalThis as CronGlobalState;
const jobs = cronGlobal.__disp8chCronJobs ?? new Map<string, CronJob>();
cronGlobal.__disp8chCronJobs = jobs;

function getJobKey(workflowId: string, nodeId: string) {
  return `${workflowId}:${nodeId}`;
}

function cronManagerEnabled(): boolean {
  const raw = String(process.env.DISP8CH_CRON_MANAGER ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "disabled", "no"].includes(raw);
}

function dateInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

async function executeWorkflowForCron(workflowId: string) {
  try {
    const { executeWorkflow } = await import("@/lib/engine/executor");
    const db = getSqlite();
    const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(workflowId) as {
      id: string; nodes: string; edges: string; schedule_profile: string | null;
    } | undefined;

    if (!row) {
      log.warn("Cron: workflow not found", { workflowId });
      return;
    }

    const nodes = JSON.parse(row.nodes);
    const edges = JSON.parse(row.edges);
    const scheduleProfile = readScheduleProfile(row.schedule_profile);
    const cronTimezone = String(
      (nodes as Array<{ type?: string; data?: Record<string, unknown> }>).find((node) => node.type === "cron-trigger")?.data?.timezone || "UTC",
    );
    if (scheduleProfile.oneShotDate && dateInTimezone(cronTimezone) !== scheduleProfile.oneShotDate) {
      db.prepare("UPDATE workflows SET is_active = 0, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), workflowId);
      unscheduleCronWorkflow(workflowId);
      log.warn("Cron: expired one-time automation disabled", { workflowId, oneShotDate: scheduleProfile.oneShotDate });
      return;
    }
    const modelConfig = getModelConfig();

    log.info("Cron: executing workflow", { workflowId });

    const executeOnce = () => executeWorkflow({
      workflowId,
      nodes,
      edges,
      triggerType: "cron",
      triggerData: { triggeredAt: new Date().toISOString(), source: "cron", scheduleProfile },
      provenance: createProvenance("cron", "cron:scheduler", {
        workflowId,
        triggerType: "cron",
      }),
      modelConfig,
    });

    if (scheduleProfile.overlapPolicy === "skip-if-running") {
      const runningExecution = db
        .prepare("SELECT id FROM executions WHERE workflow_id = ? AND status IN ('running', 'queued') ORDER BY started_at DESC LIMIT 1")
        .get(workflowId);
      if (runningExecution) {
        log.info("Cron: skipped overlapping workflow run", { workflowId });
        return;
      }
    }

    try {
      await executeOnce().catch(async (error) => {
        if (scheduleProfile.retryPolicy === "none") throw error;
        await executeOnce().catch(async (retryError) => {
          if (scheduleProfile.retryPolicy !== "twice") throw retryError;
          await executeOnce();
        });
      });
    } finally {
      if (scheduleProfile.oneShotDate) {
        db.prepare("UPDATE workflows SET is_active = 0, updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), workflowId);
        unscheduleCronWorkflow(workflowId);
      }
    }
  } catch (error) {
    log.error("Cron: execution failed", { workflowId, error: String(error) });
  }
}

function readScheduleProfile(raw: string | null) {
  const fallback = {
    overlapPolicy: "allow",
    retryPolicy: "none",
    skillOverrides: [] as string[],
    extensionOverrides: [] as string[],
    oneShotDate: null as string | null,
  };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      overlapPolicy: parsed.overlapPolicy === "skip-if-running" ? "skip-if-running" : "allow",
      retryPolicy: parsed.retryPolicy === "once" || parsed.retryPolicy === "twice" ? parsed.retryPolicy : "none",
      skillOverrides: Array.isArray(parsed.skillOverrides)
        ? parsed.skillOverrides.map((value) => String(value).trim()).filter(Boolean).slice(0, 50)
        : [],
      extensionOverrides: Array.isArray(parsed.extensionOverrides)
        ? parsed.extensionOverrides.map((value) => String(value).trim()).filter(Boolean).slice(0, 50)
        : [],
      oneShotDate: /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.oneShotDate || "")) ? String(parsed.oneShotDate) : null,
    };
  } catch {
    return fallback;
  }
}

function stopAllCronJobs(): void {
  for (const job of jobs.values()) {
    try {
      job.cron.stop();
    } catch {
      // Ignore shutdown errors from stale jobs.
    }
  }
  jobs.clear();
}

export function scheduleCronWorkflow(
  workflowId: string,
  nodeId: string,
  expression: string,
  timezone?: string
) {
  if (!cronManagerEnabled()) return;
  const key = getJobKey(workflowId, nodeId);

  // Stop existing job for this workflow/node
  if (jobs.has(key)) {
    jobs.get(key)!.cron.stop();
    jobs.delete(key);
  }

  if (!expression) return;

  try {
    const resolvedTimezone = timezone || "UTC";
    const cron = new Cron(
      expression,
      {
        timezone: resolvedTimezone,
        catch: (err) => {
          log.error("Cron job error", { workflowId, error: String(err) });
        },
      },
      () => executeWorkflowForCron(workflowId)
    );

    jobs.set(key, { cron, workflowId, nodeId, expression, timezone: resolvedTimezone });
    log.info("Cron scheduled", { workflowId, nodeId, expression });
  } catch (error) {
    log.error("Failed to schedule cron", { workflowId, expression, error: String(error) });
  }
}

export function unscheduleCronWorkflow(workflowId: string, nodeId?: string) {
  if (nodeId) {
    const key = getJobKey(workflowId, nodeId);
    if (jobs.has(key)) {
      jobs.get(key)!.cron.stop();
      jobs.delete(key);
    }
  } else {
    // Remove all jobs for this workflow
    for (const [key, job] of jobs) {
      if (job.workflowId === workflowId) {
        job.cron.stop();
        jobs.delete(key);
      }
    }
  }
}

export function initCronManager() {
  try {
    stopAllCronJobs();
    if (!cronManagerEnabled()) {
      log.info("Cron manager disabled");
      return;
    }
    const db = getSqlite();
    const workflows = db.prepare("SELECT * FROM workflows WHERE is_active = 1").all() as Array<{
      id: string; nodes: string; schedule_profile: string | null;
    }>;

    let count = 0;
    for (const wf of workflows) {
      const profile = readScheduleProfile(wf.schedule_profile);
      const nodes = JSON.parse(wf.nodes) as Array<{
        id: string; type: string; data: Record<string, unknown>;
      }>;

      const timezone = String(nodes.find((node) => node.type === "cron-trigger")?.data.timezone || "UTC");
      if (profile.oneShotDate && profile.oneShotDate < dateInTimezone(timezone)) {
        db.prepare("UPDATE workflows SET is_active = 0, updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), wf.id);
        continue;
      }

      for (const node of nodes) {
        if (node.type === "cron-trigger") {
          const expression =
            (node.data.expression as string) ||
            (node.data.cronExpression as string);
          const timezone = node.data.timezone as string | undefined;
          if (expression) {
            scheduleCronWorkflow(wf.id, node.id, expression, timezone);
            count++;
          }
        }
      }
    }

    if (count > 0) {
      log.info("Cron manager initialized", { scheduledJobs: count });
    }
  } catch (error) {
    log.warn("Cron manager init failed", { error: String(error) });
  }
}

export function restartWorkflowCrons(workflowId: string) {
  unscheduleCronWorkflow(workflowId);

  try {
    const db = getSqlite();
    const row = db.prepare("SELECT * FROM workflows WHERE id = ? AND is_active = 1").get(workflowId) as {
      nodes: string; schedule_profile: string | null;
    } | undefined;

    if (!row) return;

    const nodes = JSON.parse(row.nodes) as Array<{
      id: string; type: string; data: Record<string, unknown>;
    }>;
    const profile = readScheduleProfile(row.schedule_profile);
    const timezone = String(nodes.find((node) => node.type === "cron-trigger")?.data.timezone || "UTC");
    if (profile.oneShotDate && profile.oneShotDate < dateInTimezone(timezone)) {
      db.prepare("UPDATE workflows SET is_active = 0, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), workflowId);
      return;
    }

    for (const node of nodes) {
      if (node.type === "cron-trigger") {
        const expression =
          (node.data.expression as string) ||
          (node.data.cronExpression as string);
        const timezone = node.data.timezone as string | undefined;
        if (expression) {
          scheduleCronWorkflow(workflowId, node.id, expression, timezone);
        }
      }
    }
  } catch (error) {
    log.warn("Failed to restart workflow crons", { workflowId, error: String(error) });
  }
}

export type ScheduledCronJobInfo = {
  workflowId: string;
  nodeId: string;
  expression: string;
  timezone: string;
};

export function listScheduledCronJobs(): ScheduledCronJobInfo[] {
  return [...jobs.values()]
    .map((job) => ({
      workflowId: job.workflowId,
      nodeId: job.nodeId,
      expression: job.expression,
      timezone: job.timezone,
    }))
    .sort((a, b) => {
      if (a.workflowId === b.workflowId) {
        return a.nodeId.localeCompare(b.nodeId);
      }
      return a.workflowId.localeCompare(b.workflowId);
    });
}
