import type { WorkflowEdge, WorkflowNode } from "@/types/workflow";
import { getNodeContractOrFallback } from "@/lib/engine/node-contracts";

export type NodeCompatibilityIssue = {
  severity: "error" | "warning";
  source: string;
  target: string;
  message: string;
  suggestion: string;
};

function outputsFor(node: WorkflowNode): Set<string> {
  const contract = getNodeContractOrFallback(String(node.type || ""));
  return new Set(contract.outputSchema.fields.map((field) => field.path));
}

function inputsFor(node: WorkflowNode): Set<string> {
  const contract = getNodeContractOrFallback(String(node.type || ""));
  const schemaFields = contract.inputSchema?.fields.map((field) => field.path) ?? [];
  const requiredConfigFields = contract.configFields
    .filter((field) => field.required)
    .map((field) => field.key);
  return new Set([...schemaFields, ...requiredConfigFields]);
}

export function checkNodeCompatibility(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): NodeCompatibilityIssue[] {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const issues: NodeCompatibilityIssue[] = [];
  for (const edge of input.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const sourceOutputs = outputsFor(source);
    const targetInputs = inputsFor(target);
    if (targetInputs.size === 0) continue;
    const overlap = Array.from(targetInputs).filter((field) => sourceOutputs.has(field));
    if (overlap.length === 0 && sourceOutputs.size > 0) {
      issues.push({
        severity: "warning",
        source: source.id,
        target: target.id,
        message: `No obvious output field from ${source.type} satisfies required input fields for ${target.type}.`,
        suggestion: `Use the field picker or an explicit expression to map one of: ${Array.from(sourceOutputs).slice(0, 8).join(", ")}.`,
      });
    }
  }
  return issues;
}
