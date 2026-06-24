import type { WorkflowNode, WorkflowEdge } from "@/types/workflow";
import type { ExecutionRecord, NodeResult, ModelConfig, PartialExecutionInfo, NodeInput, NodeOutput, ExecutionContext } from "@/types/execution";
import { lintWorkflow } from "./linter";
import { getNodeHandler } from "./node-registry";
import { createExecutionContext } from "./context";
import { logger } from "@/lib/utils/logger";
import { nanoid } from "nanoid";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { runHooks } from "@/lib/hooks";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { withExecutionProvenance } from "@/lib/provenance";
import { buildWorkflowGraphPlan } from "@/lib/engine/graph-runtime";
import { recordWorkflowExecutionNodeTraces } from "@/lib/workflows/execution-traces";
import {
  escalateWorkflowPolicy,
  getWorkflowApprovalPolicyOrNull,
  recordWorkflowPolicyCompletion,
  reserveWorkflowPolicyRun,
} from "@/lib/engine/workflow-policy";
import {
  checkNodeEffectPolicy,
  completeGuardedExecution,
  failGuardedExecution,
  NodeEffectBlockedError,
  NodeEffectExecutionIndeterminateError,
  type GuardContext,
} from "@/lib/engine/node-policy-guard";
import { computeWorkflowVersionHash } from "@/lib/engine/workflow-approvals";

type NodeStateValue = "pending" | "running" | "completed" | "failed" | "skipped";

function normalizeNodeLabel(value: string): string {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
}

/**
 * For a `wait-required` merge node, resolve the configured required upstream
 * source node ids. Entries can reference incoming source node ids directly or
 * the labels of incoming source nodes (matched case-insensitively).
 */
function resolveRequiredSources(
  node: WorkflowNode | undefined,
  incoming: string[],
  nodes: WorkflowNode[],
): string[] {
  const data = (node?.data ?? {}) as Record<string, unknown>;
  const config = (data.config && typeof data.config === "object" ? data.config : {}) as Record<string, unknown>;
  const raw = data.requiredSources ?? config.requiredSources;
  let entries: string[] = [];
  if (Array.isArray(raw)) {
    entries = raw.map((v) => String(v || "").trim()).filter(Boolean);
  } else if (typeof raw === "string") {
    entries = raw.split(",").map((v) => v.trim()).filter(Boolean);
  }
  if (entries.length === 0) return [];

  const incomingSet = new Set(incoming);
  const labelToId = new Map<string, string>();
  for (const src of incoming) {
    const srcNode = nodes.find((n) => n.id === src);
    if (srcNode) labelToId.set(normalizeNodeLabel(String(srcNode.data?.label || src)), src);
    labelToId.set(normalizeNodeLabel(src), src);
  }

  const resolved = new Set<string>();
  for (const entry of entries) {
    if (incomingSet.has(entry)) { resolved.add(entry); continue; }
    const byLabel = labelToId.get(normalizeNodeLabel(entry));
    if (byLabel) resolved.add(byLabel);
  }
  return Array.from(resolved);
}

function findReadyNodes(
  pending: Set<string>,
  nodeStates: Map<string, NodeStateValue>,
  incomingByNode: Map<string, string[]>,
  nodeOutputsById: Map<string, Record<string, unknown>>,
  nodes: WorkflowNode[],
): string[] {
  const ready: string[] = [];
  const toRemove: string[] = [];
  for (const nodeId of pending) {
    const state = nodeStates.get(nodeId);
    if (state === "skipped") { toRemove.push(nodeId); continue; }
    const incoming = incomingByNode.get(nodeId) || [];
    if (incoming.length === 0) { ready.push(nodeId); continue; }
    const node = nodes.find((n) => n.id === nodeId);
    const mergeMode = (node?.data as Record<string, unknown>)?.mergeMode as string
      ?? (node?.data as Record<string, unknown>)?.mode as string
      ?? "wait-all";
    const isTerminal = (s: NodeStateValue | undefined) =>
      s === "completed" || s === "skipped" || s === "failed";
    const allDone = incoming.every((src) => isTerminal(nodeStates.get(src)));
    const anyCompleted = incoming.some((src) => nodeStates.get(src) === "completed");
    if (node?.type === "merge") {
      if (mergeMode === "first-complete" && anyCompleted) {
        ready.push(nodeId);
      } else if (mergeMode === "wait-required") {
        const required = resolveRequiredSources(node, incoming, nodes);
        // When required branches are configured, run as soon as those are
        // terminal. Misconfigured (none resolvable) falls back to wait-all.
        const requiredReady =
          required.length > 0
            ? required.every((src) => isTerminal(nodeStates.get(src)))
            : allDone;
        if (requiredReady) ready.push(nodeId);
      } else if (mergeMode === "wait-all" && allDone) {
        ready.push(nodeId);
      } else if (allDone) {
        ready.push(nodeId);
      }
    } else {
      if (allDone) ready.push(nodeId);
    }
  }
  for (const id of toRemove) pending.delete(id);
  return ready;
}
  import {
    finishRunningExecution,
    listRunningExecutions,
    markRunningExecutionNodeComplete,
    markRunningExecutionNodeStart,
    registerRunningExecutionController,
    startRunningExecution,
  } from "@/lib/engine/runtime-tracker";
  import {
    enqueueExecutionInLane,
    resolveExecutionLane,
    type WorkflowExecutionLane,
  } from "@/lib/engine/execution-lanes";
  import { isTurnAborted } from "@/lib/channels/turn-abort-registry";

const log = logger.child("executor");

export class ExecutionAbortedError extends Error {
  constructor(message = "Execution interrupted by user.") {
    super(message);
    this.name = "ExecutionAbortedError";
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new ExecutionAbortedError();
  }
}

export type ExecuteWorkflowOptions = {
  workflowId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  triggerType: "message" | "webhook" | "manual" | "cron";
  triggerData: Record<string, unknown>;
  modelConfig: ModelConfig;
  provenance?: Record<string, unknown> | null;
  lane?: WorkflowExecutionLane;
  parentExecutionId?: string;
  parentNodeId?: string;
  clientTurnId?: string | null;
  /** Pin nodeId → output data; when set, matching nodes skip execution and emit pinned result */
  pinnedData?: Map<string, Record<string, unknown>> | null;
  /** Partial execution: run to this node (inclusive) then stop */
  targetNodeId?: string | null;
  /** Partial execution: start at this node, skipping unrelated upstream nodes */
  startNodeId?: string | null;
  /**
   * Execution mode:
   * - full (default)
   * - partial: run to targetNodeId (inclusive) then stop (run-to-node)
   * - from-node: start at startNodeId, skip unrelated upstream nodes (run-from-node)
   */
  executionMode?: "full" | "partial" | "from-node";
  onNodeStart?: (nodeId: string) => void;
  onNodeComplete?: (nodeId: string, result: NodeResult) => void;
  onEmit?: (event: string, data: unknown) => void;
  onExecutionStart?: (executionId: string) => void;
  /** Allow duplicate active runs for the same workflow. Cron overlap policy and subflows manage this separately. */
  allowConcurrentWorkflowRuns?: boolean;
};

export async function executeWorkflow(options: ExecuteWorkflowOptions): Promise<ExecutionRecord> {
  const lane = options.lane ?? resolveExecutionLane(options.triggerType);
  return enqueueExecutionInLane(
    lane,
    () => executeWorkflowInternal({ ...options, lane }),
    {
      workflowId: options.workflowId,
      triggerType: options.triggerType,
    },
  );
}

async function executeWorkflowInternal(options: ExecuteWorkflowOptions): Promise<ExecutionRecord> {
  const executionId = nanoid(12);
  const startedAt = new Date().toISOString();
  const nodeResults: Record<string, NodeResult> = {};
  const executionProvenance = withExecutionProvenance(
    options.provenance as Record<string, unknown> | null | undefined,
    {
      workflowId: options.workflowId,
      executionId,
      triggerType: options.triggerType,
    },
  );
  const persistResult = (result: ExecutionRecord) => {
    try {
      initializeDatabase();
      const db = getSqlite();
      db.prepare(
        "INSERT OR REPLACE INTO executions (id, workflow_id, status, trigger_type, trigger_data, provenance, node_results, started_at, completed_at, error, parent_execution_id, parent_node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        result.id,
        result.workflowId,
        result.status,
        result.triggerType,
        JSON.stringify(result.triggerData ?? {}),
        JSON.stringify(result.provenance ?? null),
        JSON.stringify(result.nodeResults ?? {}),
        result.startedAt,
        result.completedAt,
        result.error,
        options.parentExecutionId ?? null,
        options.parentNodeId ?? null,
      );
      recordWorkflowExecutionNodeTraces({
        executionId: result.id,
        workflowId: result.workflowId,
        nodes: options.nodes,
        nodeResults: result.nodeResults ?? {},
        startedAt: result.startedAt,
        completedAt: result.completedAt,
      });
    } catch (error) {
      log.warn("Failed to persist execution result", {
        workflowId: result.workflowId,
        executionId: result.id,
        error: String(error),
      });
    }
  };
  const duplicateGuardApplies =
    !options.allowConcurrentWorkflowRuns &&
    options.triggerType !== "cron" &&
    (options.lane ?? resolveExecutionLane(options.triggerType)) !== "subflow";
  if (duplicateGuardApplies) {
    const runningForWorkflow = listRunningExecutions().filter((item) => item.workflowId === options.workflowId);
    const running = runningForWorkflow[0];
    if (running) {
      const { getWorkflowConcurrency, enqueueQueuedExecution } = await import("./execution-queue");
      const concurrency = getWorkflowConcurrency(options.workflowId);
      if (concurrency.mode === "queue") {
        if (runningForWorkflow.length >= concurrency.maxConcurrent) {
          const queued = enqueueQueuedExecution({
            workflowId: options.workflowId,
            triggerType: options.triggerType,
            triggerData: options.triggerData ?? null,
            provenance: executionProvenance,
          });
          recordTelemetryEvent("workflow.queued", {
            workflowId: options.workflowId,
            queueId: queued.id,
            triggerType: options.triggerType,
            runningCount: runningForWorkflow.length,
            maxConcurrent: concurrency.maxConcurrent,
          });
          // Queued starts live only in workflow_execution_queue; a fresh
          // execution record is created when the queue drains.
          return {
            id: queued.id,
            workflowId: options.workflowId,
            status: "queued",
            triggerType: options.triggerType,
            triggerData: options.triggerData,
            provenance: {
              ...executionProvenance,
              concurrencyGuard: "fifo-queue",
              queuedExecutionId: queued.id,
            },
            nodeResults,
            startedAt,
            completedAt: null,
            error: null,
          };
        }
        // Below the limit — run concurrently.
      } else {
      const error = `Workflow already has a running execution (${running.executionId}).`;
      const skippedProvenance = {
        ...executionProvenance,
        concurrencyGuard: "skip-if-running",
        skippedBecauseExecutionId: running.executionId,
      };
      const result: ExecutionRecord = {
        id: executionId,
        workflowId: options.workflowId,
        status: "cancelled",
        triggerType: options.triggerType,
        triggerData: options.triggerData,
        provenance: skippedProvenance,
        nodeResults,
        startedAt,
        completedAt: new Date().toISOString(),
        error,
      };
      persistResult(result);
      recordTelemetryEvent("workflow.cancelled", {
        workflowId: options.workflowId,
        executionId,
        reason: "skip-if-running",
        activeExecutionId: running.executionId,
      });
      await runHooks("workflow.complete", {
        workflowId: options.workflowId,
        executionId,
        status: "cancelled",
        error,
      });
      return result;
      }
    }
  }
  const policyDecision = reserveWorkflowPolicyRun(options.workflowId);
  if (!policyDecision.allowed) {
    const completedAt = new Date().toISOString();
    const policyProvenance = {
      ...executionProvenance,
      policyGuard: policyDecision.reason,
      policyDayKey: policyDecision.dayKey,
    };
    const result: ExecutionRecord = {
      id: executionId,
      workflowId: options.workflowId,
      status: "cancelled",
      triggerType: options.triggerType,
      triggerData: options.triggerData,
      provenance: policyProvenance,
      nodeResults,
      startedAt,
      completedAt,
      error: policyDecision.message,
    };
    persistResult(result);
    const event = {
      workflowId: options.workflowId,
      executionId,
      reason: policyDecision.reason,
      message: policyDecision.message,
      usage: policyDecision.usage,
    };
    options.onEmit?.("policy:blocked", event);
    recordTelemetryEvent("workflow.policy_blocked", event);
    escalateWorkflowPolicy({
      workflowId: options.workflowId,
      executionId,
      policy: policyDecision.policy,
      dayKey: policyDecision.dayKey,
      condition: "budget-blocked",
      message: policyDecision.message,
    });
    await runHooks("workflow.complete", {
      workflowId: options.workflowId,
      executionId,
      status: "cancelled",
      error: policyDecision.message,
    });
    return result;
  }
  options.onExecutionStart?.(executionId);
  // Partial-run metadata (test-node / run-to-node / run-from-node). Populated
  // once the execution order is known; attached to every returned record.
  let partialInfo: PartialExecutionInfo | null = null;
  const finishAndReturn = (result: ExecutionRecord): ExecutionRecord => {
    if (partialInfo) result.partial = partialInfo;
    persistResult(result);
    recordWorkflowPolicyCompletion({
      workflowId: options.workflowId,
      dayKey: policyDecision.dayKey,
      nodeResults: result.nodeResults,
      completedAt: result.completedAt ? new Date(result.completedAt) : undefined,
    });
    if (result.status === "failed") {
      escalateWorkflowPolicy({
        workflowId: options.workflowId,
        executionId,
        policy: policyDecision.policy,
        dayKey: policyDecision.dayKey,
        condition: "failure",
        message: result.error || "Workflow execution failed.",
      });
    }
    finishRunningExecution(executionId);
    // A slot freed up — start the next queued execution, if any. Must also
    // fire for drained runs (which set allowConcurrentWorkflowRuns), so key
    // off the lane rather than the duplicate guard.
    if ((options.lane ?? resolveExecutionLane(options.triggerType)) !== "subflow") {
      import("./execution-queue")
        .then((queue) => queue.drainWorkflowQueue(options.workflowId))
        .catch(() => {});
    }
    return result;
  };
  const maybeFinishPartial = (nodeId: string): ExecutionRecord | null => {
    if (options.executionMode !== "partial" || options.targetNodeId !== nodeId) {
      return null;
    }
    return finishAndReturn({
      id: executionId,
      workflowId: options.workflowId,
      status: "completed",
      triggerType: options.triggerType,
      triggerData: options.triggerData,
      provenance: executionProvenance,
      nodeResults,
      startedAt,
      completedAt: new Date().toISOString(),
      error: null,
    });
  };

  recordTelemetryEvent("workflow.start", {
    workflowId: options.workflowId,
    executionId,
    triggerType: options.triggerType,
  });
  await runHooks("workflow.start", {
    workflowId: options.workflowId,
    executionId,
      triggerType: options.triggerType,
      triggerData: options.triggerData,
      provenance: executionProvenance,
    });

  // 1. Lint
  const lint = lintWorkflow(options.nodes, options.edges);
  if (lint.errors.length > 0) {
    const errorMessage = `Lint errors: ${lint.errors.map((e) => e.message).join(", ")}`;
    recordTelemetryEvent("workflow.failed", {
      workflowId: options.workflowId,
      executionId,
      reason: "lint",
      error: errorMessage,
    });
    await runHooks("workflow.complete", {
      workflowId: options.workflowId,
      executionId,
      status: "failed",
      error: errorMessage,
    });
    return finishAndReturn({
      id: executionId,
      workflowId: options.workflowId,
      status: "failed",
      triggerType: options.triggerType,
      triggerData: options.triggerData,
      provenance: executionProvenance,
      nodeResults,
      startedAt,
      completedAt: new Date().toISOString(),
      error: errorMessage,
    });
  }

  // 2. Build graph plan
  const graphPlan = buildWorkflowGraphPlan({
    nodes: options.nodes,
    edges: options.edges,
    triggerType: options.triggerType,
  });
  const adjacency = graphPlan.adjacency;
  const triggerNode = graphPlan.triggerNode;

  // For run-from-node, the entry point is the selected node (upstream nodes are
  // skipped), so a matching trigger is not required.
  const fromNodeMode = options.executionMode === "from-node" && Boolean(options.startNodeId);
  const fromNodeExists = fromNodeMode && options.nodes.some((n) => n.id === options.startNodeId);

  if (!triggerNode && !fromNodeExists) {
    return finishAndReturn({
      id: executionId,
      workflowId: options.workflowId,
      status: "failed",
      triggerType: options.triggerType,
      triggerData: options.triggerData,
      provenance: executionProvenance,
      nodeResults,
      startedAt,
      completedAt: new Date().toISOString(),
      error: fromNodeMode ? `Run-from-node start node not found: ${options.startNodeId}` : "No matching trigger node found",
    });
  }

  // 4. Create execution context
  const abortController = new AbortController();
  const context = createExecutionContext({
    workflowId: options.workflowId,
    executionId,
    modelConfig: options.modelConfig,
    onEmit: options.onEmit,
    abortSignal: abortController.signal,
  });

  // Set trigger data in context
  context.set("trigger", options.triggerData);
  context.set("provenance", executionProvenance);
  context.set("channel", { clientTurnId: options.clientTurnId ?? null });
  if (options.triggerData.scheduleProfile && typeof options.triggerData.scheduleProfile === "object") {
    context.set("scheduleProfile", options.triggerData.scheduleProfile as Record<string, unknown>);
  }

  // Auto-inject Google OAuth token if available
  try {
    const { getValidAccessToken, getStoredToken } = await import("../google-oauth");
    const accessToken = await getValidAccessToken();
    if (accessToken) {
      const stored = getStoredToken();
      context.set("google", { accessToken, email: stored?.email || "" });
    }
  } catch {
    // google-oauth not configured or unavailable, skip
  }

  // Build the single executor-level effect/approval guard for this run. Manual
  // runs are "attended" (an operator can answer an approval); cron/webhook/
  // message runs are unattended and fail closed for high-risk/irreversible
  // effects unless a bound pre-authorization matches.
  const guardContext: GuardContext = {
    workflowId: options.workflowId,
    workflowVersionHash: computeWorkflowVersionHash(options.nodes, options.edges),
    executionId,
    attended: options.triggerType === "manual",
    approvalPolicy: getWorkflowApprovalPolicyOrNull(options.workflowId),
    approvalWaitMs: Number(process.env.WORKFLOW_APPROVAL_WAIT_MS || 300_000),
    approvalTtlMs: Number(process.env.WORKFLOW_APPROVAL_TTL_MS || 900_000),
    abortSignal: abortController.signal,
    onEmit: options.onEmit,
  };
  context.set("workflowPolicy", {
    approvalPolicy: guardContext.approvalPolicy,
    attended: guardContext.attended,
  });

  // The one guarded handler entry point. Every side-effect-capable node — normal
  // nodes, loop bodies, and retries — runs through here. The handler is only
  // called after an allowed decision; a block throws NodeEffectBlockedError.
  const guardedExecute = async (
    execNode: { id: string; type: string },
    nodeConfig: Record<string, unknown>,
    inputData: Record<string, unknown>,
    attempt: number,
    handler: { execute: (input: NodeInput, ctx: ExecutionContext) => Promise<NodeOutput> },
  ): Promise<NodeOutput> => {
    const outcome = await checkNodeEffectPolicy({
      nodeId: execNode.id,
      nodeType: execNode.type,
      config: nodeConfig || {},
      input: inputData,
      attempt,
      ctx: guardContext,
    });
    if (!outcome.allowed) {
      throw new NodeEffectBlockedError(outcome.reason, outcome.effect, outcome.blockKind ?? "denied");
    }
    try {
      const result = await handler.execute(
        { data: inputData, config: nodeConfig, node: { id: execNode.id, type: execNode.type } },
        context,
      );
      completeGuardedExecution(outcome.approvalId);
      return result;
    } catch (error) {
      const indeterminate = outcome.effect.reversible === false || [
        "external_write", "external_send", "credential_change", "financial", "destructive",
      ].includes(outcome.effect.kind);
      if (indeterminate) {
        failGuardedExecution(outcome.approvalId, `Handler failed after authorization: ${String(error)}`);
        throw new NodeEffectExecutionIndeterminateError(
          `The authorized action returned an error after execution began and will not be retried automatically: ${String(error)}`,
          outcome.effect,
          { cause: error },
        );
      }
      throw error;
    }
  };

  // 5. Build explicit graph metadata for dependency-ready scheduling
  const incomingByNode = new Map<string, string[]>(); // nodeId → [source nodeIds]
  const outgoingByNode = new Map<string, string[]>(); // nodeId → [target nodeIds]
  const branchHandleByEdge = new Map<string, string>(); // `${source}→${target}` → sourceHandle

  for (const edge of options.edges) {
    if (!incomingByNode.has(edge.target)) incomingByNode.set(edge.target, []);
    incomingByNode.get(edge.target)!.push(edge.source);
    if (!outgoingByNode.has(edge.source)) outgoingByNode.set(edge.source, []);
    outgoingByNode.get(edge.source)!.push(edge.target);
    if (edge.sourceHandle) branchHandleByEdge.set(`${edge.source}→${edge.target}`, edge.sourceHandle);
  }

  // Build BFS execution order. Normally this starts from the trigger node; for
  // run-from-node it starts from the selected node so unrelated upstream nodes
  // are skipped.
  const entryNodeId = fromNodeExists ? options.startNodeId! : triggerNode!.id;
  const executionOrder: string[] = [];
  const visited = new Set<string>();
  const bfsQueue: string[] = [entryNodeId];

  while (bfsQueue.length > 0) {
    const nodeId = bfsQueue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    executionOrder.push(nodeId);

    const neighbors = adjacency.get(nodeId) || [];
    for (const { target } of neighbors) {
      if (!visited.has(target)) {
        bfsQueue.push(target);
      }
    }
  }

  // Record partial-run metadata: which nodes were skipped and where the entry
  // node's input came from.
  if (options.executionMode === "from-node" || options.executionMode === "partial") {
    const runSet = new Set(executionOrder);
    const skippedNodes = options.nodes
      .filter((n) => !runSet.has(n.id) && n.type !== "sticky-note")
      .map((n) => ({
        nodeId: n.id,
        label: String(n.data?.label || n.id),
        reason: fromNodeExists ? "upstream/unrelated to run-from-node start" : "not on path to target node",
      }));
    const entryHasPin = Boolean(options.pinnedData?.get(entryNodeId));
    partialInfo = {
      mode: fromNodeExists ? "from-node" : "to-node",
      startNodeId: fromNodeExists ? entryNodeId : null,
      targetNodeId: options.targetNodeId ?? null,
      skippedNodes,
      inputSource: entryHasPin ? "pinned" : fromNodeExists ? "trigger" : "latest",
    };
    if (executionProvenance) {
      (executionProvenance as Record<string, unknown>).partial = partialInfo;
    }
  }

  // Also build legacy reverseAdjacency for backward compat with some paths
  const reverseAdjacency = new Map<string, string[]>();
  for (const edge of options.edges) {
    const sources = reverseAdjacency.get(edge.target) || [];
    sources.push(edge.source);
    reverseAdjacency.set(edge.target, sources);
  }

  // Track node execution states. Nodes outside the execution order (e.g.
  // upstream nodes skipped by run-from-node, or unreachable nodes) are marked
  // "skipped" so they count as terminal when scheduling readiness.
  const nodeStates = new Map<string, NodeStateValue>();
  const runSet = new Set(executionOrder);
  for (const node of options.nodes) {
    nodeStates.set(node.id, runSet.has(node.id) ? "pending" : "skipped");
  }

  // Track per-node outputs for dependency-aware merge/upstream building
  const nodeOutputsById = new Map<string, Record<string, unknown>>();

  startRunningExecution({
    executionId,
    workflowId: options.workflowId,
    triggerType: options.triggerType,
    lane: options.lane ?? resolveExecutionLane(options.triggerType),
    startedAt,
    activeNodeId: null,
    completedNodes: 0,
    totalNodes: executionOrder.length,
  });
  registerRunningExecutionController(executionId, abortController);

  // 6. Execute using readiness-based scheduler
  let lastOutput: Record<string, unknown> = options.triggerData;

  const pending = new Set<string>(executionOrder);

  // Helper to execute a single node with retry, continueOnFail, and full output management
  const executeNode = async (nodeId: string): Promise<ExecutionRecord | null> => {
    throwIfAborted(abortController.signal);
    if (options.clientTurnId && isTurnAborted(options.clientTurnId)) {
      log.warn("Execution aborted by turn-abort registry", { executionId, clientTurnId: options.clientTurnId });
      abortController.abort("Turn cancelled");
      throw new ExecutionAbortedError("Execution aborted by user.");
    }

    if (nodeStates.get(nodeId) === "skipped") return null;

    const node = options.nodes.find((n) => n.id === nodeId);
    if (!node || !node.type) return null;

    const handler = getNodeHandler(node.type);
    if (!handler) {
      log.warn("No handler for node type", { type: node.type });
      nodeStates.set(nodeId, "skipped");
      return null;
    }

    // Honor the per-node `disabled` flag
    if (node.data?.disabled) {
      nodeStates.set(nodeId, "skipped");
      context.setNodeState(nodeId, { status: "skipped" });
      options.onEmit?.("workflow:node:complete", {
        workflowId: options.workflowId, executionId, nodeId, nodeType: node.type,
        label: String(node.data?.label || nodeId), status: "skipped", durationMs: 0,
      });
      return maybeFinishPartial(nodeId);
    }

    // ── Build upstream input from nodeOutputsById ──
    const upstreamSources = incomingByNode.get(nodeId) || [];
    const upstreamOutputs: Record<string, Record<string, unknown>> = {};
    let mergedUpstream: Record<string, unknown> = { ...options.triggerData };
    for (const srcId of upstreamSources) {
      const srcOutput = nodeOutputsById.get(srcId);
      if (srcOutput) {
        const srcNode = options.nodes.find((n) => n.id === srcId);
        const safeLabel = String(srcNode?.data?.label || srcId)
          .replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase().replace(/^_+|_+$/g, "") || srcId;
        upstreamOutputs[safeLabel] = srcOutput;
        mergedUpstream = { ...mergedUpstream, ...srcOutput };
      }
    }
    // Overlay lastOutput for backward compatibility
    mergedUpstream = { ...mergedUpstream, ...lastOutput };

    // Inject __upstreamByNodeId for merge node real semantics
    if (node.type === "merge") {
      const upstreamById: Record<string, unknown> = {};
      const upstreamByLabel: Record<string, unknown> = {};
      const ordered: Array<{ nodeId: string; label: string; output: unknown }> = [];
      for (const srcId of upstreamSources) {
        const output = nodeOutputsById.get(srcId);
        if (output) {
          const srcNode = options.nodes.find((n) => n.id === srcId);
          const label = String(srcNode?.data?.label || srcId)
            .replace(/[^a-zA-Z0-9_]/g, "_")
            .toLowerCase()
            .replace(/^_+|_+$/g, "") || srcId;
          upstreamById[srcId] = output;
          upstreamByLabel[label] = output;
          ordered.push({ nodeId: srcId, label, output });
        }
      }
      // Record upstream branches that did not produce output (failed/skipped)
      // so merge logic and downstream nodes can see them instead of silently
      // dropping failed branches.
      const failedBranches: Array<{ nodeId: string; label: string; state: string }> = [];
      for (const srcId of upstreamSources) {
        if (nodeOutputsById.get(srcId)) continue;
        const srcState = nodeStates.get(srcId);
        if (srcState === "failed" || srcState === "skipped") {
          const srcNode = options.nodes.find((n) => n.id === srcId);
          failedBranches.push({
            nodeId: srcId,
            label: String(srcNode?.data?.label || srcId),
            state: srcState,
          });
        }
      }
      mergedUpstream.__upstreamByNodeId = upstreamById;
      mergedUpstream.__upstream = {
        byNodeId: upstreamById,
        byLabel: upstreamByLabel,
        ordered,
        failed: failedBranches,
      };
    }

    // ── Pinned data check ──
    const pinData = options.pinnedData?.get(nodeId);
    if (pinData) {
      const pinnedResult: NodeResult = { nodeId, output: pinData, duration: 0, pinned: true };
      nodeResults[nodeId] = pinnedResult;
      nodeStates.set(nodeId, "completed");
      nodeOutputsById.set(nodeId, pinData);
      context.setNodeState(nodeId, { status: "completed", output: pinData });
      lastOutput = { ...lastOutput, ...pinData };
      context.set(nodeId, pinData);
      options.onNodeComplete?.(nodeId, pinnedResult);
      options.onEmit?.("workflow:node:complete", {
        workflowId: options.workflowId, executionId, nodeId, nodeType: node.type,
        label: String(node.data?.label || nodeId), status: "pinned", durationMs: 0, pinned: true,
      });
      return maybeFinishPartial(nodeId);
    }

    nodeStates.set(nodeId, "running");
    context.setNodeState(nodeId, { status: "running" });
    markRunningExecutionNodeStart(executionId, nodeId);
    options.onNodeStart?.(nodeId);
    options.onEmit?.("workflow:node:start", {
      workflowId: options.workflowId, executionId, nodeId, nodeType: node.type,
      label: String(node.data?.label || nodeId), startedAt: new Date().toISOString(),
    });
    const nodeStart = Date.now();

    try {
      throwIfAborted(abortController.signal);

      // ── Loop subgraph execution ──
      if (node.type === "loop") {
        const rawData = (node.data || {}) as Record<string, unknown>;
        const rawConfig = (rawData.config && typeof rawData.config === "object" ? rawData.config : {}) as Record<string, unknown>;
        const sourcePath = String(rawData.sourcePath || rawConfig.sourcePath || "").trim();
        const maxIterations = Number(rawData.maxIterations ?? rawConfig.maxIterations ?? 100);
        const onItemError = String(rawData.onItemError ?? rawConfig.onItemError ?? "stop");
        const concurrency = Math.max(1, Number(rawData.concurrency ?? rawConfig.concurrency ?? 1));

        // Resolve the array from the source path using context
        let arrayData: unknown[] = [];
        if (sourcePath) {
          const resolved = context.get(sourcePath);
          if (Array.isArray(resolved)) {
            arrayData = resolved;
          }
        }

        // If no explicit sourcePath, try to find an array in the input
        if (arrayData.length === 0) {
          for (const value of Object.values(mergedUpstream)) {
            if (Array.isArray(value)) { arrayData = value; break; }
          }
        }

        const items = arrayData.slice(0, maxIterations);
        const bodyEdge = (adjacency.get(nodeId) || []).find((e) => e.sourceHandle === "body");
        const bodySubgraphNodes: string[] = [];
        const bodyVisited = new Set<string>();
        if (bodyEdge) {
          const bodyQueue = [bodyEdge.target];
          while (bodyQueue.length > 0) {
            const bid = bodyQueue.shift()!;
            if (bodyVisited.has(bid)) continue;
            bodyVisited.add(bid);
            bodySubgraphNodes.push(bid);
            for (const n of adjacency.get(bid) || []) {
              if (!bodyVisited.has(n.target)) bodyQueue.push(n.target);
            }
          }
        }

        // Execute a single loop item body subgraph
        const executeLoopItem = async (item: unknown, idx: number): Promise<{ output: Record<string, unknown>; failed: boolean; error?: string }> => {
          context.set("loop", { item, index: idx, total: items.length });
          let itemLastOutput: Record<string, unknown> = {
            ...mergedUpstream,
            "loop.item": item,
            "loop.index": idx,
            "loop.total": items.length,
          };
          let itemFailed = false;
          let itemError: string | undefined;

          for (const bodyNodeId of bodySubgraphNodes) {
            const bodyNode = options.nodes.find((n) => n.id === bodyNodeId);
            if (!bodyNode || !bodyNode.type) continue;
            const bodyHandler = getNodeHandler(bodyNode.type);
            if (!bodyHandler) continue;

            try {
              const itemOutput = await guardedExecute(
                { id: bodyNodeId, type: bodyNode.type },
                (bodyNode.data ?? {}) as Record<string, unknown>,
                itemLastOutput,
                1,
                bodyHandler,
              );
              const itemResult: NodeResult = { nodeId: bodyNodeId, output: itemOutput.data, duration: 0 };
              nodeResults[`${nodeId}.loop.${idx}.${bodyNodeId}`] = itemResult;
              itemLastOutput = itemOutput.data;
            } catch (err) {
              itemFailed = true;
              itemError = String(err);
              if (onItemError === "stop") throw err;
              break;
            }
          }

          return { output: itemLastOutput, failed: itemFailed, error: itemError };
        };

        const collected: Record<string, unknown>[] = [];
        const errors: Record<string, unknown>[] = [];
        let successCount = 0;
        let failureCount = 0;

        if (concurrency <= 1) {
          // Serial execution
          for (let idx = 0; idx < items.length; idx++) {
            throwIfAborted(abortController.signal);
            const item = items[idx];
            try {
              const res = await executeLoopItem(item, idx);
              if (res.failed) {
                failureCount++;
                if (onItemError === "collect") errors.push({ error: res.error, item, index: idx });
                if (onItemError === "stop") break;
              } else {
                successCount++;
                collected.push(res.output);
              }
            } catch (err) {
              failureCount++;
              if (onItemError === "stop") throw err;
              if (onItemError === "collect") errors.push({ error: String(err), item, index: idx });
            }
          }
        } else {
          // Concurrent batch execution
          for (let batchStart = 0; batchStart < items.length; batchStart += concurrency) {
            throwIfAborted(abortController.signal);
            const batch = items.slice(batchStart, batchStart + concurrency);
            const batchResults = await Promise.all(
              batch.map(async (item, batchIdx) => {
                const idx = batchStart + batchIdx;
                try {
                  const res = await executeLoopItem(item, idx);
                  return res;
                } catch (err) {
                  return { output: {}, failed: true, error: String(err) };
                }
              }),
            );
            for (let i = 0; i < batchResults.length; i++) {
              const res = batchResults[i];
              if (res.failed) {
                failureCount++;
                if (onItemError === "collect") errors.push({ error: res.error, item: batch[i], index: batchStart + i });
              } else {
                successCount++;
                collected.push(res.output);
              }
            }
            if (onItemError === "stop" && batchResults.some((r) => r.failed)) break;
          }
        }

        const loopOutput: Record<string, unknown> = {
          itemCount: items.length,
          successCount,
          failureCount,
          collected,
          errors: errors.length > 0 ? errors : undefined,
        };
        lastOutput = loopOutput;
        nodeOutputsById.set(nodeId, loopOutput);

        // Loop body nodes are executed inside the loop above. Mark them skipped
        // in the main scheduler so they are not re-executed once (without loop
        // context) when the loop node completes.
        for (const bid of bodySubgraphNodes) {
          if (nodeStates.get(bid) === "pending") {
            nodeStates.set(bid, "skipped");
            context.setNodeState(bid, { status: "skipped" });
          }
        }

        const duration = Date.now() - nodeStart;
        const result: NodeResult = { nodeId, output: loopOutput, duration };
        nodeResults[nodeId] = result;
        nodeStates.set(nodeId, "completed");
        context.setNodeOutput(nodeId, String(node.data?.label || nodeId), loopOutput);
        context.setNodeState(nodeId, { status: "completed", output: loopOutput });
        markRunningExecutionNodeComplete(executionId);
        options.onNodeComplete?.(nodeId, result);
        options.onEmit?.("workflow:node:complete", {
          workflowId: options.workflowId, executionId, nodeId, nodeType: node.type,
          label: String(node.data?.label || nodeId), status: "completed", durationMs: duration,
        });
        recordTelemetryEvent("workflow.node_complete", {
          workflowId: options.workflowId, executionId, nodeId, nodeType: node.type, durationMs: duration,
        });
        return maybeFinishPartial(nodeId);
      }

      // ── Normal node execution (guarded) ──
      const output = await guardedExecute(
        { id: nodeId, type: node.type },
        (node.data ?? {}) as Record<string, unknown>,
        mergedUpstream,
        1,
        handler,
      );
      throwIfAborted(abortController.signal);

      const duration = Date.now() - nodeStart;
      const result: NodeResult = { nodeId, output: output.data, duration };

      nodeResults[nodeId] = result;
      nodeStates.set(nodeId, "completed");
      nodeOutputsById.set(nodeId, output.data);
      context.setNodeOutput(nodeId, String(node.data?.label || nodeId), output.data);
      context.setNodeState(nodeId, { status: "completed", output: output.data });
      lastOutput = output.data;

      markRunningExecutionNodeComplete(executionId);
      options.onNodeComplete?.(nodeId, result);
      options.onEmit?.("workflow:node:complete", {
        workflowId: options.workflowId, executionId, nodeId, nodeType: node.type,
        label: String(node.data?.label || nodeId), status: "completed", durationMs: duration,
      });
      recordTelemetryEvent("workflow.node_complete", {
        workflowId: options.workflowId, executionId, nodeId, nodeType: node.type, durationMs: duration,
      });

      const partialResult = maybeFinishPartial(nodeId);
      if (partialResult) return partialResult;

      // Store output in legacy context namespace
      const namespace = node.type.replace(/-/g, "_").split("_")[0];
      context.set(namespace, output.data);

      // Handle branch-aware nodes
      const branch = typeof output.data.branch === "string" ? output.data.branch : null;

      if (branch) {
        const neighbors = adjacency.get(nodeId) || [];
        const branchEdge = neighbors.find((n) => n.sourceHandle === branch);

        if (branchEdge) {
          // Mark non-selected branch targets as skipped (and their descendants)
          for (const n of neighbors) {
            if (n.sourceHandle && n.sourceHandle !== branch) {
              const skipQueue = [n.target];
              const branchVisited = new Set<string>();
              while (skipQueue.length > 0) {
                const sid = skipQueue.shift()!;
                if (branchVisited.has(sid)) continue;
                branchVisited.add(sid);
                nodeStates.set(sid, "skipped");
                context.setNodeState(sid, { status: "skipped" });
                const sNeighbors = adjacency.get(sid) || [];
                for (const sn of sNeighbors) {
                  if (!branchVisited.has(sn.target)) skipQueue.push(sn.target);
                }
              }
            }
          }
        }
      } else if (node.type === "filter" && output.data.stopped) {
        // Filter halted execution — mark all pending downstream nodes as skipped
        for (const sid of pending) {
          if (nodeStates.get(sid) === "pending") {
            nodeStates.set(sid, "skipped");
            context.setNodeState(sid, { status: "skipped" });
          }
        }
      }

      return null;

    } catch (error) {
      const duration = Date.now() - nodeStart;
      const errorMessage = `Node ${node.data?.label || nodeId} failed: ${String(error)}`;
      const cancelled =
        abortController.signal.aborted ||
        error instanceof ExecutionAbortedError ||
        String(error).includes("Execution interrupted by user.");
      // A node blocked by the effect/approval guard (denied, hardline, expired)
      // is a policy decision, not a transient failure — never retry it.
      const blockedByGuard = error instanceof NodeEffectBlockedError || error instanceof NodeEffectExecutionIndeterminateError;

      // ── Per-node retry logic ──
      const nodeData = node.data as Record<string, unknown>;
      const nodeConfig = nodeData.config && typeof nodeData.config === "object" && !Array.isArray(nodeData.config)
        ? nodeData.config as Record<string, unknown>
        : {};
      const retryCount = Number(nodeData.retryCount ?? nodeConfig.retryCount ?? 0);
      const retryDelayMs = Number(nodeData.retryDelayMs ?? nodeConfig.retryDelayMs ?? 250);
      const continueOnFail = Boolean(nodeData.continueOnFail ?? nodeConfig.continueOnFail ?? false);

      let lastError: unknown = error;
      let attempts = 1;

      if (retryCount > 0 && !cancelled && !blockedByGuard) {
        while (attempts <= retryCount) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          try {
            const retryOutput = await guardedExecute(
              { id: nodeId, type: node.type },
              (node.data ?? {}) as Record<string, unknown>,
              mergedUpstream,
              attempts + 1,
              handler,
            );
            // Retry succeeded — treat as normal completion
            const retriedDuration = Date.now() - nodeStart;
            const retriedResult: NodeResult = {
              nodeId,
              output: retryOutput.data,
              duration: retriedDuration,
              attempts: attempts + 1,
            };
            nodeResults[nodeId] = retriedResult;
            nodeStates.set(nodeId, "completed");
            nodeOutputsById.set(nodeId, retryOutput.data);
            context.setNodeOutput(nodeId, String(node.data?.label || nodeId), retryOutput.data);
            context.setNodeState(nodeId, { status: "completed", output: retryOutput.data });
            lastOutput = retryOutput.data;
            markRunningExecutionNodeComplete(executionId);
            options.onNodeComplete?.(nodeId, retriedResult);
            options.onEmit?.("workflow:node:complete", {
              workflowId: options.workflowId, executionId, nodeId, nodeType: node.type,
              label: String(node.data?.label || nodeId), status: "completed", durationMs: retriedDuration,
              retried: true, attempts: attempts + 1,
            });
            recordTelemetryEvent("workflow.node_complete", {
              workflowId: options.workflowId, executionId, nodeId, nodeType: node.type, durationMs: retriedDuration,
            });
            const ns = node.type.replace(/-/g, "_").split("_")[0];
            context.set(ns, retryOutput.data);
            return maybeFinishPartial(nodeId);
          } catch (retryError) {
            lastError = retryError;
            attempts++;
          }
        }
      }

      // All retries exhausted (or no retries configured)
      const finalCancelled =
        abortController.signal.aborted ||
        lastError instanceof ExecutionAbortedError ||
        String(lastError).includes("Execution interrupted by user.");

      nodeResults[nodeId] = {
        nodeId,
        output: {},
        duration,
        error: finalCancelled ? "Execution interrupted by user." : String(lastError),
        attempts: attempts > 1 ? attempts : undefined,
      };
      nodeStates.set(nodeId, "failed");
      context.setNodeState(nodeId, { status: "failed", error: String(lastError) });

      // ── Error edge routing: if there's an error output handle connected, route there ──
      const errorNeighbors = adjacency.get(nodeId) || [];
      const errorEdge = errorNeighbors.find((n) => n.sourceHandle === "error");
      if (errorEdge && !finalCancelled) {
        const errorPayload: Record<string, unknown> = {
          error: true,
          failedNodeId: nodeId,
          failedNodeLabel: String(node.data?.label || nodeId),
          failedNodeType: node.type,
          message: String(lastError),
          stackPreview: lastError instanceof Error ? lastError.stack?.slice(0, 500) ?? String(lastError) : String(lastError),
          inputPreview: JSON.stringify(mergedUpstream).slice(0, 800),
          attempts: attempts > 1 ? attempts : undefined,
        };
        nodeResults[nodeId] = { nodeId, output: errorPayload, duration, error: String(lastError) };
        nodeOutputsById.set(nodeId, errorPayload);
        lastOutput = errorPayload;
        // Continue — error handler downstream will process this
        return null;
      }

      // ── continueOnFail: emit error output and continue instead of stopping ──
      if (continueOnFail && !finalCancelled) {
        const errorPayload: Record<string, unknown> = {
          error: true,
          failedNodeId: nodeId,
          failedNodeLabel: String(node.data?.label || nodeId),
          failedNodeType: node.type,
          message: String(lastError),
          continueOnFail: true,
          attempts: attempts > 1 ? attempts : undefined,
        };
        nodeResults[nodeId] = { nodeId, output: errorPayload, duration, error: String(lastError) };
        nodeOutputsById.set(nodeId, errorPayload);
        nodeStates.set(nodeId, "completed"); // Mark as completed so downstream nodes can still run
        lastOutput = errorPayload;
        context.setNodeState(nodeId, { status: "completed", output: errorPayload });
        markRunningExecutionNodeComplete(executionId);
        options.onEmit?.("workflow:node:complete", {
          workflowId: options.workflowId, executionId, nodeId, nodeType: node.type,
          label: String(node.data?.label || nodeId), status: "failed_continued", durationMs: duration,
          error: String(lastError),
        });
        return null;
      }

      options.onEmit?.("workflow:node:complete", {
        workflowId: options.workflowId, executionId, nodeId, nodeType: node.type,
        label: String(node.data?.label || nodeId),
        status: finalCancelled ? "cancelled" : "failed",
        durationMs: duration,
        error: finalCancelled ? "Execution interrupted by user." : String(lastError),
      });
      recordTelemetryEvent(finalCancelled ? "workflow.cancelled" : "workflow.failed", {
        workflowId: options.workflowId, executionId, nodeId, nodeType: node.type,
        error: finalCancelled ? "Execution interrupted by user." : String(lastError),
      });
      await runHooks("workflow.complete", {
        workflowId: options.workflowId, executionId,
        status: finalCancelled ? "cancelled" : "failed",
        nodeId, nodeType: node.type,
        error: finalCancelled ? "Execution interrupted by user." : String(lastError),
      });

      markRunningExecutionNodeComplete(executionId);
      return finishAndReturn({
        id: executionId,
        workflowId: options.workflowId,
        status: finalCancelled ? "cancelled" : "failed",
        triggerType: options.triggerType,
        triggerData: options.triggerData,
        provenance: executionProvenance,
        nodeResults,
        startedAt,
        completedAt: new Date().toISOString(),
        error: finalCancelled ? "Execution interrupted by user." : errorMessage,
      });
    }
  };

  // Readiness-based scheduling loop
  while (pending.size > 0) {
    const readyNodes = findReadyNodes(pending, nodeStates, incomingByNode, nodeOutputsById, options.nodes);
    if (readyNodes.length === 0) {
      // Deadlock or all remaining are effectively done/skipped
      break;
    }
    // Execute ready nodes serially (correct for all graph shapes; batching is possible but serial is always correct)
    for (const nodeId of readyNodes) {
      pending.delete(nodeId);
      const earlyReturn = await executeNode(nodeId);
      if (earlyReturn) return earlyReturn;
    }
  }

  throwIfAborted(abortController.signal);
  recordTelemetryEvent("workflow.complete", {
    workflowId: options.workflowId,
    executionId,
    status: "completed",
    nodeCount: Object.keys(nodeResults).length,
  });
  await runHooks("workflow.complete", {
    workflowId: options.workflowId,
    executionId,
    status: "completed",
    triggerType: options.triggerType,
    nodeResults,
  });

  return finishAndReturn({
    id: executionId,
    workflowId: options.workflowId,
    status: "completed",
    triggerType: options.triggerType,
    triggerData: options.triggerData,
    provenance: executionProvenance,
    nodeResults,
    startedAt,
    completedAt: new Date().toISOString(),
    error: null,
  });
}
