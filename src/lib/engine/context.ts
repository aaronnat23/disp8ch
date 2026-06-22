import type { ExecutionContext, ModelConfig } from "@/types/execution";

export type RuntimeNodeState = {
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  output?: Record<string, unknown>;
  error?: string;
};

export function createExecutionContext(options: {
  workflowId: string;
  executionId: string;
  modelConfig: ModelConfig;
  onEmit?: (event: string, data: unknown) => void;
  abortSignal?: AbortSignal;
}): ExecutionContext & { setNodeOutput: (nodeId: string, label: string, data: Record<string, unknown>) => void; getNodeState: (nodeId: string) => RuntimeNodeState | undefined; setNodeState: (nodeId: string, state: RuntimeNodeState) => void; getAllNodeStates: () => Map<string, RuntimeNodeState> } {
  const store = new Map<string, Record<string, unknown>>();
  const nodeStates = new Map<string, RuntimeNodeState>();
  const nodeOutputs = new Map<string, Record<string, unknown>>();

  function getNodeStateFn(nodeId: string): RuntimeNodeState | undefined {
    return nodeStates.get(nodeId);
  }

  function setNodeStateFn(nodeId: string, state: RuntimeNodeState) {
    nodeStates.set(nodeId, state);
  }

  function getAllNodeStatesFn(): Map<string, RuntimeNodeState> {
    return new Map(nodeStates);
  }

  return {
    workflowId: options.workflowId,
    executionId: options.executionId,
    abortSignal: options.abortSignal || new AbortController().signal,

    get(path: string): unknown {
      const parts = path.split(".");
      if (parts.length < 2) return undefined;

      const first = parts[0];

      // ── New node-id based namespace: nodes.<labelOrId>.<field> ──
      if (first === "nodes" && parts.length >= 3) {
        const labelOrId = parts[1];
        const fieldParts = parts.slice(2);
        let foundData: unknown;
        for (const [nid, output] of nodeOutputs) {
          const storedLabel = String(output._label ?? "");
          const safeLabel = storedLabel.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase().replace(/^_+|_+$/g, "");
          if (safeLabel === labelOrId || nid === labelOrId) {
            foundData = output;
            break;
          }
        }
        if (foundData) {
          let current: unknown = foundData;
          for (let i = 0; i < fieldParts.length; i++) {
            if (current === null || current === undefined) return undefined;
            if (typeof current === "object") {
              current = (current as Record<string, unknown>)[fieldParts[i]];
            } else {
              return undefined;
            }
          }
          return current;
        }
        // Fall through to legacy namespace lookup if not found in nodeOutputs
      }

      // ── Legacy namespace fallback ──
      const namespace = first;
      const data = store.get(namespace);
      if (!data) return undefined;

      let current: unknown = data;
      for (let i = 1; i < parts.length; i++) {
        if (current === null || current === undefined) return undefined;
        if (typeof current === "object") {
          current = (current as Record<string, unknown>)[parts[i]];
        } else {
          return undefined;
        }
      }
      return current;
    },

    set(namespace: string, data: Record<string, unknown>): void {
      const existing = store.get(namespace) || {};
      store.set(namespace, { ...existing, ...data });
    },

    setNodeOutput(nodeId: string, label: string, data: Record<string, unknown>): void {
      nodeOutputs.set(nodeId, { _label: label, _nodeId: nodeId, ...data });
      // Also expose by legacy type-derived namespace
      const nsParts = label.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase().split("_");
      if (nsParts.length > 0) {
        const ns = nsParts[0];
        this.set(ns, data);
      }
    },

    getNodeState: getNodeStateFn,
    setNodeState: setNodeStateFn,
    getAllNodeStates: getAllNodeStatesFn,

    emit(event: string, data: unknown): void {
      if (options.onEmit) {
        options.onEmit(event, data);
      }
    },

    getModel(): ModelConfig {
      return options.modelConfig;
    },
  };
}

export type ExtendedExecutionContext = ReturnType<typeof createExecutionContext>;
