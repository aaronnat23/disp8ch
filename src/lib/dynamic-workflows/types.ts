// -- Status enums ---------------------------------------------------------------

export type DynamicWorkflowRunStatus =
  | "draft"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "needs_human";

export type DynamicWorkflowPhaseStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "skipped";

export type DynamicWorkflowWorkerStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type DynamicWorkflowAgentKind = "internal" | "claude" | "codex" | "gemini";

export type DynamicWorkflowSourceType =
  | "webchat"
  | "goal"
  | "workflow"
  | "schedule"
  | "board"
  | "manual"
  | "harness_template";

export type DynamicWorkflowPhaseStrategy =
  | "single"
  | "fanout"
  | "review"
  | "synthesize"
  | "verify";

export type PhaseStrategy = DynamicWorkflowPhaseStrategy;

// -- Plan types ----------------------------------------------------------------

export interface DynamicWorkflowWorkerSpec {
  id: string;
  role: string;
  prompt: string;
  agentId?: string;
  agentKind?: DynamicWorkflowAgentKind;
  modelRef?: string;
  toolsets?: string[];
  requiresScreenshot?: boolean;
  expectedOutputSchema?: Record<string, unknown>;
}

export interface SupervisedRoleBinding {
  agentId?: string;
  agentKind?: DynamicWorkflowAgentKind;
  modelRef?: string;
  toolsets?: string[];
}

export interface SupervisionConfig {
  version: 1;
  mode: "supervised";
  planner: SupervisedRoleBinding;
  implementer: SupervisedRoleBinding;
  reviewer: SupervisedRoleBinding;
  maxRepairPasses: number;
  requireHumanApprovalBeforePublish: boolean;
}

export type AcceptanceMethod =
  | "review"
  | "command"
  | "browser"
  | "artifact"
  | "citation"
  | "human";

export type AcceptanceStatus =
  | "pending"
  | "passed"
  | "failed"
  | "warning"
  | "unverified";

export interface AcceptanceCriterion {
  id: string;
  statement: string;
  required: boolean;
  methods: AcceptanceMethod[];
  status: AcceptanceStatus;
}

export interface DynamicWorkflowPhase {
  id: string;
  name: string;
  instructions: string;
  strategy: DynamicWorkflowPhaseStrategy;
  workers: DynamicWorkflowWorkerSpec[];
  dependsOn?: string[];
}

export type DynamicWorkflowPlanPhase = DynamicWorkflowPhase;

export interface DynamicWorkflowPlan {
  objective: string;
  acceptanceCriteria: string[];
  acceptanceContract?: AcceptanceCriterion[];
  supervision?: SupervisionConfig;
  workspaceRoot?: string;
  sourceRefs?: Array<{ type: string; id?: string; label?: string; url?: string }>;
  planning?: {
    summary: string;
    implementationSteps: string[];
    risks: string[];
    generatedAt: string;
    agentId: string;
    provider: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  phases: DynamicWorkflowPhase[];
  verification?: {
    commands?: string[];
    browserChecks?: Array<{ url: string; instruction: string; screenshotName?: string }>;
    requireScreenshots?: boolean;
    requireFinalSynthesis?: boolean;
  };
  limits: {
    maxConcurrency: number;
    maxWorkers: number;
    maxRuntimeSeconds: number;
    budgetLimitUsd?: number;
  };
}

// -- Event type union ----------------------------------------------------------

export type DynamicWorkflowEventType =
  | "run.created"
  | "run.started"
  | "run.paused"
  | "run.resumed"
  | "run.cancelled"
  | "run.completed"
  | "run.failed"
  | "phase.started"
  | "phase.completed"
  | "phase.failed"
  | "phase.skipped"
  | "worker.queued"
  | "worker.started"
  | "worker.tool"
  | "worker.completed"
  | "worker.failed"
  | "worker.cancelled"
  | "worker.timed_out"
  | "mcp.approval.requested"
  | "mcp.approval.granted"
  | "mcp.approval.denied"
  | "approval.requested"
  | "approval.granted"
  | "approval.denied"
  | "supervision.plan.completed"
  | "supervision.review.completed"
  | "supervision.repair.started"
  | "supervision.repair.completed"
  | "criterion.evaluated"
  | "evidence.recorded"
  | "run.needs_human"
  | "run.verification_started"
  | "run.verification_completed";

// -- Run record ----------------------------------------------------------------

export interface DynamicWorkflowRunRecord {
  id: string;
  name: string;
  description: string | null;
  status: DynamicWorkflowRunStatus;
  sourceType: DynamicWorkflowSourceType | null;
  sourceRef: string | null;
  organizationId: string | null;
  goalId: string | null;
  boardTaskId: string | null;
  workTrailId?: string | null;
  managerAgentId: string | null;
  modelRef: string | null;
  maxConcurrency: number;
  maxWorkers: number;
  approvalPolicy: string;
  budgetLimitUsd: number | null;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
  planJson: string;
  savedCommandName: string | null;
  createdBySessionId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

// -- Phase record --------------------------------------------------------------

export interface DynamicWorkflowPhaseRecord {
  id: string;
  runId: string;
  phaseIndex: number;
  name: string;
  status: DynamicWorkflowPhaseStatus;
  instructions: string | null;
  dependsOnPhaseIds: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// -- Worker record -------------------------------------------------------------

export interface DynamicWorkflowWorkerRecord {
  id: string;
  runId: string;
  phaseId: string;
  workerIndex: number;
  role: string;
  status: DynamicWorkflowWorkerStatus;
  agentKind: DynamicWorkflowAgentKind;
  agentId: string | null;
  modelRef: string | null;
  prompt: string;
  toolPolicyJson: string | null;
  resultSummary: string | null;
  resultJson: string | null;
  error: string | null;
  cachedResultKey: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// -- Event record --------------------------------------------------------------

export interface DynamicWorkflowEventRecord {
  id: string;
  runId: string;
  phaseId: string | null;
  workerId: string | null;
  eventType: string;
  title: string | null;
  detail: string | null;
  payloadJson: string | null;
  createdAt: string;
}

// -- Worker result -------------------------------------------------------------

export interface DynamicWorkflowWorkerResult {
  status: DynamicWorkflowWorkerStatus;
  summary: string;
  findings?: Array<{ claim: string; evidence?: string; confidence?: number }>;
  criterionEvaluations?: Array<{
    criterionId: string;
    status: "passed" | "failed" | "warning" | "unverified";
    summary: string;
    evidence?: string;
  }>;
  changedFiles?: string[];
  artifacts?: Array<{ type: string; path?: string; url?: string; label?: string }>;
  screenshots?: string[];
  nextActions?: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  };
  resolvedProvider?: string;
  resolvedModelId?: string;
  raw?: unknown;
}

export interface DynamicWorkflowCriterionRecord extends AcceptanceCriterion {
  runId: string;
  evaluatorWorkerId: string | null;
  evaluatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DynamicWorkflowEvidenceRecord {
  id: string;
  runId: string;
  criterionId: string | null;
  evidenceType: string;
  sourceType: string;
  sourceId: string | null;
  summary: string;
  payloadJson: string | null;
  contentSha256: string;
  createdAt: string;
}

export interface DynamicWorkflowRepairAttemptRecord {
  id: string;
  runId: string;
  attemptNumber: number;
  failedCriterionIds: string[];
  implementerWorkerId: string | null;
  reviewerWorkerId: string | null;
  status: "running" | "completed" | "failed";
  createdAt: string;
  completedAt: string | null;
}

// -- Command record ------------------------------------------------------------

export interface DynamicWorkflowCommandRecord {
  id: string;
  name: string;
  description: string | null;
  planTemplateJson: string;
  defaultModelRef: string | null;
  defaultMaxConcurrency: number;
  createdFromRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

// -- Populated run -------------------------------------------------------------

export type PopulatedDynamicWorkflowRun = DynamicWorkflowRunRecord & {
  phases: DynamicWorkflowPhaseRecord[];
  workers: DynamicWorkflowWorkerRecord[];
};

// -- Harness template ----------------------------------------------------------

export type HarnessTemplateInput = {
  id: string;
  label: string;
  required: boolean;
  type: "string" | "number" | "boolean";
  default?: string | number | boolean;
  description?: string;
};

export interface DynamicWorkflowHarnessTemplate {
  id: string;
  name: string;
  description: string;
  category?: string;
  planTemplate?: DynamicWorkflowPlan;
  defaultModelRef?: string;
  defaultMaxConcurrency: number;
  requiresGithub?: boolean;
  requiresSchedule?: boolean;
  requiresScreenshots?: boolean;
  inputs: HarnessTemplateInput[];
  populate: (values: Record<string, unknown>) => DynamicWorkflowPlan;
}

// -- Planner output ------------------------------------------------------------

export interface PlanResult {
  plan: DynamicWorkflowPlan;
  outlineGenerated: boolean;
  warnings: string[];
  needsClarification?: boolean;
  clarificationQuestion?: string;
  clarificationChoices?: string[];
  costEstimateUsd?: number;
  estimatedDurationSeconds?: number;
  riskLevel?: "low" | "medium" | "high";
  summary?: string;
}

// -- Planning context ----------------------------------------------------------

export interface DynamicWorkflowPlanningContext {
  sessionId?: string;
  organizationId?: string;
  goalId?: string;
  boardTaskId?: string;
  workflowId?: string;
  availableWorkerTypes?: DynamicWorkflowAgentKind[];
  configuredModels?: Array<{ id: string; provider: string; modelId: string; name: string }>;
  configuredMcpServers?: Array<{ name: string; toolsCount: number }>;
  appCapabilities?: string[];
  availableTools?: string[];
  providerModel?: string;
  maxConcurrency?: number;
  maxWorkers?: number;
  maxRuntimeSeconds?: number;
  budgetLimitUsd?: number;
}

// -- Event callback ------------------------------------------------------------

export type DynamicWorkflowEventCallback = (event: DynamicWorkflowEventRecord) => void;
