"use client";

import { type NodeProps } from "@xyflow/react";
import { Mic, Volume2 } from "lucide-react";
import type { NodeConfig } from "@/types/workflow";
import { BaseNode } from "@/components/nodes/base-node";
import { readNodeOverlayProps } from "@/components/nodes/use-node-overlay";

export function VoiceSttNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const language = (nodeData.language as string) || "auto";

  return (
    <BaseNode
      accent="teal"
      selected={selected}
      icon={<Mic className="h-3.5 w-3.5" />}
      label={(nodeData.label as string) || "Speech → Text"}
      minWidth={200}
     {...readNodeOverlayProps(data)}>
      whisper-1 · {language}
    </BaseNode>
  );
}

export function VoiceTtsNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const voice = (nodeData.voice as string) || "alloy";

  return (
    <BaseNode
      accent="teal"
      selected={selected}
      icon={<Volume2 className="h-3.5 w-3.5" />}
      label={(nodeData.label as string) || "Text → Speech"}
      minWidth={200}
     {...readNodeOverlayProps(data)}>
      tts-1 · voice: {voice}
    </BaseNode>
  );
}
