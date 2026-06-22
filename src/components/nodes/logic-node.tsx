"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { GitBranch } from "lucide-react";
import type { NodeConfig } from "@/types/workflow";
import { BaseNode } from "@/components/nodes/base-node";
import { readNodeOverlayProps } from "@/components/nodes/use-node-overlay";

export function LogicNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const condition = (nodeData.condition as string) || "";

  return (
    <BaseNode
      accent="gray"
      selected={selected}
      hasSource={false}
      icon={<GitBranch className="h-3.5 w-3.5" />}
      label={(nodeData.label as string) || "If/Else"}
      extraHandles={
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="true"
            style={{ top: "38%", background: "#22c55e" }}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="false"
            style={{ top: "70%", background: "#ef4444" }}
          />
        </>
      }
     {...readNodeOverlayProps(data)}>
      <div className="space-y-1">
        <div className="truncate">{condition || "No condition set"}</div>
        <div className="flex gap-3 text-[10px] font-mono uppercase tracking-wider">
          <span className="text-emerald-400">true →</span>
          <span className="text-red-400">false →</span>
        </div>
      </div>
    </BaseNode>
  );
}
