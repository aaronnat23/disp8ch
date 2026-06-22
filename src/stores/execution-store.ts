import { create } from "zustand";
import type { ExecutionRecord, ExecutionLogEntry } from "@/types/execution";

export type NodeRunOverlay = {
  status: "running" | "completed" | "failed" | "skipped" | "cancelled";
  durationMs?: number;
  error?: string;
  outputPreview?: string;
};

interface ExecutionState {
  executions: ExecutionRecord[];
  currentExecution: ExecutionRecord | null;
  logEntries: ExecutionLogEntry[];
  activeNodeId: string | null;
  isRunning: boolean;
  wsConnected: boolean;
  streamingTokens: Record<string, string>;
  // Per-node overlay map from the latest run, keyed by node id.
  nodeOverlays: Record<string, NodeRunOverlay>;

  setExecutions: (executions: ExecutionRecord[]) => void;
  setCurrentExecution: (execution: ExecutionRecord | null) => void;
  addLogEntry: (entry: ExecutionLogEntry) => void;
  clearLog: () => void;
  setActiveNodeId: (id: string | null) => void;
  setIsRunning: (running: boolean) => void;
  setWsConnected: (connected: boolean) => void;
  appendStreamToken: (nodeId: string, token: string) => void;
  finalizeStream: (nodeId: string) => void;

  // Per-node overlays for the canvas
  resetNodeOverlays: () => void;
  setNodeOverlay: (nodeId: string, overlay: NodeRunOverlay) => void;
}

export const useExecutionStore = create<ExecutionState>((set) => ({
  executions: [],
  currentExecution: null,
  logEntries: [],
  activeNodeId: null,
  isRunning: false,
  wsConnected: false,
  streamingTokens: {},
  nodeOverlays: {},

  setExecutions: (executions) => set({ executions }),
  setCurrentExecution: (execution) => set({ currentExecution: execution }),
  addLogEntry: (entry) =>
    set((state) => ({ logEntries: [...state.logEntries, entry] })),
  clearLog: () => set({ logEntries: [], streamingTokens: {}, nodeOverlays: {} }),
  setActiveNodeId: (id) => set({ activeNodeId: id }),
  setIsRunning: (running) => set({ isRunning: running }),
  setWsConnected: (connected) => set({ wsConnected: connected }),
  appendStreamToken: (nodeId, token) =>
    set((state) => ({
      streamingTokens: {
        ...state.streamingTokens,
        [nodeId]: (state.streamingTokens[nodeId] || "") + token,
      },
    })),
  finalizeStream: (nodeId) =>
    set((state) => {
      const tokens = state.streamingTokens[nodeId];
      if (!tokens) return state;
      const updated = { ...state.streamingTokens };
      delete updated[nodeId];
      return { streamingTokens: updated };
    }),

  resetNodeOverlays: () => set({ nodeOverlays: {} }),
  setNodeOverlay: (nodeId, overlay) =>
    set((state) => ({
      nodeOverlays: { ...state.nodeOverlays, [nodeId]: overlay },
    })),
}));
