import type { WorkflowNode, WorkflowEdge } from "@/types/workflow";

export type SubgraphResult = {
  nodesToExecute: string[];
  upstreamNodes: string[];
  downstreamNodes: string[];
  missingUpstreamInputs: string[];
};

export function computeUpstreamSubgraph(
  targetNodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): SubgraphResult {
  const nodeIds = new Set(nodes.map((n) => n.id));

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      incoming.get(edge.target)?.push(edge.source);
      outgoing.get(edge.source)?.push(edge.target);
    }
  }

  const upstream = new Set<string>();
  const queue = [targetNodeId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    upstream.add(current);
    for (const parent of incoming.get(current) ?? []) {
      if (!visited.has(parent)) queue.push(parent);
    }
  }

  const downstream = new Set<string>();
  const downQueue = outgoing.get(targetNodeId) ?? [];
  const downVisited = new Set<string>();
  while (downQueue.length > 0) {
    const current = downQueue.shift()!;
    if (downVisited.has(current)) continue;
    downVisited.add(current);
    downstream.add(current);
    for (const child of outgoing.get(current) ?? []) {
      if (!downVisited.has(child)) downQueue.push(child);
    }
  }

  const nodesToExecute = Array.from(upstream);
  const upstreamNodes = Array.from(upstream).filter((id) => id !== targetNodeId);
  const downstreamNodes = Array.from(downstream);

  const missingUpstreamInputs: string[] = [];
  const triggerNode = nodes.find((n) => n.type?.includes("trigger"));
  if (!triggerNode) {
    missingUpstreamInputs.push("no trigger node found in workflow");
  } else if (!upstream.has(triggerNode.id) && upstream.size > 0) {
    missingUpstreamInputs.push(`trigger node ${triggerNode.id} not in upstream subgraph`);
  }

  return { nodesToExecute, upstreamNodes, downstreamNodes, missingUpstreamInputs };
}
