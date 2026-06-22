import type { NodeResult } from "@/types/execution";
import type { WorkflowNode } from "@/types/workflow";

export type ExecutionDataEntry = {
  nodeId: string;
  nodeLabel: string;
  output: Record<string, unknown>;
  fields: Array<{ path: string; valuePreview: string; type: string }>;
};

function preview(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 160);
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value).slice(0, 160);
  } catch {
    return String(value).slice(0, 160);
  }
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function collectFields(value: unknown, prefix = "", maxDepth = 4): Array<{ path: string; valuePreview: string; type: string }> {
  if (maxDepth < 0) return [];
  if (!value || typeof value !== "object") {
    return prefix ? [{ path: prefix, valuePreview: preview(value), type: typeOf(value) }] : [];
  }
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 80);
  const output: Array<{ path: string; valuePreview: string; type: string }> = [];
  for (const [key, child] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    output.push({ path, valuePreview: preview(child), type: typeOf(child) });
    if (child && typeof child === "object" && !Array.isArray(child)) {
      output.push(...collectFields(child, path, maxDepth - 1));
    }
  }
  return output.slice(0, 240);
}

export function buildExecutionDataMap(input: {
  nodes: WorkflowNode[];
  nodeResults: Record<string, NodeResult>;
}): ExecutionDataEntry[] {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  return Object.entries(input.nodeResults).map(([nodeId, result]) => {
    const node = nodeById.get(nodeId);
    const output = (result.output && typeof result.output === "object" && !Array.isArray(result.output))
      ? result.output as Record<string, unknown>
      : { value: result.output };
    const label = String((node?.data as { label?: unknown } | undefined)?.label || node?.type || nodeId);
    return {
      nodeId,
      nodeLabel: label,
      output,
      fields: collectFields(output),
    };
  });
}

export function resolveExecutionDataPath(input: {
  dataMap: ExecutionDataEntry[];
  expression: string;
}): unknown {
  const match = input.expression.match(/\{\{\s*nodes\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\s*\}\}/);
  if (!match) return undefined;
  const [, nodeRef, path] = match;
  const entry = input.dataMap.find((candidate) =>
    candidate.nodeId === nodeRef ||
    candidate.nodeLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_") === nodeRef.toLowerCase(),
  );
  if (!entry) return undefined;
  let cursor: unknown = entry.output;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}
