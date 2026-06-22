"use client";

import { type NodeProps } from "@xyflow/react";
import { Globe } from "lucide-react";
import type { NodeConfig } from "@/types/workflow";
import { BaseNode } from "@/components/nodes/base-node";
import { readNodeOverlayProps } from "@/components/nodes/use-node-overlay";

export function HttpNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const method = (nodeData.method as string) || "GET";
  const url = (nodeData.url as string) || "";

  return (
    <BaseNode
      accent="blue"
      selected={selected}
      icon={<Globe className="h-3.5 w-3.5" />}
      label={(nodeData.label as string) || "HTTP Request"}
      minWidth={220}
     {...readNodeOverlayProps(data)}>
      <span className="font-mono text-sky-400">{method}</span>
      {url ? ` ${url.slice(0, 32)}${url.length > 32 ? "…" : ""}` : " (no URL)"}
    </BaseNode>
  );
}
