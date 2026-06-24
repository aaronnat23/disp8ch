import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getSqlite, initializeDatabase } from "@/lib/db";
import {
  decideApproval,
  getApproval,
  listApprovalsForExecution,
  listPendingApprovals,
} from "@/lib/engine/workflow-approvals";

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const executionId = request.nextUrl.searchParams.get("executionId");
    initializeDatabase();
    const db = getSqlite();
    const records = executionId ? listApprovalsForExecution(executionId) : listPendingApprovals();
    const workflowCache = new Map<string, { name: string; labels: Map<string, string> }>();
    const data = records.map((record) => {
      let workflow = workflowCache.get(record.workflowId);
      if (!workflow) {
        const row = db.prepare("SELECT name, nodes FROM workflows WHERE id = ?").get(record.workflowId) as { name?: string; nodes?: string } | undefined;
        const labels = new Map<string, string>();
        try {
          const nodes = JSON.parse(String(row?.nodes || "[]")) as Array<{ id?: string; data?: { label?: string } }>;
          for (const node of nodes) {
            if (node.id) labels.set(node.id, String(node.data?.label || node.id));
          }
        } catch { /* malformed legacy graph */ }
        workflow = { name: String(row?.name || record.workflowId), labels };
        workflowCache.set(record.workflowId, workflow);
      }
      return {
        ...record,
        workflowName: workflow.name,
        nodeLabel: workflow.labels.get(record.nodeId) || record.nodeId,
      };
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = (await request.json()) as { id?: string; decision?: "approve" | "deny"; note?: string };
    const id = String(body.id ?? "").trim();
    const decision = body.decision;
    if (!id || (decision !== "approve" && decision !== "deny")) {
      return NextResponse.json(
        { success: false, error: "id and decision ('approve' | 'deny') are required" },
        { status: 400 },
      );
    }
    const existing = getApproval(id);
    if (!existing) {
      return NextResponse.json({ success: false, error: "approval not found" }, { status: 404 });
    }
    if (existing.status !== "pending") {
      return NextResponse.json(
        { success: false, error: `approval already ${existing.status}`, data: existing },
        { status: 409 },
      );
    }
    const result = decideApproval({
      id,
      decision: decision === "approve" ? "approved" : "denied",
      decidedBy: "operator",
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
