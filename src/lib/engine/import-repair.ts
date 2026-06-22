import { nanoid } from "nanoid";
import type { WorkflowEdge, WorkflowNode } from "@/types/workflow";
import { getNodeContract } from "@/lib/engine/node-contracts";

export type WorkflowImportRepair = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  repairs: Array<{
    severity: "info" | "warning";
    message: string;
    before?: unknown;
    after?: unknown;
  }>;
};

function safeNodeType(type: unknown): string {
  const raw = String(type || "").trim();
  if (raw && getNodeContract(raw)) return raw;
  const compatNodePrefix = ["n", "8", "n", "-nodes-base."].join("");
  const normalized = raw
    .toLowerCase()
    .replace(new RegExp(`^${compatNodePrefix.replace(".", "\\.")}`), "")
    .replace(/[_\s]+/g, "-");
  const aliases: Record<string, string> = {
    webhook: "webhook-trigger",
    schedule: "cron-trigger",
    cron: "cron-trigger",
    manual: "manual-trigger",
    if: "if-else",
    switch: "switch",
    http: "http-request",
    "http-request": "http-request",
    code: "run-code",
    function: "run-code",
    set: "set-variables",
    "set-variables": "set-variables",
  };
  return aliases[normalized] ?? (getNodeContract(normalized) ? normalized : "sticky-note");
}

function nodePosition(index: number, raw: unknown): { x: number; y: number } {
  if (raw && typeof raw === "object") {
    const pos = raw as { x?: unknown; y?: unknown };
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  return { x: 180 + (index % 4) * 260, y: 120 + Math.floor(index / 4) * 180 };
}

export function repairImportedWorkflow(input: {
  nodes: unknown[];
  edges: unknown[];
}): WorkflowImportRepair {
  const repairs: WorkflowImportRepair["repairs"] = [];
  const usedIds = new Set<string>();
  const idMap = new Map<string, string>();
  const nodes = input.nodes.map((raw, index) => {
    const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const originalId = String(obj.id || obj.name || "").trim();
    let id = originalId || nanoid(8);
    if (usedIds.has(id)) id = `${id}-${nanoid(4)}`;
    usedIds.add(id);
    if (originalId) idMap.set(originalId, id);
    const type = safeNodeType(obj.type);
    if (type !== obj.type) {
      repairs.push({ severity: "warning", message: "Normalized unsupported or external node type.", before: obj.type, after: type });
    }
    return {
      id,
      type,
      position: nodePosition(index, obj.position),
      data: {
        ...(obj.data && typeof obj.data === "object" ? obj.data as Record<string, unknown> : {}),
        label: String((obj.data as { label?: unknown } | undefined)?.label || obj.name || type),
      },
    } as WorkflowNode;
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: WorkflowEdge[] = [];
  for (const raw of input.edges) {
    const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const source = idMap.get(String(obj.source || "")) ?? String(obj.source || "");
    const target = idMap.get(String(obj.target || "")) ?? String(obj.target || "");
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      repairs.push({ severity: "warning", message: "Dropped edge with missing source or target.", before: obj });
      continue;
    }
    edges.push({
      id: String(obj.id || `e-${source}-${target}-${nanoid(4)}`),
      source,
      target,
      sourceHandle: typeof obj.sourceHandle === "string" ? obj.sourceHandle : null,
      targetHandle: typeof obj.targetHandle === "string" ? obj.targetHandle : null,
    } as WorkflowEdge);
  }

  if (nodes.length > 0 && !nodes.some((node) => String(node.type).includes("trigger"))) {
    repairs.push({ severity: "info", message: "Imported graph had no trigger; added manual trigger." });
    const triggerId = `manual-${nanoid(6)}`;
    nodes.unshift({
      id: triggerId,
      type: "manual-trigger",
      position: { x: 0, y: 120 },
      data: { label: "Manual Trigger" },
    } as WorkflowNode);
    edges.unshift({
      id: `e-${triggerId}-${nodes[1].id}`,
      source: triggerId,
      target: nodes[1].id,
    } as WorkflowEdge);
  }

  return { nodes, edges, repairs };
}
