"use client";

import { type NodeProps } from "@xyflow/react";
import { FolderOpen, FilePen } from "lucide-react";
import type { NodeConfig } from "@/types/workflow";
import { BaseNode } from "@/components/nodes/base-node";
import { readNodeOverlayProps } from "@/components/nodes/use-node-overlay";

export function ReadFileNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const filePath = (nodeData.path as string) || "";

  return (
    <BaseNode
      accent="cyan"
      selected={selected}
      icon={<FolderOpen className="h-3.5 w-3.5" />}
      label={(nodeData.label as string) || "Read File"}
      minWidth={200}
     {...readNodeOverlayProps(data)}>
      <span className="font-mono">{filePath || "(no path)"}</span>
    </BaseNode>
  );
}

export function WriteFileNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const filePath = (nodeData.path as string) || "";
  const mode = (nodeData.mode as string) || "overwrite";

  return (
    <BaseNode
      accent="cyan"
      selected={selected}
      icon={<FilePen className="h-3.5 w-3.5" />}
      label={(nodeData.label as string) || "Write File"}
      minWidth={200}
     {...readNodeOverlayProps(data)}>
      <div className="space-y-0.5">
        <div className="font-mono truncate">{filePath || "(no path)"}</div>
        <div>{mode}</div>
      </div>
    </BaseNode>
  );
}
