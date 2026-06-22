import type { Node, Edge } from "@xyflow/react";
import type { WorkflowPolicy } from "@/types/execution";

export type NodeCategory = "trigger" | "agent" | "channel" | "logic" | "memory" | "tool" | "integration" | "voice" | "advanced-logic" | "advanced-data" | "advanced-tool";

export type TriggerNodeType =
  | "message-trigger"
  | "webhook-trigger"
  | "manual-trigger"
  | "cron-trigger"
  | "telegram-trigger"
  | "discord-trigger"
  | "github-trigger";

export type AgentNodeType = "claude-agent" | "parallel-agents" | "call-workflow" | "spawn-coding-agent";

export type ChannelNodeType =
  | "send-whatsapp"
  | "send-webchat"
  | "webhook-response"
  | "send-telegram"
  | "send-discord"
  | "send-email"
  | "send-sms"
  | "send-slack"
  | "send-bluebubbles"
  | "send-teams"
  | "github-comment";

export type LogicNodeType =
  | "if-else"
  | "switch"
  | "delay"
  | "set-variables"
  | "filter"
  | "loop"
  | "aggregate"
  | "merge"
  | "error-handler"
  | "wait-for-input"
  | "rate-limiter";

export type MemoryNodeType = "memory-recall" | "memory-store";

export type ToolNodeType =
  | "system-command"
  | "sticky-note"
  | "http-request"
  | "rss-read"
  | "run-code"
  | "read-file"
  | "write-file"
  | "board-task"
  | "document-tool"
  | "workflow-template"
  | "scheduler-job"
  | "json-transform"
  | "split-text"
  | "regex-extract"
  | "compare-text"
  | "database-query"
  | "clipboard"
  | "notification"
  | "git-operation"
  | "archive"
  | "date-time"
  | "channel-status"
  | "council";

export type IntegrationNodeType =
  | "integration-agent"
  | "google-sheets"
  | "notion"
  | "airtable";

export type VoiceNodeType = "voice-stt" | "voice-tts";

export type WorkflowNodeType =
  | TriggerNodeType
  | AgentNodeType
  | ChannelNodeType
  | LogicNodeType
  | MemoryNodeType
  | ToolNodeType
  | IntegrationNodeType
  | VoiceNodeType;

export interface NodeConfig {
  label: string;
  [key: string]: unknown;
}

export type WorkflowNode = Node<NodeConfig>;
export type WorkflowEdge = Edge;

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  organizationId?: string | null;
  goalId?: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  policy?: WorkflowPolicy | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NodePaletteItem {
  type: WorkflowNodeType;
  category: NodeCategory;
  label: string;
  description: string;
  color: string;
  icon: string;
  defaultConfig: Record<string, unknown>;
}

export const NODE_COLORS: Record<string, string> = {
  trigger: "#22c55e",
  agent: "#a855f7",
  channel: "#f97316",
  logic: "#6b7280",
  memory: "#f59e0b",
  tool: "#06b6d4",
  voice: "#14b8a6",
  email: "#ec4899",
  telegram: "#0088cc",
  discord: "#5865f2",
};
