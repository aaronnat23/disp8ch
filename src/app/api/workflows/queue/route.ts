import { NextRequest, NextResponse } from "next/server";
import { getSqlite, initializeDatabase } from "@/lib/db";
import {
  deleteQueuedExecution,
  getWorkflowConcurrency,
  listQueuedExecutions,
  type QueuedExecutionStatus,
} from "@/lib/engine/execution-queue";
import { requireOperatorAccess } from "@/lib/security/admin";
import { sanitizeStructuredJson } from "@/lib/security/json";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const { searchParams } = new URL(request.url);
    const configWorkflowId = searchParams.get("configWorkflowId")?.trim();
    if (configWorkflowId) {
      return NextResponse.json({
        success: true,
        data: {
          concurrency: getWorkflowConcurrency(configWorkflowId),
          queuedCount: listQueuedExecutions({ workflowId: configWorkflowId }).length,
        },
      });
    }
    const workflowId = searchParams.get("workflowId")?.trim() || undefined;
    const statusParam = searchParams.get("status")?.trim();
    const status = (["queued", "started", "done", "failed", "all"].includes(statusParam || "")
      ? statusParam
      : "queued") as QueuedExecutionStatus | "all";
    const items = listQueuedExecutions({ workflowId, status, limit: 200 });
    const db = getSqlite();
    const nameRows = db.prepare("SELECT id, name FROM workflows").all() as Array<{ id: string; name: string }>;
    const names = new Map(nameRows.map((row) => [row.id, row.name]));
    return NextResponse.json({
      success: true,
      data: items.map((item) => ({
        ...item,
        workflowName: names.get(item.workflowId) || item.workflowId,
        triggerData: sanitizeStructuredJson(item.triggerData),
        provenance: sanitizeStructuredJson(item.provenance),
        concurrency: getWorkflowConcurrency(item.workflowId),
      })),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id")?.trim();
    if (!id) return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });
    const deleted = deleteQueuedExecution(id);
    if (!deleted) {
      return NextResponse.json(
        { success: false, error: "Queue item not found or no longer pending" },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
