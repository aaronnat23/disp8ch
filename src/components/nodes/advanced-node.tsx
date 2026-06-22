"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Repeat,
  Layers,
  Merge,
  ShieldAlert,
  MessageSquareMore,
  Braces,
  Scissors,
  ScanSearch,
  Diff,
  Gauge,
  Database,
  ClipboardCopy,
  Bell,
  GitCommitHorizontal,
  Archive,
} from "lucide-react";
import type { NodeConfig } from "@/types/workflow";

function AdvancedNodeShell({
  label,
  subtitle,
  icon: Icon,
  color,
  selected,
  children,
}: {
  label: string;
  subtitle: string;
  icon: React.ElementType;
  color: string;
  selected?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`min-w-[200px] rounded-xl border bg-card shadow-sm transition-all ${
        selected ? "shadow-lg" : "border-border hover:border-foreground/25"
      }`}
      style={selected ? { borderColor: color, boxShadow: `0 8px 24px ${color}30` } : undefined}
    >
      <div
        className="flex items-center gap-2 rounded-t-xl px-2.5 py-1.5"
        style={{ backgroundColor: `${color}18` }}
      >
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{ backgroundColor: color }}
        >
          <Icon className="h-3.5 w-3.5 text-white" />
        </div>
        <span className="truncate text-sm font-semibold text-foreground">{label}</span>
      </div>
      <div className="px-2.5 py-2">
        <div className="text-[11px] leading-relaxed text-muted-foreground">{subtitle}</div>
      </div>
      {children}
    </div>
  );
}

export function LoopNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  return (
    <AdvancedNodeShell label={(d.label as string) || "Loop"} subtitle="Iterate over array" icon={Repeat} color="#8b5cf6" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-violet-500" />
      <Handle type="source" position={Position.Right} className="!bg-violet-500" />
    </AdvancedNodeShell>
  );
}

export function AggregateNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  return (
    <AdvancedNodeShell label={(d.label as string) || "Aggregate"} subtitle="Collect into array" icon={Layers} color="#8b5cf6" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-violet-500" />
      <Handle type="source" position={Position.Right} className="!bg-violet-500" />
    </AdvancedNodeShell>
  );
}

export function MergeNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  return (
    <AdvancedNodeShell label={(d.label as string) || "Merge"} subtitle="Combine branches" icon={Merge} color="#6b7280" selected={selected}>
      <Handle type="target" position={Position.Left} id="input_0" style={{ top: "35%" }} className="!bg-gray-500" />
      <Handle type="target" position={Position.Left} id="input_1" style={{ top: "65%" }} className="!bg-gray-500" />
      <Handle type="source" position={Position.Right} className="!bg-gray-500" />
    </AdvancedNodeShell>
  );
}

export function ErrorHandlerNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  return (
    <AdvancedNodeShell label={(d.label as string) || "Error Handler"} subtitle="Catch errors" icon={ShieldAlert} color="#ef4444" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-red-500" />
      <Handle type="source" position={Position.Right} id="success" style={{ top: "35%" }} className="!bg-green-500" />
      <Handle type="source" position={Position.Right} id="error" style={{ top: "65%" }} className="!bg-red-500" />
    </AdvancedNodeShell>
  );
}

export function WaitForInputNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  return (
    <AdvancedNodeShell label={(d.label as string) || "Wait for Input"} subtitle="Pause for user response" icon={MessageSquareMore} color="#f97316" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-orange-500" />
      <Handle type="source" position={Position.Right} className="!bg-orange-500" />
    </AdvancedNodeShell>
  );
}

export function JsonTransformNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  return (
    <AdvancedNodeShell label={(d.label as string) || "JSON Transform"} subtitle="Map/filter/reshape data" icon={Braces} color="#06b6d4" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-cyan-500" />
      <Handle type="source" position={Position.Right} className="!bg-cyan-500" />
    </AdvancedNodeShell>
  );
}

export function SplitTextNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  return (
    <AdvancedNodeShell label={(d.label as string) || "Split Text"} subtitle="Split into chunks" icon={Scissors} color="#06b6d4" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-cyan-500" />
      <Handle type="source" position={Position.Right} className="!bg-cyan-500" />
    </AdvancedNodeShell>
  );
}

export function RegexExtractNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  const pattern = (d.pattern as string) || "";
  return (
    <AdvancedNodeShell label={(d.label as string) || "Regex Extract"} subtitle={pattern ? `/${pattern}/` : "Extract patterns"} icon={ScanSearch} color="#06b6d4" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-cyan-500" />
      <Handle type="source" position={Position.Right} className="!bg-cyan-500" />
    </AdvancedNodeShell>
  );
}

export function CompareTextNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  return (
    <AdvancedNodeShell label={(d.label as string) || "Compare Text"} subtitle="Diff two texts" icon={Diff} color="#06b6d4" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-cyan-500" />
      <Handle type="source" position={Position.Right} className="!bg-cyan-500" />
    </AdvancedNodeShell>
  );
}

export function RateLimiterNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  const maxCalls = (d.maxCalls as number) || 10;
  const windowMs = (d.windowMs as number) || 60000;
  return (
    <AdvancedNodeShell label={(d.label as string) || "Rate Limiter"} subtitle={`${maxCalls} / ${windowMs / 1000}s`} icon={Gauge} color="#6b7280" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-gray-500" />
      <Handle type="source" position={Position.Right} className="!bg-gray-500" />
    </AdvancedNodeShell>
  );
}

export function DatabaseQueryNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  return (
    <AdvancedNodeShell label={(d.label as string) || "Database Query"} subtitle="Run SQL query" icon={Database} color="#06b6d4" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-cyan-500" />
      <Handle type="source" position={Position.Right} className="!bg-cyan-500" />
    </AdvancedNodeShell>
  );
}

export function ClipboardNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  const action = (d.action as string) || "read";
  return (
    <AdvancedNodeShell label={(d.label as string) || "Clipboard"} subtitle={action === "write" ? "Write to clipboard" : "Read clipboard"} icon={ClipboardCopy} color="#06b6d4" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-cyan-500" />
      <Handle type="source" position={Position.Right} className="!bg-cyan-500" />
    </AdvancedNodeShell>
  );
}

export function NotificationNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  return (
    <AdvancedNodeShell label={(d.label as string) || "Notification"} subtitle="Desktop notification" icon={Bell} color="#f97316" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-orange-500" />
      <Handle type="source" position={Position.Right} className="!bg-orange-500" />
    </AdvancedNodeShell>
  );
}

export function GitOperationNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  const action = (d.action as string) || "status";
  return (
    <AdvancedNodeShell label={(d.label as string) || "Git Operation"} subtitle={`git ${action}`} icon={GitCommitHorizontal} color="#06b6d4" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-cyan-500" />
      <Handle type="source" position={Position.Right} className="!bg-cyan-500" />
    </AdvancedNodeShell>
  );
}

export function ArchiveNode({ data, selected }: NodeProps) {
  const d = data as NodeConfig;
  const action = (d.action as string) || "create";
  return (
    <AdvancedNodeShell label={(d.label as string) || "Archive"} subtitle={action === "create" ? "Create archive" : "Extract archive"} icon={Archive} color="#06b6d4" selected={selected}>
      <Handle type="target" position={Position.Left} className="!bg-cyan-500" />
      <Handle type="source" position={Position.Right} className="!bg-cyan-500" />
    </AdvancedNodeShell>
  );
}
