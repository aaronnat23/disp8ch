import type { WorkflowNode, WorkflowEdge } from "@/types/workflow";

const TEXT_PRODUCING_TYPES = new Set([
  "claude-agent",
  "integration-agent",
  "parallel-agents",
  "call-workflow",
  "run-code",
  "set-variables",
  "aggregate",
  "merge",
  "memory-recall",
  "llm-call",
  "code-runner",
]);

const CHANNEL_OUTPUT_TYPES = new Set([
  "send-webchat",
  "send-whatsapp",
]);

export interface NormalizationResult {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  warnings: string[];
}

function hasIncomingEdges(nodeId: string, edges: WorkflowEdge[]): boolean {
  return edges.some((e) => e.target === nodeId);
}

function getUpstreamNodeTypes(nodeId: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): Set<string> {
  const upstream = new Set<string>();
  const visited = new Set<string>();
  const queue = [nodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const edge of edges) {
      if (edge.target === current) {
        const sourceNode = nodes.find((n) => n.id === edge.source);
        if (sourceNode?.type) {
          upstream.add(sourceNode.type);
        }
        queue.push(edge.source);
      }
    }
  }

  return upstream;
}

function hasTextProducerUpstream(nodeId: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  const upstreamTypes = getUpstreamNodeTypes(nodeId, nodes, edges);
  for (const t of upstreamTypes) {
    if (TEXT_PRODUCING_TYPES.has(t)) return true;
  }
  return false;
}

function ensureNodeId(node: WorkflowNode, index: number): WorkflowNode {
  if (node.id) return node;
  return { ...node, id: `node-${index}-${Date.now()}` };
}

function ensurePosition(node: WorkflowNode, index: number): WorkflowNode {
  if (node.position) return node;
  return { ...node, position: { x: 250, y: index * 150 } };
}

function ensureLabel(node: WorkflowNode, index: number): WorkflowNode {
  if (node.data?.label) return node;
  const label = node.type
    ? `${node.type.charAt(0).toUpperCase() + node.type.slice(1).replace(/-/g, " ")} ${index + 1}`
    : `Node ${index + 1}`;
  return { ...node, data: { ...node.data, label } };
}

/**
 * Normalizes a workflow definition before save/run:
 * - Ensures all nodes have IDs, positions, and labels.
 * - For terminal send-webchat/send-whatsapp nodes with upstream text producers
 *   and no explicit message, sets message to "{{response}}".
 * - Preserves user-authored values.
 * - Emits warnings for automatic defaults.
 */
export function normalizeWorkflowDefinition(params: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  source?: string;
}): NormalizationResult {
  const { edges, source } = params;
  let nodes = [...params.nodes];
  const warnings: string[] = [];

  // Ensure all nodes have IDs, positions, and labels
  nodes = nodes.map((node, index) => {
    let normalized = ensureNodeId(node, index);
    normalized = ensurePosition(normalized, index);
    normalized = ensureLabel(normalized, index);
    return normalized;
  });

  // For terminal channel nodes missing message, infer from upstream
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node.type || !CHANNEL_OUTPUT_TYPES.has(node.type)) continue;

    const existingMessage =
      (node.data?.message as string | undefined) ??
      (typeof node.data?.config === "object" && node.data.config
        ? (node.data.config as Record<string, unknown>).message as string | undefined
        : undefined);

    if (existingMessage && existingMessage.trim()) continue;

    const hasUpstream = hasIncomingEdges(node.id, edges);
    const hasProducer = hasTextProducerUpstream(node.id, nodes, edges);

    if (hasUpstream && hasProducer) {
      // Infer message from upstream producer
      const inferredMessage = "{{response}}";
      nodes[i] = {
        ...node,
        data: {
          ...node.data,
          message: inferredMessage,
        },
      };
      warnings.push(
        `Node "${node.data?.label || node.id}" (${node.type}) had no message set. ` +
        `Automatically set to "${inferredMessage}" because an upstream text-producing node was detected. ` +
        `Source: ${source || "normalization"}.`
      );
    } else if (hasUpstream && !hasProducer) {
      // Has incoming edges but no known text producer — still try a generic fallback
      const inferredMessage = "{{response}}";
      nodes[i] = {
        ...node,
        data: {
          ...node.data,
          message: inferredMessage,
        },
      };
      warnings.push(
        `Node "${node.data?.label || node.id}" (${node.type}) had no message set. ` +
        `Set to "${inferredMessage}" as a fallback. Upstream nodes may not produce text. ` +
        `Source: ${source || "normalization"}.`
      );
    }
    // If no incoming edges at all, leave message empty — linter will flag it
  }

  return { nodes, edges, warnings };
}
