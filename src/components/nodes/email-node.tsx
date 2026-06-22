"use client";

import { type NodeProps } from "@xyflow/react";
import { Mail } from "lucide-react";
import type { NodeConfig } from "@/types/workflow";
import { BaseNode } from "@/components/nodes/base-node";
import { readNodeOverlayProps } from "@/components/nodes/use-node-overlay";

export function EmailNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const to = (nodeData.to as string) || "";
  const subject = (nodeData.subject as string) || "";

  return (
    <BaseNode
      accent="red"
      selected={selected}
      icon={<Mail className="h-3.5 w-3.5" />}
      label={(nodeData.label as string) || "Send Email"}
      minWidth={220}
     {...readNodeOverlayProps(data)}>
      {to || subject ? (
        <div className="space-y-0.5">
          {to && <div className="truncate">To: {to}</div>}
          {subject && <div className="truncate">Subject: {subject}</div>}
        </div>
      ) : (
        "(configure recipient)"
      )}
    </BaseNode>
  );
}
