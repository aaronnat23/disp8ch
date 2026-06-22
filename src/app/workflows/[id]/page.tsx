"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { ReactFlowProvider } from "@xyflow/react";
import { WorkflowCanvas } from "@/components/workflow/canvas";
import { NodePalette } from "@/components/workflow/node-palette";
import { NodeConfigPanel } from "@/components/workflow/node-config-panel";
import { Toolbar } from "@/components/workflow/toolbar";
import { ExecutionLog } from "@/components/workflow/execution-log";
import { WorkflowAdvancedPanel } from "@/components/workflow/workflow-advanced-panel";
import { useWorkflowStore } from "@/stores/workflow-store";
import { useExecutionStore } from "@/stores/execution-store";
import type { WorkflowEdge, WorkflowNode } from "@/types/workflow";

type EditorValidationIssue = {
  nodeId: string;
  message: string;
};

function validateWorkflowForEditor(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): { errors: EditorValidationIssue[]; warnings: EditorValidationIssue[] } {
  const errors: EditorValidationIssue[] = [];
  const warnings: EditorValidationIssue[] = [];
  const triggerNodes = nodes.filter((node) => String(node.type || "").includes("trigger"));

  if (nodes.length === 0) {
    errors.push({ nodeId: "", message: "Add at least one node before running." });
  }
  if (triggerNodes.length === 0) {
    errors.push({ nodeId: "", message: "Workflow needs a trigger node." });
  }

  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
  }

  const hasLoopNode = nodes.some((node) => node.type === "loop");
  if (!hasLoopNode) {
    const visited = new Set<string>();
    const stack = new Set<string>();
    const visit = (nodeId: string): boolean => {
      visited.add(nodeId);
      stack.add(nodeId);
      for (const target of adjacency.get(nodeId) ?? []) {
        if (!visited.has(target) && visit(target)) return true;
        if (stack.has(target)) return true;
      }
      stack.delete(nodeId);
      return false;
    };
    for (const node of nodes) {
      if (!visited.has(node.id) && visit(node.id)) {
        errors.push({ nodeId: node.id, message: "Cycle detected. Use a Loop node for intentional repetition." });
        break;
      }
    }
  }

  for (const node of nodes) {
    if (node.type === "claude-agent" && !String(node.data.systemPrompt || "").trim() && !String(node.data.agentId || "").trim()) {
      errors.push({
        nodeId: node.id,
        message: `${String(node.data.label || "Agent")} needs a system prompt or agent profile.`,
      });
    }
  }

  const reachable = new Set<string>();
  const dfs = (nodeId: string) => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) dfs(target);
  };
  for (const trigger of triggerNodes) dfs(trigger.id);

  const terminalTypes = new Set([
    "send-webchat",
    "send-whatsapp",
    "send-telegram",
    "send-discord",
    "send-email",
    "send-slack",
    "send-bluebubbles",
    "send-teams",
    "memory-store",
    "notification",
  ]);

  for (const node of nodes) {
    if (!reachable.has(node.id) && !String(node.type || "").includes("trigger")) {
      warnings.push({ nodeId: node.id, message: `${String(node.data.label || node.id)} is not reachable from a trigger.` });
    }
    const hasIncoming = edges.some((edge) => edge.target === node.id);
    const hasOutgoing = edges.some((edge) => edge.source === node.id);
    if (hasIncoming && !hasOutgoing && !terminalTypes.has(String(node.type || ""))) {
      warnings.push({ nodeId: node.id, message: `${String(node.data.label || node.id)} has no outgoing connection.` });
    }
  }

  return { errors, warnings };
}

export default function WorkflowEditorPage() {
  const params = useParams();
  const id = params.id as string;
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [loadingWorkflow, setLoadingWorkflow] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const {
    setCurrentWorkflow,
    nodes,
    edges,
    setDirty,
    currentWorkflow,
    undo,
    redo,
    copySelection,
    pasteClipboard,
    duplicateSelection,
    deleteSelection,
    selectedNodeId,
  } = useWorkflowStore();
  const { addLogEntry, clearLog, setIsRunning, setActiveNodeId, setNodeOverlay, resetNodeOverlays, setCurrentExecution, currentExecution } =
    useExecutionStore();

  // Suppress validation errors while loading or if load failed
  const validation = useMemo(() => {
    if (loadingWorkflow || loadError) return { errors: [], warnings: [] };
    return validateWorkflowForEditor(nodes, edges);
  }, [nodes, edges, loadingWorkflow, loadError]);

  const loadWorkflow = useCallback(async () => {
    setLoadingWorkflow(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/workflows`);
      const data = await response.json();
      if (data.success) {
        const wf = data.data.find((w: { id: string }) => w.id === id);
        if (wf) {
          setCurrentWorkflow(wf);
        } else {
          setLoadError(`Workflow "${id}" not found.`);
        }
      } else {
        setLoadError(data.error || "Failed to load workflow.");
      }
    } catch {
      setLoadError("Failed to load workflow. Check the server and try again.");
    } finally {
      setLoadingWorkflow(false);
    }
  }, [id, setCurrentWorkflow]);

  useEffect(() => {
    void loadWorkflow();
  }, [loadWorkflow]);

  // Live graph status overlay (Gap 6): hydrate node badges from the latest
  // persisted trace so the canvas shows last-run status/duration on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/workflows/debugger?workflowId=${encodeURIComponent(id)}`);
        const json = await res.json() as {
          success: boolean;
          data?: { trace?: { traces?: Array<{ nodeId: string; status: "completed" | "failed" | "skipped"; durationMs: number | null }> } };
        };
        if (cancelled || !json.success) return;
        const traces = json.data?.trace?.traces ?? [];
        if (traces.length === 0) return;
        // Only hydrate when not mid-run (avoid clobbering live overlays).
        if (useExecutionStore.getState().isRunning) return;
        for (const t of traces) {
          const baseId = t.nodeId.includes(".loop.") ? t.nodeId.split(".loop.")[0] : t.nodeId;
          setNodeOverlay(baseId, { status: t.status, durationMs: t.durationMs ?? undefined });
        }
      } catch {
        // best-effort overlay; ignore failures
      }
    })();
    return () => { cancelled = true; };
  }, [id, setNodeOverlay]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveNotice(null);
    try {
      const response = await fetch("/api/workflows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          name: currentWorkflow?.name,
          nodes,
          edges,
        }),
      });
      const json = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!response.ok || json?.success === false) {
        setSaveNotice({ tone: "error", message: json?.error || "Save failed." });
        return;
      }
      setDirty(false);
      setSaveNotice({ tone: "success", message: "Workflow saved." });
    } catch {
      setSaveNotice({ tone: "error", message: "Save failed. Check the server and try again." });
    } finally {
      setSaving(false);
    }
  }, [id, currentWorkflow?.name, nodes, edges, setDirty]);

  const handleRun = useCallback(async () => {
    clearLog();
    resetNodeOverlays();
    if (validation.errors.length > 0) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        nodeId: "",
        nodeName: "Validation",
        message: validation.errors.map((issue) => issue.message).join(" "),
        type: "error",
      });
      return;
    }
    setIsRunning(true);

    addLogEntry({
      timestamp: new Date().toISOString(),
      nodeId: "",
      nodeName: "System",
      message: "Starting workflow execution...",
      type: "info",
    });

    try {
      // Save first
      await fetch("/api/workflows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, nodes, edges }),
      });

      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: id,
          triggerType: "manual",
          triggerData: { triggeredAt: new Date().toISOString() },
        }),
      });

      const data = await res.json();

      if (data.success) {
        setCurrentExecution(data.data);
        // Display node results in log + populate per-node overlay on the canvas.
        if (data.data.nodeResults) {
          for (const [nodeId, result] of Object.entries(data.data.nodeResults)) {
            const r = result as { output?: Record<string, unknown>; duration: number; error?: string };
            const node = nodes.find((n) => n.id === nodeId);
            setActiveNodeId(nodeId);
            addLogEntry({
              timestamp: new Date().toISOString(),
              nodeId,
              nodeName: (node?.data?.label as string) || nodeId,
              message: r.error
                ? `Error: ${r.error}`
                : `Completed (${r.duration}ms)`,
              type: r.error ? "error" : "success",
            });
            // Per-node overlay: status + duration so the canvas can paint badges
            const outPreview = (() => {
              if (!r.output) return undefined;
              try {
                return JSON.stringify(r.output).slice(0, 600);
              } catch { return undefined; }
            })();
            setNodeOverlay(nodeId, {
              status: r.error ? "failed" : "completed",
              durationMs: r.duration,
              error: r.error,
              outputPreview: outPreview,
            });
          }
        }

        addLogEntry({
          timestamp: new Date().toISOString(),
          nodeId: "",
          nodeName: "System",
          message: data.data.status === "completed"
            ? "Workflow completed successfully"
            : `Workflow ${data.data.status}: ${data.data.error || ""}`,
          type: data.data.status === "completed" ? "success" : "error",
        });
      } else {
        addLogEntry({
          timestamp: new Date().toISOString(),
          nodeId: "",
          nodeName: "System",
          message: `Error: ${data.error}`,
          type: "error",
        });
      }
    } catch (error) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        nodeId: "",
        nodeName: "System",
        message: `Error: ${String(error)}`,
        type: "error",
      });
    }

    setActiveNodeId(null);
    setIsRunning(false);
  }, [id, nodes, edges, addLogEntry, clearLog, setIsRunning, setActiveNodeId, setCurrentExecution, validation.errors, resetNodeOverlays, setNodeOverlay]);

  const handleRunToNode = useCallback(async () => {
    clearLog();
    resetNodeOverlays();
    if (!selectedNodeId) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        nodeId: "",
        nodeName: "Validation",
        message: "Select a node before using Run to node.",
        type: "error",
      });
      return;
    }
    if (validation.errors.length > 0) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        nodeId: "",
        nodeName: "Validation",
        message: validation.errors.map((issue) => issue.message).join(" "),
        type: "error",
      });
      return;
    }

    setIsRunning(true);
    addLogEntry({
      timestamp: new Date().toISOString(),
      nodeId: selectedNodeId,
      nodeName: "System",
      message: `Running workflow to selected node: ${selectedNodeId}`,
      type: "info",
    });

    try {
      await fetch("/api/workflows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, nodes, edges }),
      });

      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: id,
          triggerType: "manual",
          triggerData: { triggeredAt: new Date().toISOString(), mode: "run-to-node" },
          executionMode: "partial",
          targetNodeId: selectedNodeId,
          usePinnedData: true,
        }),
      });
      const data = await res.json();

      if (data.success) {
        setCurrentExecution(data.data);
        if (data.data.nodeResults) {
          for (const [nodeId, result] of Object.entries(data.data.nodeResults)) {
            const r = result as { output?: Record<string, unknown>; duration: number; error?: string };
            const node = nodes.find((n) => n.id === nodeId);
            setActiveNodeId(nodeId);
            addLogEntry({
              timestamp: new Date().toISOString(),
              nodeId,
              nodeName: (node?.data?.label as string) || nodeId,
              message: r.error ? `Error: ${r.error}` : `Completed (${r.duration}ms)`,
              type: r.error ? "error" : "success",
            });
            const outPreview = (() => {
              if (!r.output) return undefined;
              try {
                return JSON.stringify(r.output).slice(0, 600);
              } catch { return undefined; }
            })();
            setNodeOverlay(nodeId, {
              status: r.error ? "failed" : "completed",
              durationMs: r.duration,
              error: r.error,
              outputPreview: outPreview,
            });
          }
        }
        addLogEntry({
          timestamp: new Date().toISOString(),
          nodeId: selectedNodeId,
          nodeName: "System",
          message: data.data.status === "completed"
            ? "Run to node completed"
            : `Run to node ${data.data.status}: ${data.data.error || ""}`,
          type: data.data.status === "completed" ? "success" : "error",
        });
      } else {
        addLogEntry({
          timestamp: new Date().toISOString(),
          nodeId: selectedNodeId,
          nodeName: "System",
          message: `Error: ${data.error}`,
          type: "error",
        });
      }
    } catch (error) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        nodeId: selectedNodeId,
        nodeName: "System",
        message: `Error: ${String(error)}`,
        type: "error",
      });
    }

    setActiveNodeId(null);
    setIsRunning(false);
  }, [
    addLogEntry,
    clearLog,
    edges,
    id,
    nodes,
    resetNodeOverlays,
    selectedNodeId,
    setActiveNodeId,
    setCurrentExecution,
    setIsRunning,
    setNodeOverlay,
    validation.errors,
  ]);

  // ── Keyboard shortcuts (Ctrl+S, Ctrl+Enter, Delete, Ctrl+D, Ctrl+Z, Ctrl+Y, Ctrl+C/V) ──
  useEffect(() => {
    const handledEvents = new WeakSet<KeyboardEvent>();
    const isTypingInField = (el: EventTarget | null): boolean => {
      if (!el || !(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select";
    };

    const onKey = (e: KeyboardEvent) => {
      if (handledEvents.has(e)) return;
      const meta = e.ctrlKey || e.metaKey;
      const key = e.key;
      const target = e.target;
      // Save/run work even when an input is focused; the rest should not steal text keys.
      if (meta && (key === "s" || key === "S")) {
        handledEvents.add(e);
        e.preventDefault();
        handleSave();
        return;
      }
      if (meta && key === "Enter") {
        handledEvents.add(e);
        e.preventDefault();
        handleRun();
        return;
      }
      if (isTypingInField(target)) return;

      if (meta && (key === "z" || key === "Z") && !e.shiftKey) {
        handledEvents.add(e);
        e.preventDefault();
        undo();
        return;
      }
      if ((meta && key === "y") || (meta && e.shiftKey && (key === "z" || key === "Z"))) {
        handledEvents.add(e);
        e.preventDefault();
        redo();
        return;
      }
      if (meta && (key === "c" || key === "C")) {
        handledEvents.add(e);
        e.preventDefault();
        copySelection();
        return;
      }
      if (meta && (key === "v" || key === "V")) {
        handledEvents.add(e);
        e.preventDefault();
        pasteClipboard({ x: 32, y: 32 });
        return;
      }
      if (meta && (key === "d" || key === "D")) {
        handledEvents.add(e);
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (key === "Delete" || key === "Backspace") {
        // Backspace also deletes. Skip when text input has focus.
        const removed = deleteSelection();
        if (removed.nodeCount > 0 || removed.edgeCount > 0) {
          handledEvents.add(e);
          e.preventDefault();
        }
        return;
      }
    };

    window.addEventListener("keydown", onKey, { capture: true });
    document.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      document.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [handleSave, handleRun, undo, redo, copySelection, pasteClipboard, duplicateSelection, deleteSelection]);

  return (
    <ReactFlowProvider>
      <div className="flex h-screen flex-col">
        <Toolbar onSave={handleSave} onRun={handleRun} onRunToNode={handleRunToNode} saving={saving} />
        <div className="border-b bg-card/80 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono uppercase tracking-wider text-muted-foreground">Validation</span>
              {loadingWorkflow ? (
                <span className="rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-blue-700 dark:text-blue-300">
                  Loading workflow...
                </span>
              ) : loadError ? (
                <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-red-700 dark:text-red-300">
                  {loadError}
                </span>
              ) : validation.errors.length === 0 ? (
                <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-300">
                  Ready to run
                </span>
              ) : (
                <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-red-700 dark:text-red-300">
                  {validation.errors.length} error{validation.errors.length === 1 ? "" : "s"}
                </span>
              )}
              {!loadingWorkflow && !loadError && validation.warnings.length > 0 ? (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                  {validation.warnings.length} warning{validation.warnings.length === 1 ? "" : "s"}
                </span>
              ) : null}
              {!loadingWorkflow && !loadError && [...validation.errors, ...validation.warnings].slice(0, 2).map((issue, index) => (
                <span key={`${issue.nodeId}-${index}`} className="text-muted-foreground">
                  {issue.message}
                </span>
              ))}
            </div>
            {saveNotice ? (
              <button
                type="button"
                role="status"
                aria-live="polite"
                data-workflow-save-status={saveNotice.tone}
                className={saveNotice.tone === "success" ? "text-emerald-600 dark:text-emerald-300" : "text-red-600 dark:text-red-300"}
                onClick={() => setSaveNotice(null)}
              >
                {saveNotice.message}
              </button>
            ) : null}
          </div>
        </div>
        {loadingWorkflow ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span>Loading workflow...</span>
            </div>
          </div>
        ) : loadError ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-center">
              <p className="text-lg font-medium text-red-600 dark:text-red-400">{loadError}</p>
              <button
                type="button"
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                onClick={() => void loadWorkflow()}
              >
                Retry
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 overflow-hidden">
            <NodePalette />
            <div className="flex-1">
              <WorkflowCanvas />
            </div>
            <NodeConfigPanel />
            <WorkflowAdvancedPanel
              workflowId={id}
              workflowName={currentWorkflow?.name || "Untitled Workflow"}
              nodes={nodes}
              edges={edges}
              selectedNodeId={selectedNodeId}
              nodeResults={currentExecution?.nodeResults}
              currentExecution={currentExecution}
              onWorkflowReload={loadWorkflow}
            />
          </div>
        )}
        <ExecutionLog />
      </div>
    </ReactFlowProvider>
  );
}
