export type AgentRecord = {
  id: string;
  name: string;
  workspacePath: string;
  modelRef: string | null;
  disabledTools: string[];
  enabledExtensions: string[];
  enabledSkills: string[];
  spendCapUsd: number | null;
  spendWindowDays: number;
  budgetAction: "warn" | "block";
  budgetMonthlyCents: number | null;
  spentMonthlyCents: number;
  budgetResetAt: string | null;
  budgetSummary?: AgentBudgetSummary | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AgentBudgetSummary = {
  agentId: string;
  spendCapUsd: number | null;
  spendWindowDays: number;
  budgetAction: "warn" | "block";
  spentUsd: number;
  remainingUsd: number | null;
  usagePercent: number | null;
  recentCalls: number;
  lastSpendAt: string | null;
  overCap: boolean;
  warningLevel: "ok" | "near" | "over";
};

export type AgentFile = {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
  content?: string;
};

export type AgentTool = {
  name: string;
  label: string;
  description: string;
  source: "built-in" | "custom";
  enabled: boolean;
};

export type AgentSkillPack = {
  id: string;
  name: string;
  label: string;
  description: string;
  source: "core" | "optional" | "workspace" | "agent" | "extension" | "external";
  extensionId: string | null;
  enabled: boolean;
  globallyEnabled?: boolean;
};

export type AgentExtensionPack = {
  id: string;
  name: string;
  description: string;
  source: "bundled" | "external";
  skillCount: number;
  configurable: boolean;
  enabled: boolean;
  globallyEnabled?: boolean;
  config?: Record<string, unknown>;
};

export type IntegrationPreset = {
  id: string;
  name: string;
  description: string;
  extensions: string[];
  skills: string[];
  recommendedRoleTypes?: string[];
};

export type AgentChannelStatus = {
  id: string;
  label: string;
  connected: boolean | null;
  statusText: string;
  triggeredWorkflows: number;
  outboundWorkflows: number;
};

export type AgentChannelWorkflow = {
  id: string;
  name: string;
  isActive: boolean;
  triggers: string[];
  outputs: string[];
};

export type AgentCronSummary = {
  totalJobs: number;
  scheduledJobs: number;
  activeWorkflows: number;
};

export type AgentCronJob = {
  workflowId: string;
  workflowName: string;
  workflowActive: boolean;
  nodeId: string;
  label: string;
  expression: string;
  timezone: string;
  isScheduled: boolean;
};

export type AgentRoleType = "orchestrator" | "operations" | "specialist" | "worker" | "support";

export type AgentRole = {
  agentId: string;
  agentName: string;
  agentActive: boolean;
  isDefault: boolean;
  roleType: AgentRoleType;
  roleTitle: string;
  roleDescription: string;
  reportsTo: string | null;
  capabilities: string[];
};

export type AgentRoleDraft = {
  roleType: AgentRoleType;
  roleTitle: string;
  roleDescription: string;
  reportsTo: string | null;
  capabilitiesText: string;
};

export type AgentForm = {
  name: string;
  icon: string;
  workspacePath: string;
  modelRef: string;
  modelApiKey: string;
  modelBaseUrl: string;
  systemPrompt: string;
  temperature: string;
  maxTokens: string;
  spendCapUsd: string;
  spendWindowDays: string;
  budgetAction: "warn" | "block";
  budgetMonthlyCents: string;
  isDefault: boolean;
  isActive: boolean;
};

export type ModelOption = {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  isActive: boolean;
  priority: number;
};

export type AgentTab = "overview" | "files" | "tools" | "skills" | "channels" | "cron" | "roles";

export type AgentModelSource = "global_default" | "agent_override" | "custom" | "session_override";

export type AgentRuntimeProfile = {
  effectiveProvider: string;
  effectiveModel: string;
  modelSource: AgentModelSource;
  providerHealth: "ok" | "error" | "unknown";
  toolCallSupport: boolean;
  contextWindow: number | null;
  workspacePath: string | null;
  workspaceTrusted: boolean;
  enabledToolsCount: number;
  highRiskToolsEnabled: boolean;
  skillsReady: boolean;
  channelsConfigured: number;
  hasCronWakeup: boolean;
  budgetCap: number | null;
  budgetSpent: number | null;
  budgetAction: "warn" | "pause" | "block" | null;
  startupFiles: Record<string, boolean>;
};

export const EMPTY_FORM: AgentForm = {
  name: "",
  icon: "Bot",
  workspacePath: "",
  modelRef: "",
  modelApiKey: "",
  modelBaseUrl: "",
  systemPrompt: "",
  temperature: "",
  maxTokens: "",
  spendCapUsd: "",
  spendWindowDays: "30",
  budgetAction: "warn",
  budgetMonthlyCents: "",
  isDefault: false,
  isActive: true,
};

export const SKILL_FILE_GUIDE = [
  {
    name: "AGENTS.md",
    title: "Agent Persona",
    description: "Primary behavior and style instructions for the selected agent.",
  },
  {
    name: "TOOLS.md",
    title: "Tool Usage",
    description: "Guidance for when and how tool calls should be made.",
  },
  {
    name: "MEMORY.md",
    title: "Memory Rules",
    description: "What to store, recall, and prioritize across conversations.",
  },
  {
    name: "IDENTITY.md",
    title: "Identity",
    description: "Name, role, tone, and boundaries for this agent profile.",
  },
  {
    name: "SOUL.md",
    title: "Values",
    description: "Long-term principles and decision preferences.",
  },
  {
    name: "USER.md",
    title: "User Context",
    description: "Operator preferences and recurring constraints.",
  },
  {
    name: "BOOT.md",
    title: "Startup",
    description: "Startup-time instructions injected before each run.",
  },
] as const;

export const ROLE_TYPE_OPTIONS: Array<{ value: AgentRoleType; label: string }> = [
  { value: "orchestrator", label: "Orchestrator" },
  { value: "operations", label: "Operations Lead" },
  { value: "specialist", label: "Specialist" },
  { value: "worker", label: "Worker" },
  { value: "support", label: "Support" },
];

export const AGENTS_UI_STATE_KEY = "disp8ch:agents-ui-state";

export function formatUsd(value: number | null | undefined): string {
  if (value === null || typeof value === "undefined") return "Unlimited";
  return `$${value.toFixed(value >= 100 ? 0 : value >= 10 ? 2 : 4)}`;
}
