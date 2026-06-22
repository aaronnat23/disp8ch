import type { WorkflowNode, WorkflowEdge } from "@/types/workflow";
import type { LintResult, LintIssue, LintSeverity } from "@/types/execution";
import { getAgentById } from "@/lib/agents/registry";
import { getNodeContract, isMutatingNode } from "@/lib/engine/node-contracts";
import { parseExpressionSafe } from "@/lib/engine/expressions";

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

function issue(nodeId: string, message: string, type: string, severity: LintSeverity = "error"): LintIssue {
  return { nodeId, message, type, severity };
}

function hasTextProducerUpstream(
  nodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): boolean {
  const visited = new Set<string>();
  const queue = [nodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const edge of edges) {
      if (edge.target === current) {
        const sourceNode = nodes.find((n) => n.id === edge.source);
        if (sourceNode?.type && TEXT_PRODUCING_TYPES.has(sourceNode.type)) return true;
        queue.push(edge.source);
      }
    }
  }

  return false;
}

export function lintWorkflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): LintResult {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  const infos: LintIssue[] = [];

  // Check for trigger nodes
  const triggerNodes = nodes.filter((n) => n.type?.includes("trigger"));
  if (triggerNodes.length === 0) {
    errors.push(issue("", "Workflow must have at least one trigger node", "no-trigger"));
  }
  if (triggerNodes.length > 1) {
    infos.push(issue("", "Multiple triggers detected — only the matching trigger type will fire", "multiple-triggers", "info"));
  }

  // Build adjacency
  const adjacency = new Map<string, { target: string; sourceHandle?: string | null }[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    const targets = adjacency.get(edge.source) || [];
    targets.push({ target: edge.target, sourceHandle: edge.sourceHandle });
    adjacency.set(edge.source, targets);
  }

  // Skip cycle detection for workflows with loop nodes
  const hasLoopNode = nodes.some((n) => n.type === "loop");

  // Cycle detection (DFS)
  const visited = new Set<string>();
  const recStack = new Set<string>();
  function hasCycle(nodeId: string): boolean {
    visited.add(nodeId);
    recStack.add(nodeId);
    for (const neighbor of adjacency.get(nodeId) || []) {
      if (!visited.has(neighbor.target)) {
        if (hasCycle(neighbor.target)) return true;
      } else if (recStack.has(neighbor.target)) {
        return true;
      }
    }
    recStack.delete(nodeId);
    return false;
  }
  for (const node of nodes) {
    if (!hasLoopNode && !visited.has(node.id)) {
      if (hasCycle(node.id)) {
        errors.push(issue(node.id, "Cycle detected in workflow graph", "cycle"));
        break;
      }
    }
  }

  // ── Contract-aware checks ──
  for (const node of nodes) {
    if (node.type === "sticky-note") continue;
    const contract = getNodeContract(node.type || "");
    const id = node.id;
    const label = String(node.data?.label || node.id);

    // Check for unknown node types
    if (node.type && !contract && !node.type.includes("trigger") && node.type !== "sticky-note") {
      warnings.push(issue(id, `Node "${label}" has unknown or imported placeholder type "${node.type}"`, "unknown-node-type", "warning"));
    }

    // Check required config fields
    if (contract) {
      for (const field of contract.configFields) {
        if (field.required) {
          const value = node.data?.[field.key] ?? (typeof node.data?.config === "object" && node.data.config ? (node.data.config as Record<string, unknown>)[field.key] : undefined);
          if (value === undefined || value === null || String(value).trim() === "") {
            // For channel output nodes missing "message", downgrade to warning
            // when an upstream text-producing node exists (runtime can infer).
            if (
              field.key === "message" &&
              node.type && CHANNEL_OUTPUT_TYPES.has(node.type) &&
              hasTextProducerUpstream(id, nodes, edges)
            ) {
              warnings.push(issue(
                id,
                `Node "${label}" has no explicit message, but an upstream text-producing node was detected. Runtime will infer message from upstream output.`,
                "missing-config-upstream-ok",
                "warning",
              ));
              continue;
            }
            errors.push(issue(id, `Node "${label}" is missing required field "${field.label}" (${field.key})`, "missing-config"));
          }
        }
      }

      // Check specific field types
      for (const field of contract.configFields) {
        const value = node.data?.[field.key] ?? (typeof node.data?.config === "object" && node.data.config ? (node.data.config as Record<string, unknown>)[field.key] : undefined);

        if (value === undefined || value === null || String(value).trim() === "") continue;

        if (field.type === "json" && typeof value === "string") {
          try { JSON.parse(value as string); } catch {
            errors.push(issue(id, `Node "${label}" has invalid JSON in field "${field.label}"`, "invalid-json"));
          }
        }

        if (field.type === "cron" && typeof value === "string") {
          const parts = (value as string).trim().split(/\s+/);
          if (parts.length < 5) {
            errors.push(issue(id, `Node "${label}" has invalid cron expression "${value}"`, "invalid-cron"));
          }
        }
      }

      // Check credential requirements
      if (contract.credentialHints && contract.credentialHints.length > 0) {
        let hasCred = false;
        for (const hint of contract.credentialHints) {
          if (process.env[hint]) { hasCred = true; break; }
        }
        if (!hasCred) {
          warnings.push(issue(id, `Node "${label}" (${contract.type}) may need credentials: ${contract.credentialHints.join(", ")}`, "missing-credentials", "warning"));
        }
      }
    }

    // ── Check expressions ──
    const conditionField = node.data?.condition as string | undefined
      || (typeof node.data?.config === "object" && node.data.config ? (node.data.config as Record<string, unknown>).condition as string | undefined : undefined);
    if (conditionField && typeof conditionField === "string" && conditionField.trim()) {
      const parseResult = parseExpressionSafe(conditionField);
      if (!parseResult.ok) {
        warnings.push(issue(id, `Node "${label}" has invalid condition expression: "${conditionField.slice(0, 60)}"`, "invalid-expression", "warning"));
      }
    }

    // ── Branch node checks ──
    const outEdges = edges.filter((e) => e.source === id);
    const handles = contract?.sourceHandles ?? [];

    if (node.type === "if-else" || node.type === "switch") {
      for (const handle of handles) {
        if (handle.id === "output" || handle.id === "default") continue;
        const hasConnection = outEdges.some((e) => e.sourceHandle === handle.id);
        if (!hasConnection) {
          // Only warn if both handles are disconnected (single handle disconnection is fine)
        }
      }
    }

    // ── Merge node checks ──
    if (node.type === "merge") {
      const inEdges = edges.filter((e) => e.target === id);
      if (inEdges.length < 2) {
        warnings.push(issue(id, `Merge node "${label}" has fewer than 2 incoming edges (${inEdges.length})`, "merge-underconnected", "warning"));
      }
      const mergeMode = (node.data?.mergeMode as string | undefined)
        ?? (node.data?.mode as string | undefined)
        ?? (typeof node.data?.config === "object" && node.data.config ? (node.data.config as Record<string, unknown>).mergeMode as string | undefined : undefined)
        ?? "wait-all";
      if (mergeMode === "wait-required") {
        const requiredRaw = (node.data?.requiredSources)
          ?? (typeof node.data?.config === "object" && node.data.config ? (node.data.config as Record<string, unknown>).requiredSources : undefined);
        const hasRequired = Array.isArray(requiredRaw)
          ? requiredRaw.length > 0
          : typeof requiredRaw === "string" && requiredRaw.trim().length > 0;
        if (!hasRequired) {
          errors.push(issue(id, `Merge node "${label}" uses "Required branches" mode but no required branches are configured`, "merge-required-unset"));
        }
      }
    }

    // ── Loop node checks ──
    if (node.type === "loop") {
      const bodyEdges = outEdges.filter((e) => e.sourceHandle === "body");
      if (bodyEdges.length === 0) {
        warnings.push(issue(id, `Loop node "${label}" has no body edge connected`, "loop-no-body", "warning"));
      }
      const maxIterRaw = (node.data?.maxIterations)
        ?? (typeof node.data?.config === "object" && node.data.config ? (node.data.config as Record<string, unknown>).maxIterations : undefined);
      if (maxIterRaw !== undefined && maxIterRaw !== null && String(maxIterRaw).trim() !== "") {
        const maxIter = Number(maxIterRaw);
        if (!Number.isFinite(maxIter) || maxIter < 1 || !Number.isInteger(maxIter)) {
          errors.push(issue(id, `Loop node "${label}" has an invalid Max Iterations value "${String(maxIterRaw)}" (must be a positive integer)`, "loop-invalid-max-iterations"));
        }
      }
    }

    // ── Error-handler node checks ──
    if (node.type === "error-handler") {
      const incomingErrorEdge = edges.some((e) => e.target === id && e.sourceHandle === "error");
      const anyIncoming = edges.some((e) => e.target === id);
      if (anyIncoming && !incomingErrorEdge) {
        warnings.push(issue(id, `Error handler "${label}" has no incoming error edge — connect it to a node's "error" output handle`, "error-handler-no-error-edge", "warning"));
      }
    }

    // ── Mutating node safety ──
    if (contract && isMutatingNode(node.type || "")) {
      // Info: note that this node creates side effects
      infos.push(issue(id, `Node "${label}" (${contract.type}) performs a ${contract.sideEffect} side effect`, "mutating-node", "info"));
    }

    // Legacy: claude-agent requires systemPrompt
    if (node.type === "claude-agent") {
      const nodeSystemPrompt = (node.data.systemPrompt as string | undefined)
        || ((node.data.config as Record<string, unknown> | undefined)?.systemPrompt as string | undefined);
      const agentId = (node.data.agentId as string | undefined)
        || ((node.data.config as Record<string, unknown> | undefined)?.agentId as string | undefined);
      const agentHasSystemPrompt = agentId
        ? Boolean((getAgentById(agentId) as Record<string, unknown> | null)?.systemPrompt)
        : false;
      if (!nodeSystemPrompt && !agentHasSystemPrompt) {
        errors.push(issue(id, "Agent node requires a system prompt", "missing-config"));
      }
    }
  }

  // Check for disconnected nodes
  const reachable = new Set<string>();
  function dfs(nodeId: string) {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    for (const neighbor of adjacency.get(nodeId) || []) {
      dfs(neighbor.target);
    }
  }
  for (const trigger of triggerNodes) {
    dfs(trigger.id);
  }
  for (const node of nodes) {
    if (node.type === "sticky-note") continue;
    if (!reachable.has(node.id) && !node.type?.includes("trigger")) {
      warnings.push(issue(node.id, `Node "${node.data.label}" is not reachable from any trigger`, "disconnected", "warning"));
    }
  }

  // Check for dead-end nodes
  const terminalTypes = ["send-webchat", "send-whatsapp", "memory-store", "sticky-note"];
  for (const node of nodes) {
    const outgoing = edges.filter((e) => e.source === node.id);
    if (
      outgoing.length === 0 &&
      !terminalTypes.includes(node.type || "") &&
      !node.type?.includes("trigger")
    ) {
      const hasIncoming = edges.some((e) => e.target === node.id);
      if (hasIncoming) {
        warnings.push(issue(node.id, `Node "${node.data.label}" has no outgoing connections`, "dead-end", "warning"));
      }
    }
  }

  // ── Check for edges from nonexistent handles ──
  const nodeSet = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    if (!nodeSet.has(edge.source)) {
      warnings.push(issue(edge.source, `Edge references nonexistent source node: ${edge.source}`, "invalid-edge-source", "warning"));
    }
    if (!nodeSet.has(edge.target)) {
      warnings.push(issue(edge.target, `Edge references nonexistent target node: ${edge.target}`, "invalid-edge-target", "warning"));
    }
    // Check handle existence
    const sourceNode = nodes.find((n) => n.id === edge.source);
    if (sourceNode && edge.sourceHandle) {
      const sc = getNodeContract(sourceNode.type || "");
      if (sc && sc.sourceHandles && !sc.sourceHandles.some((h) => h.id === edge.sourceHandle) && edge.sourceHandle !== "default") {
        warnings.push(issue(edge.source, `Edge uses handle "${edge.sourceHandle}" which is not in node "${sourceNode.data?.label || edge.source}" contract`, "invalid-handle", "warning"));
      }
    }
  }

  return { errors, warnings, infos };
}
