"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { StickyNote } from "lucide-react";
import type { NodeConfig } from "@/types/workflow";

export function StickyNoteNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const note = String(nodeData.note || nodeData.content || "Add notes, assumptions, or setup steps here.").trim();

  return (
    <div
      className={[
        "min-w-[240px] max-w-[320px] rounded-xl border bg-yellow-100 text-yellow-950 shadow-sm dark:bg-yellow-500/15 dark:text-yellow-100",
        selected ? "border-yellow-400 shadow-yellow-500/20" : "border-yellow-300/60 dark:border-yellow-500/40",
      ].join(" ")}
    >
      <div className="flex items-center gap-2 border-b border-yellow-300/60 px-3 py-2 dark:border-yellow-500/30">
        <StickyNote className="h-4 w-4" />
        <span className="text-sm font-semibold">{String(nodeData.label || "Sticky Note")}</span>
      </div>
      <div className="whitespace-pre-wrap px-3 py-2 text-xs leading-relaxed">{note}</div>
      <Handle type="target" position={Position.Left} className="!bg-yellow-500" />
      <Handle type="source" position={Position.Right} className="!bg-yellow-500" />
    </div>
  );
}
