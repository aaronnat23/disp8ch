import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { executeWorkflow } from "@/lib/engine/executor";
import { getModelConfig } from "@/lib/agents/model-router";
import { getBackgroundJob, listBackgroundJobs, terminateBackgroundJob } from "@/lib/runtime/background-jobs";
import { broadcastEvent } from "@/lib/ws/broadcast";
import { getPinnedDataForExecution } from "@/lib/workflows/pin-data";
import { checkRateLimit, getClientIp, getRateLimitConfig } from "@/lib/utils/rate-limit";
import { sanitizeStructuredJson } from "@/lib/security/json";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getWorkflowExecutionTraceSummary } from "@/lib/workflows/execution-traces";

const executeSchema = z.object({
  workflowId: z.string(),
  triggerType: z.enum(["message", "webhook", "manual", "cron"]),
  triggerData: z.record(z.unknown()).optional(),
  provenance: z.record(z.unknown()).optional(),
  executionMode: z.enum(["full", "partial", "from-node"]).optional(),
  targetNodeId: z.string().optional().nullable(),
  startNodeId: z.string().optional().nullable(),
  usePinnedData: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");
    const executionId = searchParams.get("executionId");
    const workflowId = searchParams.get("workflowId");

    if (action === "background-jobs") {
      const jobId = String(searchParams.get("jobId") || "").trim();
      const command = String(searchParams.get("command") || "").trim();
      if (jobId && command === "terminate") {
        return NextResponse.json({ success: true, data: terminateBackgroundJob(jobId) });
      }
      if (jobId) {
        return NextResponse.json({ success: true, data: getBackgroundJob(jobId) });
      }
      return NextResponse.json({
        success: true,
        data: listBackgroundJobs({
          sessionId: searchParams.get("sessionId"),
          agentId: searchParams.get("agentId"),
          status: (searchParams.get("status") as "running" | "completed" | "failed" | null) ?? null,
          limit: Number(searchParams.get("limit")) || 50,
        }),
      });
    }

    type ExecRow = {
      id: string; workflow_id: string; status: string; trigger_type: string;
      trigger_data: string | null; provenance: string | null; node_results: string | null;
      started_at: string; completed_at: string | null; error: string | null;
    };

    if (action === "trace" && executionId) {
      const row = db.prepare("SELECT id, workflow_id, status, trigger_type, trigger_data, provenance, node_results, started_at, completed_at, error, parent_execution_id, parent_node_id FROM executions WHERE id = ?").get(executionId) as (ExecRow & { parent_execution_id: string | null; parent_node_id: string | null }) | undefined;
      if (!row) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
      const rawNodes = row.node_results ? JSON.parse(row.node_results) as Record<string, { output?: unknown; duration?: number; error?: string }> : {};
      const wfRow = db.prepare("SELECT name FROM workflows WHERE id = ?").get(row.workflow_id) as { name: string } | undefined;

      const children = db.prepare("SELECT id, workflow_id, status, started_at FROM executions WHERE parent_execution_id = ? ORDER BY started_at DESC LIMIT 20").all(executionId) as Array<{ id: string; workflow_id: string; status: string; started_at: string }>;
      const parent = row.parent_execution_id
        ? db.prepare("SELECT id, workflow_id, status FROM executions WHERE id = ?").get(row.parent_execution_id) as { id: string; workflow_id: string; status: string } | undefined
        : null;

      const resolveWorkflowName = (wfId: string) => {
        const wf = db.prepare("SELECT name FROM workflows WHERE id = ?").get(wfId) as { name: string } | undefined;
        return wf?.name ?? wfId;
      };

      return NextResponse.json({
        success: true,
        data: {
          executionId: row.id,
          workflowId: row.workflow_id,
          workflowName: wfRow?.name ?? row.workflow_id,
          status: row.status,
          triggerType: row.trigger_type,
          triggerData: row.trigger_data ? JSON.parse(row.trigger_data) as Record<string, unknown> : null,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          error: row.error,
          parentExecutionId: row.parent_execution_id,
          parentNodeId: row.parent_node_id,
          parent: parent ? { id: parent.id, workflowId: parent.workflow_id, workflowName: resolveWorkflowName(parent.workflow_id), status: parent.status } : null,
          children: children.map((c) => ({ id: c.id, workflowId: c.workflow_id, workflowName: resolveWorkflowName(c.workflow_id), status: c.status, startedAt: c.started_at })),
          debugger: getWorkflowExecutionTraceSummary({ executionId: row.id, limit: 100 }),
          nodes: Object.entries(rawNodes).map(([nodeId, r]) => ({
            nodeId,
            output: r.output ?? null,
            duration: r.duration ?? null,
            error: r.error ?? null,
          })),
        },
      });
    }

    let rows: ExecRow[];
    if (executionId) {
      rows = db.prepare("SELECT * FROM executions WHERE id = ?").all(executionId) as ExecRow[];
    } else if (workflowId) {
      rows = db.prepare("SELECT * FROM executions WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 20").all(workflowId) as ExecRow[];
    } else {
      rows = db.prepare("SELECT * FROM executions ORDER BY started_at DESC LIMIT 50").all() as ExecRow[];
    }

    const executions = rows.map((r) => ({
      id: r.id,
      workflowId: r.workflow_id,
      status: r.status,
      triggerType: r.trigger_type,
      triggerData: r.trigger_data ? JSON.parse(r.trigger_data) : null,
      provenance: r.provenance ? JSON.parse(r.provenance) : null,
      nodeResults: r.node_results ? JSON.parse(r.node_results) : {},
      startedAt: r.started_at,
      completedAt: r.completed_at,
      error: r.error,
    }));

    return NextResponse.json({ success: true, data: executionId ? (executions[0] ?? null) : executions });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  const ip = getClientIp(request);
  const rl = checkRateLimit(`execute:${ip}`, getRateLimitConfig().execute, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { success: false, error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  try {
    initializeDatabase();
    const body = await readCappedJson<unknown>(request, 256 * 1024);
    const parsed = executeSchema.parse(sanitizeStructuredJson(body));
    const db = getSqlite();

    const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(parsed.workflowId) as {
      id: string; name: string; nodes: string; edges: string;
    } | undefined;

    if (!row) {
      return NextResponse.json({ success: false, error: "Workflow not found" }, { status: 404 });
    }

    const nodes = JSON.parse(row.nodes);
    const edges = JSON.parse(row.edges);
    const modelConfig = getModelConfig();

    const nodeNameMap: Record<string, string> = {};
    for (const n of nodes) {
      nodeNameMap[n.id] = (n.data?.label as string) || n.id;
    }

    const result = await executeWorkflow({
      workflowId: parsed.workflowId,
      nodes,
      edges,
      triggerType: parsed.triggerType === "cron" ? "manual" : parsed.triggerType,
      triggerData: sanitizeStructuredJson(parsed.triggerData || {}),
      provenance: sanitizeStructuredJson(parsed.provenance || null),
      modelConfig,
      executionMode: parsed.executionMode ?? "full",
      targetNodeId: parsed.targetNodeId ?? null,
      startNodeId: parsed.startNodeId ?? null,
      pinnedData: parsed.usePinnedData === false ? null : getPinnedDataForExecution(parsed.workflowId),
      onNodeStart: (nodeId) => {
        broadcastEvent("node:active", { nodeId });
      },
      onNodeComplete: (nodeId, nodeResult) => {
        broadcastEvent("stream:end", { nodeId });
        broadcastEvent("execution:log", {
          timestamp: new Date().toISOString(),
          nodeId,
          nodeName: nodeNameMap[nodeId] || nodeId,
          message: nodeResult.error
            ? `Error: ${nodeResult.error}`
            : `Completed in ${nodeResult.duration}ms`,
          type: nodeResult.error ? "error" : "success",
        });
      },
      onEmit: (event, data) => {
        broadcastEvent(event, data);
      },
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
