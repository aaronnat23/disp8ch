"use client";

import { type NodeProps } from "@xyflow/react";
import { Bot, GitFork } from "lucide-react";
import type { NodeConfig } from "@/types/workflow";
import { BaseNode } from "@/components/nodes/base-node";
import { readNodeOverlayProps } from "@/components/nodes/use-node-overlay";

export function AgentNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const prompt = (nodeData.systemPrompt as string) || "";
  const truncatedPrompt = prompt.length > 60 ? prompt.substring(0, 60) + "…" : prompt;
  const displayLabel =
    nodeData.label === "Claude Agent" ? "Agent" : (nodeData.label as string) || "Agent";

  return (
    <BaseNode
      accent="purple"
      selected={selected}
      icon={<Bot className="h-3.5 w-3.5" />}
      label={displayLabel}
     {...readNodeOverlayProps(data)}>
      {truncatedPrompt || "No system prompt set"}
    </BaseNode>
  );
}

export function ParallelAgentsNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const workers = Array.isArray(nodeData.workers) ? nodeData.workers.length : 0;
  const maxParallel = Number(nodeData.maxParallel || workers || 1);
  const displayLabel = (nodeData.label as string) || "Parallel Agents";

  return (
    <BaseNode
      accent="purple"
      selected={selected}
      icon={<GitFork className="h-3.5 w-3.5" />}
      label={displayLabel}
      minWidth={200}
     {...readNodeOverlayProps(data)}>
      {workers} worker{workers === 1 ? "" : "s"} in parallel (max {maxParallel})
    </BaseNode>
  );
}
