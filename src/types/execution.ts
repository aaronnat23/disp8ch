export interface NodeResult {
  nodeId: string;
  output: Record<string, unknown>;
  duration: number;
  error?: string;
  attempts?: number;
  /** True when the node emitted pinned data instead of executing. */
  pinned?: boolean;
}

export interface BudgetPolicy {
  maxRunsPerDay?: number | null;
  maxCostPerDayUsd?: number | null;
  autoDisable?: boolean;
}

export interface EscalationPolicy {
  onFailure?: boolean;
  onBudgetBlocked?: boolean;
  maxNotificationsPerDay?: number | null;
  quietHours?: {
    start: string;
    end: string;
    timezone?: string | null;
  } | null;
}

export interface WorkflowPolicy {
  budget?: BudgetPolicy | null;
  escalation?: EscalationPolicy | null;
}

export type PartialExecutionMode = "to-node" | "from-node" | "node";

export interface PartialExecutionInfo {
  mode: PartialExecutionMode;
  startNodeId?: string | null;
  targetNodeId?: string | null;
  /** Nodes intentionally not run for this partial run, with a reason. */
  skippedNodes: Array<{ nodeId: string; label: string; reason: string }>;
  /** Where the entry node's input came from. */
  inputSource: "pinned" | "latest" | "trigger";
}

export interface ExecutionRecord {
  id: string;
  workflowId: string;
  status: "running" | "completed" | "failed" | "cancelled" | "queued";
  triggerType: "message" | "webhook" | "manual" | "cron";
  triggerData: Record<string, unknown> | null;
  provenance?: Record<string, unknown> | null;
  nodeResults: Record<string, NodeResult>;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  /** Present for partial runs (test-node / run-to-node / run-from-node). */
  partial?: PartialExecutionInfo | null;
}

export interface NodeInput {
  data: Record<string, unknown>;
  config: Record<string, unknown>;
  node?: { id: string; type?: string };
}

export interface NodeOutput {
  data: Record<string, unknown>;
}

export interface ExecutionContext {
  workflowId: string;
  executionId: string;
  get(path: string): unknown;
  set(namespace: string, data: Record<string, unknown>): void;
  emit(event: string, data: unknown): void;
  getModel(): ModelConfig;
  abortSignal: AbortSignal;
}

export interface ModelConfig {
  provider: import("@/types/model").ModelProvider;
  modelId: string;
  apiKey: string;
  maxTokens?: number;
  baseUrl?: string;
  fastMode?: boolean;
  /** Per-agent temperature override (0–1) */
  temperature?: number;
  /** Per-agent default system prompt (used when node config leaves it blank) */
  agentSystemPrompt?: string;
}

export type LintSeverity = "error" | "warning" | "info";

export interface LintIssue {
  nodeId: string;
  message: string;
  type: string;
  severity?: LintSeverity;
}

export interface LintResult {
  errors: LintIssue[];
  warnings: LintIssue[];
  infos?: LintIssue[];
}

export type RuntimeNodeState = {
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  output?: Record<string, unknown>;
  error?: string;
};

export interface ExecutionLogEntry {
  timestamp: string;
  nodeId: string;
  nodeName: string;
  message: string;
  type: "info" | "error" | "success" | "streaming";
}
