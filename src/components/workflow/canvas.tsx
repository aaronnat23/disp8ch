"use client";

import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  ConnectionLineType,
  SelectionMode,
  type NodeTypes,
  type DefaultEdgeOptions,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@/components/workflow/canvas-theme.css";
import { useWorkflowStore } from "@/stores/workflow-store";
import { useExecutionStore } from "@/stores/execution-store";
import { TriggerNode } from "@/components/nodes/trigger-node";
import { AgentNode, ParallelAgentsNode } from "@/components/nodes/agent-node";
import { ChannelNode } from "@/components/nodes/channel-node";
import { LogicNode } from "@/components/nodes/logic-node";
import { MemoryNode } from "@/components/nodes/memory-node";
import { ToolNode } from "@/components/nodes/tool-node";
import { StickyNoteNode } from "@/components/nodes/sticky-note-node";
import { HttpNode } from "@/components/nodes/http-node";
import { SwitchNode, DelayNode, SetVariablesNode, FilterNode } from "@/components/nodes/data-node";
import { EmailNode } from "@/components/nodes/email-node";
import { ReadFileNode, WriteFileNode } from "@/components/nodes/file-node";
import { CodeNode, CallWorkflowNode, SpawnCodingAgentNode } from "@/components/nodes/code-node";
import { VoiceSttNode, VoiceTtsNode } from "@/components/nodes/voice-node";
import {
  LoopNode,
  AggregateNode,
  MergeNode,
  ErrorHandlerNode,
  WaitForInputNode,
  JsonTransformNode,
  SplitTextNode,
  RegexExtractNode,
  CompareTextNode,
  RateLimiterNode,
  DatabaseQueryNode,
  ClipboardNode,
  NotificationNode,
  GitOperationNode,
  ArchiveNode,
} from "@/components/nodes/advanced-node";
import { useCallback } from "react";
import { nanoid } from "nanoid";
import type { WorkflowNode } from "@/types/workflow";

const nodeTypes: NodeTypes = {
  // Triggers
  "message-trigger": TriggerNode,
  "webhook-trigger": TriggerNode,
  "manual-trigger": TriggerNode,
  "cron-trigger": TriggerNode,
  "telegram-trigger": TriggerNode,
  "discord-trigger": TriggerNode,
  "github-trigger": TriggerNode,
  // Agents
  "claude-agent": AgentNode,
  "parallel-agents": ParallelAgentsNode,
  "call-workflow": CallWorkflowNode,
  "spawn-coding-agent": SpawnCodingAgentNode,
  // Channels
  "send-whatsapp": ChannelNode,
  "send-webchat": ChannelNode,
  "send-telegram": ChannelNode,
  "send-discord": ChannelNode,
  "send-email": EmailNode,
  "send-sms": ChannelNode,
  "send-slack": ChannelNode,
  "send-bluebubbles": ChannelNode,
  "send-teams": ChannelNode,
  "github-comment": ToolNode,
  // Logic
  "if-else": LogicNode,
  "switch": SwitchNode,
  "delay": DelayNode,
  "set-variables": SetVariablesNode,
  "filter": FilterNode,
  // Memory
  "memory-recall": MemoryNode,
  "memory-store": MemoryNode,
  // Tools
  "sticky-note": StickyNoteNode,
  "system-command": ToolNode,
  "http-request": HttpNode,
  "rss-read": ToolNode,
  "webhook-response": ToolNode,
  "run-code": CodeNode,
  "read-file": ReadFileNode,
  "write-file": WriteFileNode,
  "board-task": ToolNode,
  "document-tool": ToolNode,
  "workflow-template": ToolNode,
  "scheduler-job": ToolNode,
  placeholder: ToolNode,
  "integration-agent": AgentNode,
  "google-sheets": ToolNode,
  "notion": ToolNode,
  "airtable": ToolNode,
  // Voice
  "voice-stt": VoiceSttNode,
  "voice-tts": VoiceTtsNode,
  // Advanced Logic
  "loop": LoopNode,
  "aggregate": AggregateNode,
  "merge": MergeNode,
  "error-handler": ErrorHandlerNode,
  "wait-for-input": WaitForInputNode,
  "rate-limiter": RateLimiterNode,
  // Advanced Data
  "json-transform": JsonTransformNode,
  "split-text": SplitTextNode,
  "regex-extract": RegexExtractNode,
  "compare-text": CompareTextNode,
  // Advanced Tools
  "database-query": DatabaseQueryNode,
  "clipboard": ClipboardNode,
  "notification": NotificationNode,
  "git-operation": GitOperationNode,
  "archive": ArchiveNode,
  "date-time": ToolNode,
  "channel-status": ToolNode,
  "council": ToolNode,
};

// Modern edge styling — smooth-stepped rounded connectors with an arrowhead
// and a subtle animated dash, replacing the default thin straight lines.
const DEFAULT_EDGE_OPTIONS: DefaultEdgeOptions = {
  type: "smoothstep",
  animated: true,
  style: { strokeWidth: 2, stroke: "var(--terminal-red, #e5484d)" },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 16,
    height: 16,
    color: "var(--terminal-red, #e5484d)",
  },
};

export function WorkflowCanvas() {
  const {
    nodes,
    edges,
    selectedNodeIds,
    onNodesChange,
    onEdgesChange,
    onConnect,
    setSelection,
    addNode,
  } = useWorkflowStore();

  const activeNodeId = useExecutionStore((s) => s.activeNodeId);

  const onNodeClick = useCallback(
    (event: React.MouseEvent, node: WorkflowNode) => {
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      if (!additive) {
        setSelection({ nodeIds: [node.id], edgeIds: [] });
        return;
      }
      const nextNodeIds = selectedNodeIds.includes(node.id)
        ? selectedNodeIds.filter((id) => id !== node.id)
        : [...selectedNodeIds, node.id];
      setSelection({ nodeIds: nextNodeIds, edgeIds: [] });
    },
    [selectedNodeIds, setSelection],
  );

  const onPaneClick = useCallback(() => {
    setSelection({ nodeIds: [], edgeIds: [] });
  }, [setSelection]);

  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      setSelection({
        nodeIds: params.nodes.map((n) => n.id),
        edgeIds: params.edges.map((e) => e.id),
      });
    },
    [setSelection],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/reactflow");
      const label = event.dataTransfer.getData("label");
      const defaultConfig = event.dataTransfer.getData("defaultConfig");

      if (!type) return;

      const bounds = (event.target as HTMLElement).closest(".react-flow")?.getBoundingClientRect();
      if (!bounds) return;

      const position = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };

      const newNode: WorkflowNode = {
        id: nanoid(8),
        type,
        position,
        data: {
          label: label || type,
          ...(defaultConfig ? JSON.parse(defaultConfig) : {}),
        },
      };

      addNode(newNode);
    },
    [addNode]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const nodeOverlays = useExecutionStore((s) => s.nodeOverlays);

  // Highlight active executing node + inject per-node run overlay into data.
  const styledNodes = nodes.map((n) => {
    const overlay = nodeOverlays[n.id];
    return {
      ...n,
      data: {
        ...n.data,
        _runStatus: overlay?.status ?? (n.id === activeNodeId ? "running" : null),
        _runDurationMs: overlay?.durationMs,
      },
      style: n.id === activeNodeId
        ? { boxShadow: "0 0 0 2px #22c55e, 0 0 24px rgba(34, 197, 94, 0.45)" }
        : undefined,
    };
  });

  return (
    <div className="h-full w-full disp8ch-flow">
      <ReactFlow
        nodes={styledNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onSelectionChange={onSelectionChange}
        onDrop={onDrop}
        onDragOver={onDragOver}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionLineStyle={{ strokeWidth: 2, stroke: "var(--terminal-red, #e5484d)" }}
        proOptions={{ hideAttribution: true }}
        fitView
        // Multi-select / lasso. Left-drag on empty pane = box select.
        // Shift / Meta = additive. Right-mouse + Space = pan.
        selectionMode={SelectionMode.Partial}
        selectionOnDrag
        panOnDrag={[1, 2]}
        multiSelectionKeyCode={["Shift", "Meta"]}
        deleteKeyCode={null}
        className="bg-background"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} className="disp8ch-flow-bg" />
        <Controls className="disp8ch-flow-controls" />
        <MiniMap
          className="!bg-card disp8ch-flow-minimap"
          maskColor="rgba(0,0,0,0.55)"
          nodeColor={(node) => {
            const type = node.type || "";
            if (type.includes("trigger")) return "#22c55e";
            if (type.includes("agent") || type.includes("claude") || type === "call-workflow") return "#a855f7";
            if (type === "send-telegram") return "#0088cc";
            if (type === "send-discord") return "#5865f2";
            if (type === "send-slack") return "#4a154b";
            if (type === "send-bluebubbles") return "#2563eb";
            if (type === "send-teams") return "#5b5fc7";
            if (type.includes("send") || type === "send-email") return "#f97316";
            if (type.includes("if") || type === "switch" || type === "delay" || type === "filter" || type === "set-variables" || type === "merge" || type === "rate-limiter") return "#6b7280";
            if (type === "loop" || type === "aggregate") return "#8b5cf6";
            if (type === "error-handler") return "#ef4444";
            if (type === "wait-for-input" || type === "notification") return "#f97316";
            if (type === "sticky-note") return "#facc15";
            if (type.includes("memory")) return "#f59e0b";
            if (type.includes("voice")) return "#14b8a6";
            if (type === "http-request") return "#0ea5e9";
            return "#06b6d4";
          }}
        />
      </ReactFlow>
    </div>
  );
}
