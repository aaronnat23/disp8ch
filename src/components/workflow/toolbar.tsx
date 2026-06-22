"use client";

import { Button } from "@/components/ui/button";
import { Save, Play, ArrowLeft, Loader2, Undo2, Redo2, Copy, ClipboardPaste, Trash2, Route } from "lucide-react";
import Link from "next/link";
import { useWorkflowStore } from "@/stores/workflow-store";
import { useExecutionStore } from "@/stores/execution-store";

interface ToolbarProps {
  onSave: () => void;
  onRun: () => void;
  onRunToNode?: () => void;
  saving: boolean;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl";

export function Toolbar({ onSave, onRun, onRunToNode, saving }: ToolbarProps) {
  const {
    currentWorkflow,
    isDirty,
    undo,
    redo,
    past,
    future,
    copySelection,
    pasteClipboard,
    deleteSelection,
    selectedNodeIds,
  } = useWorkflowStore();
  const isRunning = useExecutionStore((s) => s.isRunning);
  const workflowName = currentWorkflow?.name || "Untitled Workflow";
  const canUndo = past.length > 0;
  const canRedo = future.length > 0;
  const hasSelection = selectedNodeIds.length > 0;

  return (
    <div className="flex h-12 items-center justify-between border-b bg-card px-3">
      <div className="flex items-center gap-2">
        <Link href="/workflows">
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Back to workflows">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <span className="font-medium text-sm">{workflowName}</span>
        {isDirty && (
          <span className="text-xs text-muted-foreground">(unsaved)</span>
        )}
      </div>

      <div className="flex items-center gap-1">
        {/* Edit toolbar group */}
        <div className="flex items-center gap-0.5 mr-2 rounded-md border bg-background px-1 py-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={!canUndo}
            onClick={undo}
            title={`Undo (${mod}+Z)`}
            aria-label="Undo"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={!canRedo}
            onClick={redo}
            title={`Redo (${mod}+Shift+Z)`}
            aria-label="Redo"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </Button>
          <div className="w-px h-4 bg-border mx-0.5" />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={!hasSelection}
            onClick={() => copySelection()}
            title={`Copy selection (${mod}+C)`}
            aria-label="Copy"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => pasteClipboard({ x: 32, y: 32 })}
            title={`Paste (${mod}+V)`}
            aria-label="Paste"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={!hasSelection}
            onClick={() => deleteSelection()}
            title="Delete selection (Delete)"
            aria-label="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={onSave}
          disabled={saving || !isDirty}
          title={`Save (${mod}+S)`}
        >
          {saving ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-1 h-4 w-4" />
          )}
          Save
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onRunToNode}
          disabled={isRunning || !hasSelection || !onRunToNode}
          title="Run to node"
        >
          <Route className="mr-1 h-4 w-4" />
          Run to node
        </Button>
        <Button
          size="sm"
          onClick={onRun}
          disabled={isRunning}
          title={`Run (${mod}+Enter)`}
        >
          {isRunning ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-1 h-4 w-4" />
          )}
          Run
        </Button>
      </div>
    </div>
  );
}
