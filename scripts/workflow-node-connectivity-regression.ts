import fs from "node:fs";
import path from "node:path";

type Check = {
  name: string;
  ok: boolean;
  detail: string;
};

const checks: Check[] = [];

function push(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
}

function read(relPath: string): string {
  return fs.readFileSync(path.resolve(relPath), "utf8");
}

function parseWorkflowNodeTypes(source: string): string[] {
  const typeNames = [
    "TriggerNodeType",
    "AgentNodeType",
    "ChannelNodeType",
    "LogicNodeType",
    "MemoryNodeType",
    "ToolNodeType",
    "IntegrationNodeType",
    "VoiceNodeType",
  ];
  const values = new Set<string>();
  for (const typeName of typeNames) {
    const match = source.match(new RegExp(`export type ${typeName}\\s*=\\s*([\\s\\S]*?);`));
    if (!match) continue;
    for (const item of match[1].matchAll(/"([^"]+)"/g)) {
      values.add(item[1]);
    }
  }
  return Array.from(values);
}

function parseCanvasMapping(source: string): Map<string, string> {
  const match = source.match(/const nodeTypes: NodeTypes = \{([\s\S]*?)\n\};/);
  const entries = new Map<string, string>();
  if (!match) return entries;
  for (const item of match[1].matchAll(/"([^"]+)":\s*([A-Za-z0-9_]+)/g)) {
    entries.set(item[1], item[2]);
  }
  return entries;
}

function countHandles(source: string, type: "target" | "source"): number {
  // Literal <Handle> elements — used directly by advanced-node.tsx and by
  // callers that pass `extraHandles` to BaseNode (e.g. if-else true/false).
  const literal = source.match(new RegExp(`<Handle\\s+type="${type}"`, "g"))?.length ?? 0;
  // V94: most node components render through <BaseNode>, which renders the
  // target/source handle by default (hasTarget/hasSource default to true) and
  // only omits it when the caller passes `hasTarget={false}`/`hasSource={false}`.
  const prop = type === "target" ? "hasTarget" : "hasSource";
  const baseNodes = source.match(/<BaseNode\b/g)?.length ?? 0;
  const disabled = source.match(new RegExp(`${prop}=\\{false\\}`, "g"))?.length ?? 0;
  return literal + Math.max(0, baseNodes - disabled);
}

function main() {
  const typeSource = read("src/types/workflow.ts");
  const canvasSource = read("src/components/workflow/canvas.tsx");
  const storeSource = read("src/stores/workflow-store.ts");
  const executorSource = read("src/lib/engine/executor.ts");
  const linterSource = read("src/lib/engine/linter.ts");

  const workflowNodeTypes = parseWorkflowNodeTypes(typeSource);
  const canvasMapping = parseCanvasMapping(canvasSource);

  push(
    "workflow.canvas.mappingCount",
    workflowNodeTypes.length > 0 && canvasMapping.size >= workflowNodeTypes.length,
    `workflowNodeTypes=${workflowNodeTypes.length} canvasMappings=${canvasMapping.size}`,
  );

  for (const nodeType of workflowNodeTypes) {
    push(
      `workflow.canvas.has.${nodeType}`,
      canvasMapping.has(nodeType),
      canvasMapping.has(nodeType) ? `component=${canvasMapping.get(nodeType)}` : "missing from canvas mapping",
    );
  }

  const componentSources = new Map<string, string>([
    ["TriggerNode", read("src/components/nodes/trigger-node.tsx")],
    ["AgentNode", read("src/components/nodes/agent-node.tsx")],
    ["ParallelAgentsNode", read("src/components/nodes/agent-node.tsx")],
    ["CallWorkflowNode", read("src/components/nodes/code-node.tsx")],
    ["SpawnCodingAgentNode", read("src/components/nodes/code-node.tsx")],
    ["ChannelNode", read("src/components/nodes/channel-node.tsx")],
    ["EmailNode", read("src/components/nodes/email-node.tsx")],
    ["LogicNode", read("src/components/nodes/logic-node.tsx")],
    ["SwitchNode", read("src/components/nodes/data-node.tsx")],
    ["DelayNode", read("src/components/nodes/data-node.tsx")],
    ["SetVariablesNode", read("src/components/nodes/data-node.tsx")],
    ["FilterNode", read("src/components/nodes/data-node.tsx")],
    ["MemoryNode", read("src/components/nodes/memory-node.tsx")],
    ["StickyNoteNode", read("src/components/nodes/sticky-note-node.tsx")],
    ["ToolNode", read("src/components/nodes/tool-node.tsx")],
    ["HttpNode", read("src/components/nodes/http-node.tsx")],
    ["CodeNode", read("src/components/nodes/code-node.tsx")],
    ["ReadFileNode", read("src/components/nodes/file-node.tsx")],
    ["WriteFileNode", read("src/components/nodes/file-node.tsx")],
    ["VoiceSttNode", read("src/components/nodes/voice-node.tsx")],
    ["VoiceTtsNode", read("src/components/nodes/voice-node.tsx")],
    ["LoopNode", read("src/components/nodes/advanced-node.tsx")],
    ["AggregateNode", read("src/components/nodes/advanced-node.tsx")],
    ["MergeNode", read("src/components/nodes/advanced-node.tsx")],
    ["ErrorHandlerNode", read("src/components/nodes/advanced-node.tsx")],
    ["WaitForInputNode", read("src/components/nodes/advanced-node.tsx")],
    ["JsonTransformNode", read("src/components/nodes/advanced-node.tsx")],
    ["SplitTextNode", read("src/components/nodes/advanced-node.tsx")],
    ["RegexExtractNode", read("src/components/nodes/advanced-node.tsx")],
    ["CompareTextNode", read("src/components/nodes/advanced-node.tsx")],
    ["RateLimiterNode", read("src/components/nodes/advanced-node.tsx")],
    ["DatabaseQueryNode", read("src/components/nodes/advanced-node.tsx")],
    ["ClipboardNode", read("src/components/nodes/advanced-node.tsx")],
    ["NotificationNode", read("src/components/nodes/advanced-node.tsx")],
    ["GitOperationNode", read("src/components/nodes/advanced-node.tsx")],
    ["ArchiveNode", read("src/components/nodes/advanced-node.tsx")],
  ]);

  for (const [nodeType, componentName] of canvasMapping.entries()) {
    const source = componentSources.get(componentName);
    if (!source) {
      push(`workflow.componentSource.${nodeType}`, false, `no source registered for ${componentName}`);
      continue;
    }
    const targets = countHandles(source, "target");
    const sources = countHandles(source, "source");
    const isTrigger = nodeType.includes("trigger");
    const isAnnotation = nodeType === "sticky-note";
    const isTerminalChannel =
      nodeType.startsWith("send-") &&
      nodeType !== "send-email";
    const expectTarget = !isTrigger && !isAnnotation;
    const expectSource = !isTerminalChannel && !isAnnotation;
    push(
      `workflow.handles.${nodeType}`,
      (!expectTarget || targets > 0) && (!expectSource || sources > 0),
      `component=${componentName} targets=${targets} sources=${sources}`,
    );
  }

  push(
    "workflow.store.onConnect.addEdge",
    storeSource.includes("edges: addEdge(connection, get().edges)"),
    "workflow store uses React Flow addEdge for connections",
  );
  push(
    "workflow.executor.sourceHandleAware",
    executorSource.includes("sourceHandle") && executorSource.includes("branchEdge"),
    "executor uses sourceHandle-aware branch routing",
  );
  push(
    "workflow.linter.cycleAndDisconnectedChecks",
    linterSource.includes("Cycle detected in workflow graph") &&
      linterSource.includes("not reachable from any trigger") &&
      linterSource.includes("has no outgoing connections"),
    "linter keeps cycle, disconnected, and dead-end checks",
  );

  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${checks.length - failed.length} passed / ${failed.length} failed`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main();
