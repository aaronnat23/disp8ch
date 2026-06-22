"use client";

import { type NodeProps } from "@xyflow/react";
import { Zap, Webhook, Play, Clock, MessageSquare } from "lucide-react";
import type { NodeConfig } from "@/types/workflow";
import { BaseNode } from "@/components/nodes/base-node";
import { readNodeOverlayProps } from "@/components/nodes/use-node-overlay";

const icons: Record<string, React.ElementType> = {
  "message-trigger": Zap,
  "webhook-trigger": Webhook,
  "manual-trigger": Play,
  "cron-trigger": Clock,
  "telegram-trigger": MessageSquare,
  "discord-trigger": MessageSquare,
};

export function TriggerNode({ data, type, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const Icon = icons[type || "message-trigger"] || Zap;

  return (
    <BaseNode
      accent="green"
      selected={selected}
      hasTarget={false}
      icon={<Icon className="h-3.5 w-3.5" />}
      label={(nodeData.label as string) || "Trigger"}
     {...readNodeOverlayProps(data)}>
      {type === "message-trigger" && `Channel: ${(nodeData.channel as string) || "webchat"}`}
      {type === "webhook-trigger" && `Path: ${(nodeData.path as string) || "/webhook"}`}
      {type === "manual-trigger" && "Click Run to trigger"}
      {type === "cron-trigger" && `Schedule: ${(nodeData.expression as string) || "* * * * *"}`}
      {type === "telegram-trigger" && "Telegram message"}
      {type === "discord-trigger" && "Discord message"}
    </BaseNode>
  );
}
