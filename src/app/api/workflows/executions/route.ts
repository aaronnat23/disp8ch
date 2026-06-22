import { NextRequest, NextResponse } from "next/server";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { executeWorkflow } from "@/lib/engine/executor";
import { getModelConfig } from "@/lib/agents/model-router";
import { getPinnedDataForExecution } from "@/lib/workflows/pin-data";
import { requireOperatorAccess } from "@/lib/security/admin";
import { sanitizeStructuredJson } from "@/lib/security/json";

export const dynamic = "force-dynamic";

function safeJson(raw: string | null): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function durationMs(startedAt: string, completedAt: string | null): number | null {
  if (!completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status")?.trim();
    const workflowId = searchParams.get("workflowId")?.trim();
    const limit = Math.max(1, Math.min(500, Number(searchParams.get("limit")) || 100));
    const where: string[] = [];
    const values: unknown[] = [];
    if (status) {
      where.push("e.status = ?");
      values.push(status);
    }
    if (workflowId) {
      where.push("e.workflow_id = ?");
      values.push(workflowId);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT e.id, e.workflow_id, w.name AS workflow_name, e.status, e.trigger_type, e.trigger_data,
                e.started_at, e.completed_at, e.error
           FROM executions e
           LEFT JOIN workflows w ON w.id = e.workflow_id
          ${whereSql}
          ORDER BY e.started_at DESC
          LIMIT ?`,
      )
      .all(...values, limit) as Array<{
        id: string;
        workflow_id: string;
        workflow_name: string | null;
        status: string;
        trigger_type: string;
        trigger_data: string | null;
        started_at: string;
        completed_at: string | null;
        error: string | null;
      }>;
    return NextResponse.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        workflowId: row.workflow_id,
        workflowName: row.workflow_name || row.workflow_id,
        status: row.status,
        triggerType: row.trigger_type,
        triggerData: sanitizeStructuredJson(safeJson(row.trigger_data)),
        startedAt: row.started_at,
        completedAt: row.completed_at,
        durationMs: durationMs(row.started_at, row.completed_at),
        errorSummary: row.error ? String(row.error).slice(0, 400) : null,
      })),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || "").trim().toLowerCase();
    if (action !== "retry" && action !== "retry-from-failed-node") {
      return NextResponse.json({ success: false, error: "action must be retry or retry-from-failed-node" }, { status: 400 });
    }
    const executionId = String(body.executionId || "").trim();
    if (!executionId) return NextResponse.json({ success: false, error: "executionId is required" }, { status: 400 });
    const execRow = db.prepare("SELECT * FROM executions WHERE id = ?").get(executionId) as {
      id: string;
      workflow_id: string;
      trigger_type: string;
      trigger_data: string | null;
      provenance: string | null;
      node_results: string | null;
    } | undefined;
    if (!execRow) return NextResponse.json({ success: false, error: "Execution not found" }, { status: 404 });
    const workflow = db.prepare("SELECT id, nodes, edges FROM workflows WHERE id = ?").get(execRow.workflow_id) as {
      id: string;
      nodes: string;
      edges: string;
    } | undefined;
    if (!workflow) return NextResponse.json({ success: false, error: "Workflow not found" }, { status: 404 });

    const nodeResults = safeJson(execRow.node_results) || {};
    const failedNodeId = Object.entries(nodeResults).find(([, value]) => Boolean((value as any)?.error))?.[0] || null;
    const triggerType = ["message", "webhook", "manual", "cron"].includes(execRow.trigger_type)
      ? (execRow.trigger_type === "cron" ? "manual" : execRow.trigger_type) as "message" | "webhook" | "manual"
      : "manual";
    const result = await executeWorkflow({
      workflowId: workflow.id,
      nodes: JSON.parse(workflow.nodes),
      edges: JSON.parse(workflow.edges),
      triggerType,
      triggerData: sanitizeStructuredJson(safeJson(execRow.trigger_data) || {}),
      provenance: sanitizeStructuredJson({ retryOf: executionId, ...(safeJson(execRow.provenance) || {}) }),
      modelConfig: getModelConfig(),
      executionMode: action === "retry-from-failed-node" && failedNodeId ? "from-node" : "full",
      startNodeId: action === "retry-from-failed-node" ? failedNodeId : null,
      pinnedData: getPinnedDataForExecution(workflow.id),
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
