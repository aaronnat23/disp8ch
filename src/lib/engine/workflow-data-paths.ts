import type { WorkflowNode, WorkflowEdge } from "@/types/workflow";
import type { NodeResult } from "@/types/execution";
import { getNodeContract } from "@/lib/engine/node-contracts";

export type UpstreamFieldRef = {
  nodeId: string;
  nodeLabel: string;
  nodeType: string;
  fieldPath: string;
  fieldLabel: string;
  display: string;
  templatePath: string;
};

export function resolveUpstreamNodes(
  currentNodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  nodeResults?: Record<string, NodeResult>,
): Array<{ node: WorkflowNode; fields: Array<{ path: string; label: string; type: string }>; sampleOutput?: Record<string, unknown> }> {
  const upstream: Array<{ node: WorkflowNode; fields: Array<{ path: string; label: string; type: string }>; sampleOutput?: Record<string, unknown> }> = [];
  const visited = new Set<string>();
  const queue = [currentNodeId];

  while (queue.length > 0) {
    const targetId = queue.shift()!;
    for (const edge of edges) {
      if (edge.target === targetId && !visited.has(edge.source)) {
        visited.add(edge.source);
        const sourceNode = nodes.find((n) => n.id === edge.source);
        if (sourceNode && sourceNode.type) {
          const contract = getNodeContract(sourceNode.type);
          const result = nodeResults?.[sourceNode.id];
          upstream.push({
            node: sourceNode,
            fields: (contract?.outputSchema?.fields ?? [{ path: "result", label: "Result", type: "unknown" }]).map((f) => ({
              path: f.path,
              label: f.label,
              type: f.type,
            })),
            sampleOutput: result?.output,
          });
          queue.push(edge.source);
        }
      }
    }
  }

  return upstream.reverse();
}

export function buildFieldPickerItems(
  currentNodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  nodeResults?: Record<string, NodeResult>,
): UpstreamFieldRef[] {
  const upstream = resolveUpstreamNodes(currentNodeId, nodes, edges, nodeResults);
  const items: UpstreamFieldRef[] = [];

  for (const { node, fields, sampleOutput } of upstream) {
    const label = String(node.data?.label || node.id);
    const safeLabel = label.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase().replace(/^_+|_+$/g, "") || node.id;

    for (const field of fields) {
      const templatePath = `nodes.${safeLabel}.${field.path}`;
      items.push({
        nodeId: node.id,
        nodeLabel: label,
        nodeType: node.type ?? "unknown",
        fieldPath: field.path,
        fieldLabel: field.label,
        display: `${label} → ${field.label}`,
        templatePath: `${templatePath}`,
      });
    }

    // Also expose entire output for the node
    items.push({
      nodeId: node.id,
      nodeLabel: label,
      nodeType: node.type ?? "unknown",
      fieldPath: "result",
      fieldLabel: "Full Output",
      display: `${label} → Full Output`,
      templatePath: `nodes.${safeLabel}.result`,
    });
  }

  return items;
}

export function buildSafeLabel(label: string, fallback: string): string {
  return (label || fallback).replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase().replace(/^_+|_+$/g, "") || fallback;
}

export function resolveNodeTemplatePath(nodeId: string, nodeLabel: string, field: string): string {
  const safe = buildSafeLabel(nodeLabel, nodeId);
  return `{{nodes.${safe}.${field}}}`;
}

export function validateTemplatePath(template: string, availableFields: UpstreamFieldRef[]): { valid: boolean; brokenRefs: string[] } {
  const refs = template.match(/\{\{(?:nodes|run|agent|http|trigger|vars|memory|message|cron|webhook)\.([^}]+)\}\}/g) ?? [];
  const brokenRefs: string[] = [];
  for (const ref of refs) {
    const path = ref.replace(/^\{\{/, "").replace(/\}\}$/, "");
    const found = availableFields.some((f) => f.templatePath === path || ref.includes(f.templatePath));
    if (!found) brokenRefs.push(ref);
  }
  return { valid: brokenRefs.length === 0, brokenRefs };
}

/**
 * Supported template path forms:
 *   {{trigger.field}}            — trigger data
 *   {{nodes.label.field}}        — output of upstream node by label
 *   {{vars.name}}                — variables from set-variables node
 *   {{loop.item.field}}          — loop context
 *   {{loop.index}}               — current loop index (number)
 *   {{loop.total}}               — total loop items (number)
 */
function getNestedValue(obj: unknown, parts: string[]): unknown {
  let cursor = obj;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export function resolvePathInData(
  path: string,
  context: Record<string, unknown>,
): { value: unknown; found: boolean; type: string } {
  // Strip {{ }} wrappers if present
  const cleaned = path.replace(/^\{\{/, "").replace(/\}\}$/, "").trim();
  const parts = cleaned.split(".");
  if (parts.length < 1 || !parts[0]) {
    return { value: undefined, found: false, type: "unknown" };
  }

  const value = getNestedValue(context, parts);
  if (value === undefined) {
    return { value: undefined, found: false, type: "unknown" };
  }
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  return { value, found: true, type };
}

export function detectBrokenReferences(
  template: string,
  context: Record<string, unknown>,
): string[] {
  const refs = template.match(/\{\{[^}]+\}\}/g) ?? [];
  const broken: string[] = [];
  for (const ref of refs) {
    const { found } = resolvePathInData(ref, context);
    if (!found) {
      broken.push(ref);
    }
  }
  return broken;
}

/**
 * Build a context object from execution data in the standard path forms.
 * Useful for calling resolvePathInData / detectBrokenReferences with real execution state.
 */
export function buildTemplateContext(params: {
  triggerData?: Record<string, unknown>;
  nodeOutputs?: Record<string, { label: string; output: Record<string, unknown> }>;
  variables?: Record<string, unknown>;
  loopItem?: unknown;
  loopIndex?: number;
  loopTotal?: number;
}): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};

  if (params.triggerData) {
    ctx["trigger"] = params.triggerData;
  }

  if (params.nodeOutputs) {
    const nodes: Record<string, unknown> = {};
    for (const [, entry] of Object.entries(params.nodeOutputs)) {
      const safeLabel = buildSafeLabel(entry.label, entry.label);
      nodes[safeLabel] = entry.output;
    }
    ctx["nodes"] = nodes;
  }

  if (params.variables) {
    ctx["vars"] = params.variables;
  }

  if (params.loopItem !== undefined || params.loopIndex !== undefined) {
    ctx["loop"] = {
      item: params.loopItem,
      index: params.loopIndex ?? 0,
      total: params.loopTotal ?? 0,
    };
  }

  return ctx;
}
