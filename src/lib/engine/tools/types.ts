import type { ApprovalPolicy } from "@/types/execution";
import type { ToolsetId, ToolsetRiskTier } from "@/lib/engine/toolsets";

export interface ToolMetadata {
  readOnly?: boolean;
  destructive?: boolean;
  concurrencySafe?: boolean;
  source?: "builtin" | "custom" | "system";
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      items?: { type: string };
    }>;
    required: string[];
  };
  metadata?: ToolMetadata;
}

export type ApprovalMode = "off" | "model" | "human";
export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss" | "always";

export interface ToolExecutionPolicy {
  approvalMode?: ApprovalMode;
  execSecurity?: ExecSecurity;
  execAsk?: ExecAsk;
  execAllowlist?: string[];
  execSandbox?: "off" | "docker";
}

export interface ToolRuntimeContext {
  toolRuntimeSessionId?: string;
  bypassExecPolicy?: boolean;
  agentId?: string;
  channelSessionId?: string;
  toolMode?: "default" | "restricted" | "full";
  readOnly?: boolean;
  workspacePath?: string | null;
  evidenceMode?: "current_state";
  modelProvider?: string;
  modelId?: string;
  modelApiKey?: string;
  modelBaseUrl?: string;
  /** Authoritative workflow memory scope. Derived from the runtime, never tool args. */
  workflowId?: string;
  executionId?: string;
  nodeId?: string;
  memoryAccess?: "none" | "workflow" | "agent";
  /** Workflow-level effect policy inherited from the executor. */
  workflowApprovalPolicy?: ApprovalPolicy | null;
  workflowAttended?: boolean;
}

export interface RuntimeToolAvailabilityEntry {
  name: string;
  label: string;
  description: string;
  source: "builtin" | "custom" | "system";
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
  active: boolean;
  availabilityReason: string;
  toolsets: ToolsetId[];
  riskTier: ToolsetRiskTier;
}

export interface RuntimeToolAvailability {
  activeTools: RuntimeToolAvailabilityEntry[];
  disabledTools: RuntimeToolAvailabilityEntry[];
  unavailableTools: RuntimeToolAvailabilityEntry[];
  toolsets: Array<{
    id: ToolsetId;
    label: string;
    description: string;
    riskTier: ToolsetRiskTier;
    activeToolCount: number;
  }>;
  approvalMode: ApprovalMode;
  source: "runtime";
}
