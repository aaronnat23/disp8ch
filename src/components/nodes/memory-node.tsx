"use client";

import { type NodeProps } from "@xyflow/react";
import { Brain, BookOpen } from "lucide-react";
import type { NodeConfig } from "@/types/workflow";
import { BaseNode } from "@/components/nodes/base-node";
import { readNodeOverlayProps } from "@/components/nodes/use-node-overlay";

export function MemoryNode({ data, type, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const isRecall = type === "memory-recall";

  return (
    <BaseNode
      accent="amber"
      selected={selected}
      icon={isRecall ? <BookOpen className="h-3.5 w-3.5" /> : <Brain className="h-3.5 w-3.5" />}
      label={(nodeData.label as string) || (isRecall ? "Memory Recall" : "Memory Store")}
     {...readNodeOverlayProps(data)}>
      {isRecall
        ? `Query: ${(nodeData.query as string) || "{{trigger.message}}"} · Mode: ${(nodeData.mode as string) || "search"}`
        : `Mode: ${(nodeData.extractMode as string) || "auto"}`}
    </BaseNode>
  );
}
