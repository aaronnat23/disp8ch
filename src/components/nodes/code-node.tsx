"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Code2, Workflow, Terminal } from "lucide-react";
import type { NodeConfig } from "@/types/workflow";

export function CodeNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const code = (nodeData.code as string) || "";
  const preview = code.split("\n")[0]?.slice(0, 40) || "(no code)";

  return (
    <div
      className={`min-w-[220px] rounded-xl border bg-card shadow-sm ${
        selected ? "border-cyan-400 shadow-lg shadow-cyan-500/20" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-xl bg-cyan-500/10 px-3 py-2">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-cyan-500">
          <Code2 className="h-3.5 w-3.5 text-white" />
        </div>
        <span className="text-sm font-medium">{(nodeData.label as string) || "Run Code"}</span>
      </div>
      <div className="px-3 py-2">
        <div className="text-xs text-muted-foreground font-mono truncate">{preview}</div>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-cyan-500" />
      <Handle type="source" position={Position.Right} className="!bg-cyan-500" />
    </div>
  );
}

export function CallWorkflowNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const workflowId = (nodeData.workflowId as string) || "";

  return (
    <div
      className={`min-w-[220px] rounded-xl border bg-card shadow-sm ${
        selected ? "border-purple-400 shadow-lg shadow-purple-500/20" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-xl bg-purple-500/10 px-3 py-2">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-purple-500">
          <Workflow className="h-3.5 w-3.5 text-white" />
        </div>
        <span className="text-sm font-medium">{(nodeData.label as string) || "Call Workflow"}</span>
      </div>
      <div className="px-3 py-2">
        <div className="text-xs text-muted-foreground font-mono truncate">
          {workflowId || "(select workflow)"}
        </div>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-purple-500" />
      <Handle type="source" position={Position.Right} className="!bg-purple-500" />
    </div>
  );
}

export function SpawnCodingAgentNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const agent = (nodeData.agent as string) || "claude";
  const mode  = (nodeData.mode  as string) || "run";
  const agentLabel = agent === "claude" ? "Claude Code" : agent === "gemini" ? "Gemini CLI" : "Codex";

  return (
    <div
      className={`min-w-[220px] rounded-xl border bg-card shadow-sm ${
        selected ? "border-cyan-400 shadow-lg shadow-cyan-500/20" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-xl bg-cyan-500/10 px-3 py-2">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-cyan-500">
          <Terminal className="h-3.5 w-3.5 text-white" />
        </div>
        <span className="text-sm font-medium">{(nodeData.label as string) || "Spawn Coding Agent"}</span>
      </div>
      <div className="px-3 py-2">
        <div className="text-xs text-muted-foreground">
          {agentLabel} · {mode}
        </div>
      </div>
      <Handle type="target" position={Position.Left}  className="!bg-cyan-500" />
      <Handle type="source" position={Position.Right} className="!bg-cyan-500" />
    </div>
  );
}
