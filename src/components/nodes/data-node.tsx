"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { GitFork, Timer, Variable, Filter } from "lucide-react";
import type { NodeConfig } from "@/types/workflow";

export function SwitchNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const cases = (nodeData.cases as string[]) || [];

  return (
    <div
      className={`min-w-[220px] rounded-xl border bg-card shadow-sm ${
        selected ? "border-gray-400 shadow-lg shadow-gray-500/20" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-xl bg-gray-500/10 px-3 py-2">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-gray-500">
          <GitFork className="h-3.5 w-3.5 text-white" />
        </div>
        <span className="text-sm font-medium">{(nodeData.label as string) || "Switch"}</span>
      </div>
      <div className="px-3 py-2">
        <div className="text-xs text-muted-foreground">
          {cases.length} case{cases.length !== 1 ? "s" : ""} + default
        </div>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-gray-500" />
      {cases.map((c, i) => (
        <Handle
          key={`case_${i}`}
          type="source"
          position={Position.Right}
          id={`case_${i}`}
          style={{ top: `${30 + i * 20}%` }}
          className="!bg-gray-400"
        />
      ))}
      <Handle
        type="source"
        position={Position.Right}
        id="default"
        style={{ top: `${30 + cases.length * 20}%` }}
        className="!bg-gray-600"
      />
    </div>
  );
}

export function DelayNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const duration = (nodeData.duration as number) || 1000;

  return (
    <div
      className={`min-w-[180px] rounded-xl border bg-card shadow-sm ${
        selected ? "border-gray-400 shadow-lg shadow-gray-500/20" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-xl bg-gray-500/10 px-3 py-2">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-gray-500">
          <Timer className="h-3.5 w-3.5 text-white" />
        </div>
        <span className="text-sm font-medium">{(nodeData.label as string) || "Delay"}</span>
      </div>
      <div className="px-3 py-2">
        <div className="text-xs text-muted-foreground">Wait {duration}ms</div>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-gray-500" />
      <Handle type="source" position={Position.Right} className="!bg-gray-500" />
    </div>
  );
}

export function SetVariablesNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const assignments = (nodeData.assignments as Array<{ key: string; value: string }>) || [];

  return (
    <div
      className={`min-w-[200px] rounded-xl border bg-card shadow-sm ${
        selected ? "border-gray-400 shadow-lg shadow-gray-500/20" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-xl bg-gray-500/10 px-3 py-2">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-gray-500">
          <Variable className="h-3.5 w-3.5 text-white" />
        </div>
        <span className="text-sm font-medium">{(nodeData.label as string) || "Set Variables"}</span>
      </div>
      <div className="px-3 py-2">
        <div className="text-xs text-muted-foreground">
          {assignments.length} variable{assignments.length !== 1 ? "s" : ""}
        </div>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-gray-500" />
      <Handle type="source" position={Position.Right} className="!bg-gray-500" />
    </div>
  );
}

export function FilterNode({ data, selected }: NodeProps) {
  const nodeData = data as NodeConfig;
  const condition = (nodeData.condition as string) || "";

  return (
    <div
      className={`min-w-[200px] rounded-xl border bg-card shadow-sm ${
        selected ? "border-gray-400 shadow-lg shadow-gray-500/20" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-xl bg-gray-500/10 px-3 py-2">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-gray-500">
          <Filter className="h-3.5 w-3.5 text-white" />
        </div>
        <span className="text-sm font-medium">{(nodeData.label as string) || "Filter"}</span>
      </div>
      <div className="px-3 py-2">
        <div className="text-xs text-muted-foreground font-mono truncate">
          {condition || "(no condition)"}
        </div>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-gray-500" />
      <Handle type="source" position={Position.Right} className="!bg-gray-500" />
    </div>
  );
}
