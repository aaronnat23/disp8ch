import { NextRequest, NextResponse } from "next/server";
import { initializeDatabase, getSqlite } from "@/lib/db";
import { extractCronNodes, parseWorkflowNodes } from "@/lib/agents/workflow-insights";
import { listScheduledCronJobs, scheduleCronWorkflow, unscheduleCronWorkflow } from "@/lib/cron/manager";
import { createProvenance } from "@/lib/provenance";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  is_active: number | string;
  nodes: string;
  schedule_profile: string | null;
  updated_at: string;
};

type ExecutionRow = {
  id: string;
  workflow_id: string;
  trigger_type: string;
  status: string;
  started_at: string;
  completed_at?: string | null;
  error?: string | null;
};

// GET /api/cron — list all cron jobs globally with live scheduler state
export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();

    const rows = db
      .prepare("SELECT id, name, description, is_active, nodes, schedule_profile, updated_at FROM workflows ORDER BY updated_at DESC")
      .all() as WorkflowRow[];

    // Live jobs map from in-memory scheduler
    const liveJobs = listScheduledCronJobs();
    const liveMap = new Map(liveJobs.map((j) => [`${j.workflowId}:${j.nodeId}`, j]));

    // Last cron execution per workflow
    const recentExecs = db
      .prepare(
        "SELECT id, workflow_id, trigger_type, status, started_at, completed_at, error FROM executions WHERE trigger_type = 'cron' ORDER BY started_at DESC LIMIT 100"
      )
      .all() as ExecutionRow[];
    const lastRunMap = new Map<string, ExecutionRow>();
    const historyMap = new Map<string, ExecutionRow[]>();
    for (const exec of recentExecs) {
      if (!lastRunMap.has(exec.workflow_id)) {
        lastRunMap.set(exec.workflow_id, exec);
      }
      const history = historyMap.get(exec.workflow_id) ?? [];
      if (history.length < 5) history.push(exec);
      historyMap.set(exec.workflow_id, history);
    }

    const jobs: Array<{
      workflowId: string;
      workflowName: string;
      workflowDescription: string;
      workflowActive: boolean;
      nodeId: string;
      label: string;
      expression: string;
      timezone: string;
      isLive: boolean;
      lastRun: { id: string; status: string; createdAt: string } | null;
      recentRuns: Array<{ id: string; status: string; createdAt: string; completedAt: string | null; error: string | null }>;
      profile: {
        label: string;
        priority: string;
        overlapPolicy: string;
        timeoutMinutes: number;
        agentId: string | null;
        workspacePath: string | null;
        deliveryRoute: string;
        retryPolicy: string;
        silenceOnSuccess: boolean;
        skillOverrides?: string[];
        extensionOverrides?: string[];
      };
    }> = [];

    for (const row of rows) {
      const nodes = parseWorkflowNodes(row.nodes);
      const cronNodes = extractCronNodes(nodes);
      if (cronNodes.length === 0) continue;

      const workflowActive = Number(row.is_active) === 1;
      const lastRun = lastRunMap.get(row.id);

      for (const cron of cronNodes) {
        const key = `${row.id}:${cron.nodeId}`;
        jobs.push({
          workflowId: row.id,
          workflowName: row.name,
          workflowDescription: row.description ?? "",
          workflowActive,
          nodeId: cron.nodeId,
          label: cron.label || cron.expression,
          expression: cron.expression,
          timezone: cron.timezone || "UTC",
          isLive: liveMap.has(key),
          profile: readScheduleProfile(row.schedule_profile),
          lastRun: lastRun
            ? { id: lastRun.id, status: lastRun.status, createdAt: lastRun.started_at }
            : null,
          recentRuns: (historyMap.get(row.id) ?? []).map((run) => ({
            id: run.id,
            status: run.status,
            createdAt: run.started_at,
            completedAt: run.completed_at ?? null,
            error: run.error ?? null,
          })),
        });
      }
    }

    const totalJobs = jobs.length;
    const activeJobs = jobs.filter((j) => j.workflowActive).length;
    const liveCount = jobs.filter((j) => j.isLive).length;

    return NextResponse.json({
      success: true,
      data: { summary: { totalJobs, activeJobs, liveCount }, jobs },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

const runNowSchema = z.object({
  action: z.enum(["run", "toggle", "resync", "profile"]),
  workflowId: z.string().optional(),
  profile: z.object({
    label: z.string().optional(),
    priority: z.enum(["low", "normal", "high"]).optional(),
    overlapPolicy: z.enum(["allow", "skip-if-running"]).optional(),
    timeoutMinutes: z.number().min(1).max(1440).optional(),
    agentId: z.string().nullable().optional(),
    workspacePath: z.string().nullable().optional(),
    deliveryRoute: z.enum(["none", "webchat", "board"]).optional(),
    retryPolicy: z.enum(["none", "once", "twice"]).optional(),
    silenceOnSuccess: z.boolean().optional(),
    skillOverrides: z.array(z.string()).optional(),
    extensionOverrides: z.array(z.string()).optional(),
  }).optional(),
});

function readScheduleProfile(raw: string | null) {
  const fallback = {
    label: "Default",
    priority: "normal",
    overlapPolicy: "allow",
    timeoutMinutes: 60,
    agentId: null as string | null,
    workspacePath: null as string | null,
    deliveryRoute: "none",
    retryPolicy: "none",
    silenceOnSuccess: false,
    skillOverrides: [] as string[],
    extensionOverrides: [] as string[],
    oneShotDate: null as string | null,
  };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<typeof fallback>;
    return {
      label: String(parsed.label || fallback.label).slice(0, 80),
      priority: parsed.priority === "low" || parsed.priority === "high" ? parsed.priority : fallback.priority,
      overlapPolicy: parsed.overlapPolicy === "skip-if-running" ? "skip-if-running" : fallback.overlapPolicy,
      timeoutMinutes: Number.isFinite(Number(parsed.timeoutMinutes))
        ? Math.max(1, Math.min(1440, Number(parsed.timeoutMinutes)))
        : fallback.timeoutMinutes,
      agentId: typeof parsed.agentId === "string" && parsed.agentId.trim() ? parsed.agentId.trim() : null,
      workspacePath: typeof parsed.workspacePath === "string" && parsed.workspacePath.trim() ? parsed.workspacePath.trim() : null,
      deliveryRoute: parsed.deliveryRoute === "webchat" || parsed.deliveryRoute === "board" ? parsed.deliveryRoute : fallback.deliveryRoute,
      retryPolicy: parsed.retryPolicy === "once" || parsed.retryPolicy === "twice" ? parsed.retryPolicy : fallback.retryPolicy,
      silenceOnSuccess: parsed.silenceOnSuccess === true,
      skillOverrides: Array.isArray((parsed as { skillOverrides?: unknown }).skillOverrides)
        ? ((parsed as { skillOverrides?: unknown[] }).skillOverrides ?? [])
            .map((value) => String(value).trim())
            .filter(Boolean)
            .slice(0, 50)
        : fallback.skillOverrides,
      extensionOverrides: Array.isArray((parsed as { extensionOverrides?: unknown }).extensionOverrides)
        ? ((parsed as { extensionOverrides?: unknown[] }).extensionOverrides ?? [])
            .map((value) => String(value).trim())
            .filter(Boolean)
            .slice(0, 50)
        : fallback.extensionOverrides,
      oneShotDate: /^\d{4}-\d{2}-\d{2}$/.test(String((parsed as { oneShotDate?: unknown }).oneShotDate || ""))
        ? String((parsed as { oneShotDate?: unknown }).oneShotDate)
        : null,
    };
  } catch {
    return fallback;
  }
}

// POST /api/cron — run a workflow now, toggle active, or resync scheduler
export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();
    const body = await request.json() as unknown;
    const { action, workflowId, profile } = runNowSchema.parse(body);

    if (action === "resync") {
      // Re-read all active workflows and reschedule
      const { initCronManager } = await import("@/lib/cron/manager");
      // Clear all and reinit
      const allRows = db
        .prepare("SELECT id, nodes FROM workflows WHERE is_active = 1")
        .all() as Array<{ id: string; nodes: string }>;

      for (const row of allRows) {
        unscheduleCronWorkflow(row.id);
      }
      initCronManager();
      return NextResponse.json({ success: true, data: { resynced: true } });
    }

    if (!workflowId) {
      return NextResponse.json({ success: false, error: "workflowId required" }, { status: 400 });
    }

    if (action === "toggle") {
      const wf = db
        .prepare("SELECT id, is_active, nodes FROM workflows WHERE id = ?")
        .get(workflowId) as { id: string; is_active: number; nodes: string } | undefined;
      if (!wf) {
        return NextResponse.json({ success: false, error: "Workflow not found" }, { status: 404 });
      }
      const newActive = wf.is_active === 1 ? 0 : 1;
      db.prepare("UPDATE workflows SET is_active = ?, updated_at = datetime('now') WHERE id = ?")
        .run(newActive, workflowId);

      if (newActive === 1) {
        const nodes = parseWorkflowNodes(wf.nodes);
        const cronNodes = extractCronNodes(nodes);
        for (const cron of cronNodes) {
          scheduleCronWorkflow(workflowId, cron.nodeId, cron.expression, cron.timezone);
        }
      } else {
        unscheduleCronWorkflow(workflowId);
      }

      return NextResponse.json({ success: true, data: { workflowId, active: newActive === 1 } });
    }

    if (action === "profile") {
      const existing = db
        .prepare("SELECT id, schedule_profile FROM workflows WHERE id = ?")
        .get(workflowId) as { id: string; schedule_profile: string | null } | undefined;
      if (!existing) {
        return NextResponse.json({ success: false, error: "Workflow not found" }, { status: 404 });
      }
      const current = readScheduleProfile(existing.schedule_profile);
      const next = readScheduleProfile(JSON.stringify({ ...current, ...(profile ?? {}) }));
      db.prepare("UPDATE workflows SET schedule_profile = ?, updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(next), workflowId);
      return NextResponse.json({ success: true, data: { workflowId, profile: next } });
    }

    if (action === "run") {
      const { executeWorkflow } = await import("@/lib/engine/executor");
      const { getModelConfig } = await import("@/lib/agents/model-router");
      const wf = db
        .prepare("SELECT id, nodes, edges, schedule_profile FROM workflows WHERE id = ?")
        .get(workflowId) as { id: string; nodes: string; edges: string; schedule_profile: string | null } | undefined;
      if (!wf) {
        return NextResponse.json({ success: false, error: "Workflow not found" }, { status: 404 });
      }
      const scheduleProfile = readScheduleProfile(wf.schedule_profile);
      if (scheduleProfile.overlapPolicy === "skip-if-running") {
        const runningExecution = db
          .prepare("SELECT id FROM executions WHERE workflow_id = ? AND status IN ('running', 'queued') ORDER BY started_at DESC LIMIT 1")
          .get(workflowId) as { id: string } | undefined;
        if (runningExecution) {
          return NextResponse.json({
            success: true,
            data: { workflowId, queued: false, skipped: true, reason: "skip-if-running", executionId: runningExecution.id },
          });
        }
      }

      const nodes = JSON.parse(wf.nodes);
      const edges = JSON.parse(wf.edges);
      const modelConfig = getModelConfig();

      // Fire and forget
      const executeOnce = () => executeWorkflow({
        workflowId,
        nodes,
        edges,
        triggerType: "cron",
        triggerData: { triggeredAt: new Date().toISOString(), source: "manual", scheduleProfile },
        provenance: createProvenance("api", "cron:run-now", {
          workflowId,
          triggerType: "cron",
        }),
        modelConfig,
      });
      void executeOnce().catch(async (error) => {
        if (scheduleProfile.retryPolicy === "none") {
          console.warn("Manual scheduler run failed", error);
          return;
        }
        await executeOnce().catch(async (retryError) => {
          if (scheduleProfile.retryPolicy !== "twice") {
            console.warn("Manual scheduler retry failed", retryError);
            return;
          }
          await executeOnce().catch((secondRetryError) => console.warn("Manual scheduler second retry failed", secondRetryError));
        });
      });

      return NextResponse.json({ success: true, data: { workflowId, queued: true } });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.errors[0]?.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
