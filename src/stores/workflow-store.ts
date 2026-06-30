import { create } from "zustand";
import type { WorkflowNode, WorkflowEdge, Workflow } from "@/types/workflow";
import type { OnNodesChange, OnEdgesChange, OnConnect } from "@xyflow/react";
import { applyNodeChanges, applyEdgeChanges, addEdge } from "@xyflow/react";
import { nanoid } from "nanoid";

type Snapshot = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

const HISTORY_LIMIT = 50;
// In-memory clipboard — shared across editor mounts. Survives navigation
// but resets on full page refresh, which matches user expectation for the
// "Ctrl+C / Ctrl+V" pattern.
let clipboard: Snapshot = { nodes: [], edges: [] };

interface WorkflowState {
  workflows: Workflow[];
  currentWorkflow: Workflow | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedNodeId: string | null;
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  isDirty: boolean;
  past: Snapshot[];
  future: Snapshot[];

  setWorkflows: (workflows: Workflow[]) => void;
  setCurrentWorkflow: (workflow: Workflow | null) => void;
  setNodes: (nodes: WorkflowNode[]) => void;
  setEdges: (edges: WorkflowEdge[]) => void;
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setSelectedNodeId: (id: string | null) => void;
  setSelection: (params: { nodeIds: string[]; edgeIds: string[] }) => void;
  addNode: (node: WorkflowNode) => void;
  updateNodeConfig: (nodeId: string, config: Record<string, unknown>) => void;
  toggleNodeDisabled: (nodeId: string) => void;
  setDirty: (dirty: boolean) => void;

  // History
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // Clipboard
  copySelection: () => { nodeCount: number; edgeCount: number };
  pasteClipboard: (offset?: { x: number; y: number }) => { nodeCount: number; edgeCount: number };
  duplicateSelection: () => { nodeCount: number; edgeCount: number };
  deleteSelection: () => { nodeCount: number; edgeCount: number };
}

function snapshot(state: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }): Snapshot {
  return {
    nodes: JSON.parse(JSON.stringify(state.nodes)) as WorkflowNode[],
    edges: JSON.parse(JSON.stringify(state.edges)) as WorkflowEdge[],
  };
}

function nodesDifferTopologically(a: WorkflowNode[], b: WorkflowNode[]): boolean {
  if (a.length !== b.length) return true;
  const aIds = new Set(a.map((n) => n.id));
  for (const n of b) if (!aIds.has(n.id)) return true;
  return false;
}

function edgesDiffer(a: WorkflowEdge[], b: WorkflowEdge[]): boolean {
  if (a.length !== b.length) return true;
  const aKeys = new Set(a.map((e) => `${e.id}:${e.source}->${e.target}`));
  for (const e of b) if (!aKeys.has(`${e.id}:${e.source}->${e.target}`)) return true;
  return false;
}

function nodeChangesAffectWorkflow(changes: Parameters<OnNodesChange>[0]): boolean {
  return changes.some((change) => {
    const c = change as { type?: string; position?: unknown };
    return c.type === "remove" || c.type === "add" || c.type === "position";
  });
}

function edgeChangesAffectWorkflow(changes: Parameters<OnEdgesChange>[0]): boolean {
  return changes.some((change) => {
    const c = change as { type?: string };
    return c.type === "remove" || c.type === "add";
  });
}

export const useWorkflowStore = create<WorkflowState>((set, get) => {
  /** Push the current state onto `past` and clear `future`. Call this BEFORE a mutation. */
  function pushHistory() {
    const state = get();
    const past = [...state.past, snapshot({ nodes: state.nodes, edges: state.edges })];
    while (past.length > HISTORY_LIMIT) past.shift();
    return { past, future: [] as Snapshot[] };
  }

  /** Decide whether a batch of ReactFlow changes should produce a history entry. */
  function shouldRecordNodeChanges(
    changes: Parameters<OnNodesChange>[0],
  ): boolean {
    for (const change of changes) {
      const c = change as { type?: string; dragging?: boolean };
      if (c.type === "remove" || c.type === "add") return true;
      // Capture drag completion (final position change of a drag gesture)
      if (c.type === "position" && c.dragging === false) return true;
    }
    return false;
  }

  function shouldRecordEdgeChanges(changes: Parameters<OnEdgesChange>[0]): boolean {
    for (const change of changes) {
      const c = change as { type?: string };
      if (c.type === "remove" || c.type === "add") return true;
    }
    return false;
  }

  return {
    workflows: [],
    currentWorkflow: null,
    nodes: [],
    edges: [],
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedEdgeIds: [],
    isDirty: false,
    past: [],
    future: [],

    setWorkflows: (workflows) => set({ workflows }),
    setCurrentWorkflow: (workflow) =>
      set({
        currentWorkflow: workflow,
        nodes: workflow?.nodes || [],
        edges: workflow?.edges || [],
        isDirty: false,
        past: [],
        future: [],
        selectedNodeId: null,
        selectedNodeIds: [],
        selectedEdgeIds: [],
      }),
    setNodes: (nodes) => {
      const history = pushHistory();
      set({ nodes, isDirty: true, ...history });
    },
    setEdges: (edges) => {
      const history = pushHistory();
      set({ edges, isDirty: true, ...history });
    },

    onNodesChange: (changes) => {
      const state = get();
      const nextNodes = applyNodeChanges(changes, state.nodes) as WorkflowNode[];
      const shouldRecord = shouldRecordNodeChanges(changes);
      const dirty = nodeChangesAffectWorkflow(changes);
      if (shouldRecord) {
        const past = [...state.past, snapshot({ nodes: state.nodes, edges: state.edges })];
        while (past.length > HISTORY_LIMIT) past.shift();
        set({ nodes: nextNodes, past, future: [], isDirty: dirty ? true : state.isDirty });
      } else {
        set({ nodes: nextNodes, isDirty: dirty ? true : state.isDirty });
      }
    },

    onEdgesChange: (changes) => {
      const state = get();
      const nextEdges = applyEdgeChanges(changes, state.edges);
      const shouldRecord = shouldRecordEdgeChanges(changes);
      const dirty = edgeChangesAffectWorkflow(changes);
      if (shouldRecord) {
        const past = [...state.past, snapshot({ nodes: state.nodes, edges: state.edges })];
        while (past.length > HISTORY_LIMIT) past.shift();
        set({ edges: nextEdges, past, future: [], isDirty: dirty ? true : state.isDirty });
      } else {
        set({ edges: nextEdges, isDirty: dirty ? true : state.isDirty });
      }
    },

    onConnect: (connection) => {
      const history = pushHistory();
      set({
        edges: addEdge(connection, get().edges),
        isDirty: true,
        ...history,
      });
    },

    setSelectedNodeId: (id) => set({ selectedNodeId: id }),

    setSelection: ({ nodeIds, edgeIds }) => {
      const idSet = new Set(nodeIds);
      const edgeSet = new Set(edgeIds);
      set((state) => ({
        selectedNodeIds: nodeIds,
        selectedEdgeIds: edgeIds,
        selectedNodeId: nodeIds[0] ?? null,
        // Mirror the selection onto the actual node/edge data so visual state
        // matches and follow-up actions (copy/delete via toolbar buttons) see
        // a consistent picture.
        nodes: state.nodes.map((n) => {
          const nn = n as WorkflowNode & { selected?: boolean };
          const wantSelected = idSet.has(n.id);
          if (Boolean(nn.selected) === wantSelected) return n;
          return { ...nn, selected: wantSelected } as WorkflowNode;
        }),
        edges: state.edges.map((e) => {
          const ee = e as WorkflowEdge & { selected?: boolean };
          const wantSelected = edgeSet.has(e.id);
          if (Boolean(ee.selected) === wantSelected) return e;
          return { ...ee, selected: wantSelected } as WorkflowEdge;
        }),
      }));
    },

    addNode: (node) => {
      const history = pushHistory();
      set((state) => ({ nodes: [...state.nodes, node], isDirty: true, ...history }));
    },

    updateNodeConfig: (nodeId, config) => {
      const state = get();
      const target = state.nodes.find((n) => n.id === nodeId);
      // Snapshot only if this is the first edit since last snapshot for this node.
      const last = state.past[state.past.length - 1];
      const lastHasSameNode = last?.nodes.find((n) => n.id === nodeId);
      const shouldSnapshot =
        !lastHasSameNode ||
        JSON.stringify(lastHasSameNode?.data) === JSON.stringify(target?.data);
      const partial = shouldSnapshot ? pushHistory() : {};
      set({
        nodes: state.nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, ...config } } : n,
        ),
        isDirty: true,
        ...partial,
      });
    },

    toggleNodeDisabled: (nodeId) => {
      const history = pushHistory();
      set((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, disabled: !(n.data?.disabled ?? false) } }
            : n,
        ),
        isDirty: true,
        ...history,
      }));
    },

    setDirty: (dirty) => set({ isDirty: dirty }),

    // ── History ────────────────────────────────────────────────────────
    undo: () => {
      const state = get();
      const last = state.past[state.past.length - 1];
      if (!last) return;
      const newPast = state.past.slice(0, -1);
      const newFuture = [...state.future, snapshot({ nodes: state.nodes, edges: state.edges })];
      while (newFuture.length > HISTORY_LIMIT) newFuture.shift();
      set({
        past: newPast,
        future: newFuture,
        nodes: last.nodes,
        edges: last.edges,
        isDirty: true,
      });
    },
    redo: () => {
      const state = get();
      const next = state.future[state.future.length - 1];
      if (!next) return;
      const newFuture = state.future.slice(0, -1);
      const newPast = [...state.past, snapshot({ nodes: state.nodes, edges: state.edges })];
      while (newPast.length > HISTORY_LIMIT) newPast.shift();
      set({
        past: newPast,
        future: newFuture,
        nodes: next.nodes,
        edges: next.edges,
        isDirty: true,
      });
    },
    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,

    // ── Clipboard ──────────────────────────────────────────────────────
    copySelection: () => {
      const state = get();
      // `selectedNodeIds` is the authoritative selection — kept in sync by
      // ReactFlow's onSelectionChange → setSelection. Don't union with the
      // per-node `.selected` flag, which can lag (e.g. after a paste sets it
      // on newly-created nodes that the user hasn't actually selected for the
      // current action).
      const selectedIds = new Set<string>(state.selectedNodeIds);
      if (selectedIds.size === 0) return { nodeCount: 0, edgeCount: 0 };
      const nodes = state.nodes.filter((n) => selectedIds.has(n.id));
      const edges = state.edges.filter((e) => selectedIds.has(e.source) && selectedIds.has(e.target));
      clipboard = { nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) };
      return { nodeCount: nodes.length, edgeCount: edges.length };
    },

    pasteClipboard: (offset = { x: 32, y: 32 }) => {
      if (clipboard.nodes.length === 0) return { nodeCount: 0, edgeCount: 0 };
      const idMap = new Map<string, string>();
      const newNodes: WorkflowNode[] = clipboard.nodes.map((n) => {
        const newId = nanoid(8);
        idMap.set(n.id, newId);
        return {
          ...n,
          id: newId,
          position: { x: (n.position?.x ?? 0) + offset.x, y: (n.position?.y ?? 0) + offset.y },
          selected: true,
        } as WorkflowNode;
      });
      const newEdges: WorkflowEdge[] = clipboard.edges
        .filter((e) => idMap.has(e.source) && idMap.has(e.target))
        .map((e) => ({
          ...e,
          id: nanoid(8),
          source: idMap.get(e.source) as string,
          target: idMap.get(e.target) as string,
          selected: false,
        }));
      const history = pushHistory();
      set((state) => {
        // Deselect existing nodes so the paste highlights the new ones cleanly.
        const existing = state.nodes.map((n) => ({ ...(n as WorkflowNode & { selected?: boolean }), selected: false }));
        return {
          nodes: [...existing, ...newNodes] as WorkflowNode[],
          edges: [...state.edges, ...newEdges],
          isDirty: true,
          selectedNodeIds: newNodes.map((n) => n.id),
          selectedEdgeIds: [],
          selectedNodeId: newNodes[0]?.id ?? null,
          ...history,
        };
      });
      return { nodeCount: newNodes.length, edgeCount: newEdges.length };
    },

    duplicateSelection: () => {
      get().copySelection();
      return get().pasteClipboard({ x: 40, y: 40 });
    },

    deleteSelection: () => {
      const state = get();
      const selectedIds = new Set<string>(state.selectedNodeIds);
      const selectedEdgeIdSet = new Set<string>(state.selectedEdgeIds);
      if (selectedIds.size === 0 && selectedEdgeIdSet.size === 0) return { nodeCount: 0, edgeCount: 0 };
      const history = pushHistory();
      const remainingNodes = state.nodes.filter((n) => !selectedIds.has(n.id));
      const remainingEdges = state.edges.filter(
        (e) => !selectedEdgeIdSet.has(e.id) && !selectedIds.has(e.source) && !selectedIds.has(e.target),
      );
      set({
        nodes: remainingNodes,
        edges: remainingEdges,
        isDirty: true,
        selectedNodeIds: [],
        selectedEdgeIds: [],
        selectedNodeId: null,
        ...history,
      });
      return {
        nodeCount: state.nodes.length - remainingNodes.length,
        edgeCount: state.edges.length - remainingEdges.length,
      };
    },
  };
});

// Re-export so canvas/test can detect changes
export function _resetClipboardForTests(): void {
  clipboard = { nodes: [], edges: [] };
}
export function _readClipboardForTests(): Snapshot {
  return clipboard;
}

// Suppress unused-import warnings if any helper isn't referenced in some build modes.
export const __workflowStoreInternals = { nodesDifferTopologically, edgesDiffer };
