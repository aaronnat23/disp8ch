import type { WorkflowEdge, WorkflowNode } from "@/types/workflow";

export type WorkflowGraphPlan = {
  adjacency: Map<string, Array<{ target: string; sourceHandle?: string | null }>>;
  incoming: Map<string, Array<{ source: string; sourceHandle?: string | null }>>;
  triggerNode: WorkflowNode | null;
  topologicalOrder: string[];
  cycles: string[][];
};

function triggerTypeForNode(node: WorkflowNode): string {
  return String(node.type || "").toLowerCase();
}

export function findTriggerNode(input: {
  nodes: WorkflowNode[];
  triggerType: "message" | "webhook" | "manual" | "cron";
}): WorkflowNode | null {
  const exactType = `${input.triggerType}-trigger`;
  return input.nodes.find((node) => triggerTypeForNode(node) === exactType) ??
    input.nodes.find((node) => triggerTypeForNode(node).includes("trigger")) ??
    null;
}

export function buildWorkflowGraphPlan(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  triggerType: "message" | "webhook" | "manual" | "cron";
}): WorkflowGraphPlan {
  const adjacency = new Map<string, Array<{ target: string; sourceHandle?: string | null }>>();
  const incoming = new Map<string, Array<{ source: string; sourceHandle?: string | null }>>();
  for (const node of input.nodes) {
    adjacency.set(node.id, adjacency.get(node.id) ?? []);
    incoming.set(node.id, incoming.get(node.id) ?? []);
  }
  for (const edge of input.edges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), { target: edge.target, sourceHandle: edge.sourceHandle }]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), { source: edge.source, sourceHandle: edge.sourceHandle }]);
  }

  const indegree = new Map<string, number>();
  for (const node of input.nodes) indegree.set(node.id, incoming.get(node.id)?.length ?? 0);
  const queue = input.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const topologicalOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topologicalOrder.push(id);
    for (const edge of adjacency.get(id) ?? []) {
      const next = Math.max(0, (indegree.get(edge.target) ?? 0) - 1);
      indegree.set(edge.target, next);
      if (next === 0) queue.push(edge.target);
    }
  }

  const cycleNodes = input.nodes.map((node) => node.id).filter((id) => !topologicalOrder.includes(id));
  return {
    adjacency,
    incoming,
    triggerNode: findTriggerNode(input),
    topologicalOrder,
    cycles: cycleNodes.length > 0 ? [cycleNodes] : [],
  };
}

export function describeWorkflowGraphPlan(plan: WorkflowGraphPlan): string {
  return [
    `Trigger: ${plan.triggerNode?.id ?? "none"}`,
    `Nodes in execution order: ${plan.topologicalOrder.join(" -> ") || "none"}`,
    plan.cycles.length ? `Cycle candidates: ${plan.cycles.map((cycle) => cycle.join(" -> ")).join("; ")}` : "Cycle candidates: none",
  ].join("\n");
}
