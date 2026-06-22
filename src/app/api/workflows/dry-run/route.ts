import { NextRequest, NextResponse } from "next/server";
import { lintWorkflow } from "@/lib/engine/linter";
import { getNodeContract, isMutatingNode } from "@/lib/engine/node-contracts";
import { buildWorkflowGraphPlan, describeWorkflowGraphPlan } from "@/lib/engine/graph-runtime";
import { checkNodeCompatibility } from "@/lib/engine/node-compatibility";
import { requireOperatorAccess } from "@/lib/security/admin";
import { logger } from "@/lib/utils/logger";

const log = logger.child("api:workflows:dry-run");

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const body = await request.json() as Record<string, unknown>;
    const nodes = Array.isArray(body.nodes) ? body.nodes : [];
    const edges = Array.isArray(body.edges) ? body.edges : [];
    const sampleTriggerData = typeof body.sampleTriggerData === "object" && body.sampleTriggerData
      ? body.sampleTriggerData as Record<string, unknown>
      : { message: "Sample trigger data", sender: "user", timestamp: new Date().toISOString() };
    const triggerType = body.triggerType === "webhook" || body.triggerType === "cron" || body.triggerType === "manual" || body.triggerType === "message"
      ? body.triggerType
      : "manual";

    // 1. Lint
    const lint = lintWorkflow(nodes as Parameters<typeof lintWorkflow>[0], edges as Parameters<typeof lintWorkflow>[1]);

    // 2. Analyze each node
    const nodeAnalysis = (nodes as Array<{ id: string; type?: string; data?: Record<string, unknown> }>).map((node) => {
      const contract = getNodeContract(node.type || "");
      const isMutating = isMutatingNode(node.type || "");
      const configFields = contract?.configFields.map((f) => {
        const value = node.data?.[f.key] ?? "";
        return { key: f.key, label: f.label, value, required: f.required ?? false };
      }) ?? [];

      return {
        id: node.id,
        type: node.type || "unknown",
        label: String(node.data?.label || node.id),
        category: contract?.category || "unknown",
        sideEffect: contract?.sideEffect || "unknown",
        isMutating,
        wouldRunInDryRun: !isMutating || (isMutating && body.allowMutations === true),
        configFields,
        missingRequired: configFields.filter((f) => f.required && (!f.value || String(f.value).trim() === "")),
      };
    });

    // 3. Edge analysis
    const edgeAnalysis = (edges as Array<{ id: string; source: string; target: string; sourceHandle?: string }>).map((edge) => {
      const sourceNode = (nodes as Array<{ id: string; data?: Record<string, unknown> }>).find((n) => n.id === edge.source);
      const targetNode = (nodes as Array<{ id: string; data?: Record<string, unknown> }>).find((n) => n.id === edge.target);
      return {
        id: edge.id,
        source: `${String(sourceNode?.data?.label || edge.source)} (${edge.source})${edge.sourceHandle ? ` → ${edge.sourceHandle}` : ""}`,
        target: `${String(targetNode?.data?.label || edge.target)} (${edge.target})`,
      };
    });

    // 4. Execution plan
    const graphPlan = buildWorkflowGraphPlan({
      nodes: nodes as Parameters<typeof buildWorkflowGraphPlan>[0]["nodes"],
      edges: edges as Parameters<typeof buildWorkflowGraphPlan>[0]["edges"],
      triggerType,
    });
    const executionOrder = graphPlan.topologicalOrder.length > 0
      ? graphPlan.topologicalOrder
      : buildExecutionOrder(nodes, edges);
    const compatibility = checkNodeCompatibility({
      nodes: nodes as Parameters<typeof checkNodeCompatibility>[0]["nodes"],
      edges: edges as Parameters<typeof checkNodeCompatibility>[0]["edges"],
    });
    const mutatingNodes = nodeAnalysis.filter((n) => n.isMutating);
    const wouldSucceed = lint.errors.length === 0;

    // 5. Simulated execution plan
    const simulatedSteps = executionOrder.map((nodeId, index) => {
      const node = nodeAnalysis.find((n) => n.id === nodeId);
      if (!node) return { nodeId, label: nodeId, status: "unknown", description: "Node removed during analysis" };
      if (node.isMutating && body.allowMutations !== true) {
        return { nodeId, label: node.label, status: "simulated", description: `Would ${contractStr(node)} — simulated in dry run` };
      }
      const missing = node.missingRequired;
      if (missing.length > 0) {
        return { nodeId, label: node.label, status: "blocked", description: `Missing required fields: ${missing.map((m) => m.label).join(", ")}` };
      }
      return { nodeId, label: node.label, status: "ready", description: `Would execute as ${node.sideEffect}` };
    });

    const result = {
      success: true,
      data: {
        lint: {
          errors: lint.errors,
          warnings: lint.warnings,
          infos: lint.infos,
        },
        nodeAnalysis,
        edgeAnalysis: edgeAnalysis.slice(0, 50),
        executionOrder,
        graph: {
          triggerNodeId: graphPlan.triggerNode?.id ?? null,
          cycles: graphPlan.cycles,
          summary: describeWorkflowGraphPlan(graphPlan),
        },
        compatibility,
        mutatingNodes: mutatingNodes.map((n) => ({ id: n.id, label: n.label, type: n.type })),
        wouldSucceed,
        simulatedSteps,
        recommendation: wouldSucceed
          ? (mutatingNodes.length > 0 && body.allowMutations !== true
            ? "Lint passes. Mutating nodes would be simulated. Set allowMutations=true for a real run."
            : "Lint passes. Workflow is ready to execute.")
          : `Lint found ${lint.errors.length} errors and ${lint.warnings.length} warnings. Fix issues before executing.`,
      },
    };

    return NextResponse.json(result);
  } catch (error) {
    log.error("Dry run failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

function contractStr(node: { type?: string; sideEffect?: string }): string {
  return `${node.type || "node"}: ${node.sideEffect || "unknown"}`;
}

function buildExecutionOrder(nodes: unknown[], edges: unknown[]): string[] {
  const nodeArray = nodes as Array<{ id: string }>;
  const edgeArray = edges as Array<{ source: string; target: string }>;
  const order: string[] = [];
  const visited = new Set<string>();
  const adjacency = new Map<string, string[]>();

  for (const edge of edgeArray) {
    const targets = adjacency.get(edge.source) || [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }

  const triggers = nodeArray.filter((n) => (n as Record<string, unknown>).type && String((n as Record<string, unknown>).type).includes("trigger"));
  const startNodes = triggers.length > 0 ? triggers : [nodeArray[0]].filter(Boolean);

  const queue = startNodes.map((n) => n.id);
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    order.push(nodeId);
    for (const target of adjacency.get(nodeId) || []) {
      if (!visited.has(target)) queue.push(target);
    }
  }

  return order;
}
