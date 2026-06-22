import { NextRequest, NextResponse } from "next/server";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getWorkflowExecutionTraceSummary } from "@/lib/workflows/execution-traces";
import { inspectWorkflowCredentialHealth } from "@/lib/workflows/credential-health";
import { suggestNodeErrorRepair, validateWorkflowNodeConfig } from "@/lib/workflows/node-config-schema";
import { buildWorkflowRecoveryPlan } from "@/lib/workflows/recovery-plan";
import type { WorkflowEdge, WorkflowNode } from "@/types/workflow";

export const dynamic = "force-dynamic";

function readJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();
    const { searchParams } = new URL(request.url);
    const workflowId = searchParams.get("workflowId");
    const executionId = searchParams.get("executionId");
    if (!workflowId && !executionId) {
      return NextResponse.json({ success: false, error: "workflowId or executionId is required" }, { status: 400 });
    }

    const execution = executionId
      ? (db
          .prepare("SELECT id, workflow_id, status, started_at, completed_at, error FROM executions WHERE id = ?")
          .get(executionId) as
          | { id: string; workflow_id: string; status: string; started_at: string; completed_at: string | null; error: string | null }
          | undefined)
      : null;
    const resolvedWorkflowId = workflowId ?? execution?.workflow_id;
    if (!resolvedWorkflowId) {
      return NextResponse.json({ success: false, error: "Execution not found" }, { status: 404 });
    }

    const workflow = db.prepare("SELECT id, name, nodes, edges FROM workflows WHERE id = ?").get(resolvedWorkflowId) as
      | { id: string; name: string; nodes: string; edges: string }
      | undefined;
    if (!workflow) {
      return NextResponse.json({ success: false, error: "Workflow not found" }, { status: 404 });
    }

    const nodes = readJsonArray<WorkflowNode>(workflow.nodes);
    const edges = readJsonArray<WorkflowEdge>(workflow.edges);
    const trace = getWorkflowExecutionTraceSummary({ executionId, workflowId: resolvedWorkflowId, limit: 100 });
    const credentialHealth = inspectWorkflowCredentialHealth(nodes);
    const nodeConfig = nodes.map(validateWorkflowNodeConfig);
    const latestFailures = trace.failures.map((failure) => {
      const node = nodes.find((candidate) => candidate.id === failure.nodeId || failure.nodeId.startsWith(`${candidate.id}.loop.`));
      return {
        trace: failure,
        repair: node ? suggestNodeErrorRepair({ node, error: failure.error?.message ? String(failure.error.message) : null, output: failure.output }) : null,
      };
    });
    const workflowSummary = { id: workflow.id, name: workflow.name, nodeCount: nodes.length, edgeCount: edges.length };
    const recoveryPlan = buildWorkflowRecoveryPlan({
      workflow: workflowSummary,
      trace,
      credentialHealth,
      nodeConfig,
      latestFailures,
    });

    return NextResponse.json({
      success: true,
      data: {
        workflow: workflowSummary,
        execution,
        trace,
        credentialHealth,
        nodeConfig,
        latestFailures,
        recoveryPlan,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

/**
 * Credential configure-wizard helper (V156 Gap 4): safely attach a saved
 * credential reference to a single node and return refreshed credential health.
 * Only the target node's `credentialId` is changed; no secrets are stored in
 * the workflow JSON.
 */
export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const body = (await request.json()) as { action?: string; workflowId?: string; nodeId?: string; credentialId?: string };
    if (body.action !== "attach-credential") {
      return NextResponse.json({ success: false, error: "Unsupported action" }, { status: 400 });
    }
    const workflowId = String(body.workflowId || "").trim();
    const nodeId = String(body.nodeId || "").trim();
    const credentialId = String(body.credentialId || "").trim();
    if (!workflowId || !nodeId || !credentialId) {
      return NextResponse.json({ success: false, error: "workflowId, nodeId, and credentialId are required" }, { status: 400 });
    }

    const db = getSqlite();
    const { getWorkflowCredential } = await import("@/lib/workflows/credentials");
    const credential = getWorkflowCredential(credentialId);
    if (!credential) {
      return NextResponse.json({ success: false, error: "Credential not found" }, { status: 404 });
    }

    const wfRow = db.prepare("SELECT id, nodes FROM workflows WHERE id = ?").get(workflowId) as { id: string; nodes: string } | undefined;
    if (!wfRow) {
      return NextResponse.json({ success: false, error: "Workflow not found" }, { status: 404 });
    }
    const nodes = readJsonArray<WorkflowNode>(wfRow.nodes);
    const target = nodes.find((n) => n.id === nodeId);
    if (!target) {
      return NextResponse.json({ success: false, error: "Node not found in workflow" }, { status: 404 });
    }
    target.data = { ...(target.data ?? {}), credentialId };

    db.prepare("UPDATE workflows SET nodes = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(nodes),
      new Date().toISOString(),
      workflowId,
    );

    const credentialHealth = inspectWorkflowCredentialHealth(nodes);
    return NextResponse.json({ success: true, data: { credentialId, nodeId, credentialHealth } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
