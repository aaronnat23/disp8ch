"use client";

import { type NodeProps } from "@xyflow/react";
import { Send, MessageCircle, Mail } from "lucide-react";
import type { NodeConfig } from "@/types/workflow";
import { BaseNode, type NodeAccent } from "@/components/nodes/base-node";
import { readNodeOverlayProps } from "@/components/nodes/use-node-overlay";

const CHANNEL_CONFIG: Record<string, { label: string; accent: NodeAccent; desc: string }> = {
  "send-webchat": { label: "Send WebChat", accent: "orange", desc: "Send to WebChat" },
  "send-whatsapp": { label: "Send WhatsApp", accent: "green", desc: "Reply to sender" },
  "send-telegram": { label: "Send Telegram", accent: "blue", desc: "Send via Telegram" },
  "send-discord": { label: "Send Discord", accent: "purple", desc: "Post to Discord channel" },
  "send-email": { label: "Send Email", accent: "red", desc: "Send email" },
  "send-sms": { label: "Send SMS", accent: "green", desc: "Send text message" },
  "send-slack": { label: "Send Slack", accent: "purple", desc: "Post to Slack" },
  "send-bluebubbles": { label: "Send BlueBubbles", accent: "blue", desc: "Send to iMessage chat" },
  "send-teams": { label: "Send Teams", accent: "blue", desc: "Reply in Teams" },
};

function ChannelIcon({ type }: { type: string }) {
  if (type === "send-whatsapp") return <MessageCircle className="h-3.5 w-3.5" />;
  if (type === "send-email") return <Mail className="h-3.5 w-3.5" />;
  if (type === "send-sms") return <MessageCircle className="h-3.5 w-3.5" />;
  return <Send className="h-3.5 w-3.5" />;
}

export function ChannelNode({ data, type, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const cfg = CHANNEL_CONFIG[type || "send-webchat"] || CHANNEL_CONFIG["send-webchat"];

  return (
    <BaseNode
      accent={cfg.accent}
      selected={selected}
      hasSource={false}
      icon={<ChannelIcon type={type || ""} />}
      label={(nodeData.label as string) || cfg.label}
     {...readNodeOverlayProps(data)}>
      {cfg.desc}
    </BaseNode>
  );
}
