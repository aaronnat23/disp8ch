/**
 * App-action planner schema and Zod validation.
 *
 * This module defines the allowed action kinds, plan structure, and
 * a validation function that rejects unknown/destructive actions.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AppActionKind =
  | "create_agent"
  | "create_agents"
  | "create_organization"
  | "update_organization"
  | "switch_organization"
  | "apply_org_template"
  | "assign_agents_to_organization"
  | "assign_skill_to_agent"
  | "attach_extension_to_agent"
  | "create_board_task"
  | "link_board_task_to_agent"
  | "link_board_task_to_organization"
  | "link_board_task_to_goal"
  | "create_workflow_from_template"
  | "toggle_workflow_active"
  | "update_workflow_node"
  | "set_workflow_node_model"
  | "create_goal"
  | "update_goal"
  | "update_agent_role"
  | "update_agent_model_profile"
  | "set_hierarchy_budget_policy"
  | "set_hierarchy_approval_policy"
  | "assign_goal_to_org_agents"
  | "link_goal_sources"
  | "export_org_package"
  | "run_council"
  | "rerun_council_session"
  | "delete_council_session"
  | "create_council_verdict_task"
  | "run_organization_execution"
  | "schedule_workflow"
  | "connect_channel"
  | "recommend_templates"
  | "summarize_hierarchy_activity"
  | "summarize_state"
  | "ask_clarifying_question"
  | "plan_dynamic_workflow"
  | "create_dynamic_workflow_run"
  | "start_dynamic_workflow_run"
  | "pause_dynamic_workflow_run"
  | "resume_dynamic_workflow_run"
  | "cancel_dynamic_workflow_run"
  | "restart_dynamic_workflow_worker"
  | "save_dynamic_workflow_command"
  | "run_harness_template";

export type AppActionStep = {
  id: string;
  action: AppActionKind;
  label: string;
  params: Record<string, unknown>;
  dependsOn?: string[];
};

export type AppActionPlan = {
  version: 1;
  confidence: number;
  userIntent: string;
  requiresConfirmation: boolean;
  clarificationQuestion?: string;
  clarificationChoices?: string[];
  assumptions: string[];
  steps: AppActionStep[];
};

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ALLOWED_ACTION_KINDS: [AppActionKind, ...AppActionKind[]] = [
  "create_agent",
  "create_agents",
  "create_organization",
  "update_organization",
  "switch_organization",
  "apply_org_template",
  "assign_agents_to_organization",
  "assign_skill_to_agent",
  "attach_extension_to_agent",
  "create_board_task",
  "link_board_task_to_agent",
  "link_board_task_to_organization",
  "link_board_task_to_goal",
  "create_workflow_from_template",
  "toggle_workflow_active",
  "update_workflow_node",
  "set_workflow_node_model",
  "create_goal",
  "update_goal",
  "update_agent_role",
  "update_agent_model_profile",
  "set_hierarchy_budget_policy",
  "set_hierarchy_approval_policy",
  "assign_goal_to_org_agents",
  "link_goal_sources",
  "export_org_package",
  "run_council",
  "rerun_council_session",
  "delete_council_session",
  "create_council_verdict_task",
  "run_organization_execution",
  "schedule_workflow",
  "connect_channel",
  "recommend_templates",
  "summarize_hierarchy_activity",
  "summarize_state",
  "ask_clarifying_question",
  "plan_dynamic_workflow",
  "create_dynamic_workflow_run",
  "start_dynamic_workflow_run",
  "pause_dynamic_workflow_run",
  "resume_dynamic_workflow_run",
  "cancel_dynamic_workflow_run",
  "restart_dynamic_workflow_worker",
  "save_dynamic_workflow_command",
  "run_harness_template",
];

const AppActionStepBaseSchema = z.object({
  id: z.string().min(1),
  action: z.enum(ALLOWED_ACTION_KINDS),
  label: z.string().min(1),
  params: z.record(z.unknown()),
  dependsOn: z.array(z.string()).optional(),
}).strict();

const paramSchemas: Record<AppActionKind, z.ZodTypeAny> = {
  create_agent: z.object({
    name: z.string().min(1).nullable().optional(),
    purpose: z.string().nullable().optional(),
    modelRef: z.string().nullable().optional(),
  }).strict(),
  create_agents: z.object({
    count: z.number().int().min(1).max(10).optional(),
    names: z.array(z.string().min(1)).max(10).optional(),
    purpose: z.string().nullable().optional(),
  }).strict(),
  create_organization: z.object({
    name: z.string().min(1).nullable().optional(),
    description: z.string().optional(),
    memberStepId: z.string().optional(),
    memberIds: z.array(z.string()).optional(),
    activate: z.boolean().optional(),
  }).strict(),
  update_organization: z.object({
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    organizationStepId: z.string().optional(),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    mission: z.string().nullable().optional(),
    activate: z.boolean().optional(),
  }).strict(),
  switch_organization: z.object({
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    organizationStepId: z.string().optional(),
  }).strict(),
  apply_org_template: z.object({
    templateId: z.string().optional(),
    templateName: z.string().optional(),
    organizationName: z.string().optional(),
    activate: z.boolean().optional(),
  }).strict(),
  assign_agents_to_organization: z.object({
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    organizationStepId: z.string().optional(),
    agentIds: z.array(z.string()).optional(),
    agentNames: z.array(z.string()).optional(),
    agentStepId: z.string().optional(),
  }).strict(),
  assign_skill_to_agent: z.object({
    agentId: z.string().optional(),
    agentStepId: z.string().optional(),
    skillId: z.string().min(1),
  }).strict(),
  attach_extension_to_agent: z.object({
    agentId: z.string().optional(),
    agentStepId: z.string().optional(),
    extensionId: z.string().min(1),
  }).strict(),
  create_board_task: z.object({
    boardId: z.string().optional(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    status: z.enum(["inbox", "in_progress", "review", "done", "blocked"]).optional(),
    organizationId: z.string().optional(),
    organizationStepId: z.string().optional(),
    agentId: z.string().optional(),
    agentStepId: z.string().optional(),
  }).strict(),
  link_board_task_to_agent: z.object({
    taskId: z.string().optional(),
    taskStepId: z.string().optional(),
    agentId: z.string().optional(),
    agentStepId: z.string().optional(),
  }).strict(),
  link_board_task_to_organization: z.object({
    taskId: z.string().optional(),
    taskStepId: z.string().optional(),
    organizationId: z.string().optional(),
    organizationStepId: z.string().optional(),
  }).strict(),
  link_board_task_to_goal: z.object({
    taskId: z.string().optional(),
    taskStepId: z.string().optional(),
    goalId: z.string().optional(),
    goalStepId: z.string().optional(),
  }).strict(),
  create_workflow_from_template: z.object({
    template: z.string().optional(),
    templateKey: z.string().optional(),
    name: z.string().optional(),
  }).strict(),
  toggle_workflow_active: z.object({
    workflowId: z.string().optional(),
    workflowName: z.string().optional(),
    workflowStepId: z.string().optional(),
    active: z.boolean(),
  }).strict(),
  create_goal: z.object({
    title: z.string().optional(),
    organizationId: z.string().optional(),
    organizationStepId: z.string().optional(),
  }).strict(),
  update_goal: z.object({
    goalId: z.string().optional(),
    goalName: z.string().optional(),
    goalStepId: z.string().optional(),
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    organizationStepId: z.string().optional(),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: z.enum(["planned", "active", "blocked", "done"]).optional(),
    level: z.enum(["vision", "mission", "objective", "key_result"]).nullable().optional(),
    parentGoalId: z.string().nullable().optional(),
    parentGoalName: z.string().nullable().optional(),
  }).strict(),
  update_agent_role: z.object({
    agentId: z.string().optional(),
    agentName: z.string().optional(),
    agentStepId: z.string().optional(),
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    roleType: z.enum(["orchestrator", "operations", "specialist", "worker", "support"]).optional(),
    roleTitle: z.string().optional(),
    roleDescription: z.string().optional(),
    reportsToAgentId: z.string().nullable().optional(),
    reportsToAgentName: z.string().nullable().optional(),
    capabilities: z.array(z.string()).optional(),
    voteWeight: z.number().optional(),
    active: z.boolean().optional(),
  }).strict(),
  update_agent_model_profile: z.object({
    agentId: z.string().optional(),
    agentName: z.string().optional(),
    agentStepId: z.string().optional(),
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    modelRef: z.string().nullable().optional(),
    systemPrompt: z.string().nullable().optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    maxTokens: z.number().int().min(1).max(200000).nullable().optional(),
    enabledSkills: z.array(z.string()).optional(),
    enabledToolsets: z.array(z.string()).optional(),
    enabledExtensions: z.array(z.string()).optional(),
    disabledTools: z.array(z.string()).optional(),
    spendCapUsd: z.number().min(0).nullable().optional(),
    spendWindowDays: z.number().int().min(1).max(365).optional(),
    budgetAction: z.enum(["warn", "block"]).optional(),
  }).strict(),
  update_workflow_node: z.object({
    workflowId: z.string().optional(),
    workflowName: z.string().optional(),
    workflowStepId: z.string().optional(),
    nodeId: z.string().optional(),
    nodeLabel: z.string().optional(),
    // Field -> new value. Validated per node-type contract at execution time.
    updates: z.record(z.string(), z.unknown()),
  }).strict(),
  set_workflow_node_model: z.object({
    workflowId: z.string().optional(),
    workflowName: z.string().optional(),
    workflowStepId: z.string().optional(),
    nodeId: z.string().optional(),
    nodeLabel: z.string().optional(),
    modelRef: z.string(),
  }).strict(),
  set_hierarchy_budget_policy: z.object({
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    goalId: z.string().optional(),
    goalName: z.string().optional(),
    agentId: z.string().optional(),
    agentName: z.string().optional(),
    scope: z.enum(["organization", "goal", "agent"]),
    softLimitUsd: z.number().min(0).nullable().optional(),
    hardLimitUsd: z.number().min(0).nullable().optional(),
    requireApprovalAboveUsd: z.number().min(0).nullable().optional(),
    period: z.enum(["daily", "weekly", "monthly", "total"]).optional(),
    isActive: z.boolean().optional(),
  }).strict(),
  set_hierarchy_approval_policy: z.object({
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    scope: z.enum(["organization", "goal", "agent"]),
    actionPattern: z.string().min(1),
    approverAgentId: z.string().nullable().optional(),
    approverAgentName: z.string().nullable().optional(),
    requireHuman: z.boolean().optional(),
    minRisk: z.enum(["low", "medium", "high"]).optional(),
    isActive: z.boolean().optional(),
  }).strict(),
  assign_goal_to_org_agents: z.object({
    goalId: z.string().optional(),
    goalName: z.string().optional(),
    goalStepId: z.string().optional(),
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    organizationStepId: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
  }).strict(),
  link_goal_sources: z.object({
    goalId: z.string().optional(),
    goalName: z.string().optional(),
    goalStepId: z.string().optional(),
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    documentIds: z.array(z.string()).optional(),
    documentNames: z.array(z.string()).optional(),
    mode: z.enum(["append", "replace"]).optional(),
  }).strict(),
  export_org_package: z.object({
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    organizationStepId: z.string().optional(),
  }).strict(),
  run_council: z.object({
    topic: z.string().optional(),
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    organizationStepId: z.string().optional(),
    agentIds: z.array(z.string()).optional(),
    agentNames: z.array(z.string()).optional(),
    agentStepId: z.string().optional(),
    goalId: z.string().optional(),
    goalName: z.string().optional(),
    goalStepId: z.string().optional(),
    documentIds: z.array(z.string()).optional(),
    documentNames: z.array(z.string()).optional(),
    useGoalDocuments: z.boolean().optional(),
    options: z.array(z.string()).optional(),
    mode: z.enum(["poll", "debate"]).optional(),
    rounds: z.number().int().min(2).max(5).optional(),
    decisionMode: z.enum(["majority", "consensus", "weighted", "ranked"]).optional(),
    synthesizerAgentId: z.string().optional(),
    synthesizerAgentName: z.string().optional(),
    useModeratorSynthesis: z.boolean().optional(),
    discoverOptions: z.boolean().optional(),
    costCapUsd: z.number().positive().max(100).optional(),
    createBoardTaskFromVerdict: z.boolean().optional(),
    createFollowUpTasksFromConcerns: z.boolean().optional(),
    boardId: z.string().optional(),
  }).strict(),
  rerun_council_session: z.object({
    sessionId: z.string().optional(),
    topic: z.string().optional(),
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
  }).strict(),
  delete_council_session: z.object({
    sessionId: z.string().optional(),
    topic: z.string().optional(),
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
  }).strict(),
  create_council_verdict_task: z.object({
    sessionId: z.string().optional(),
    topic: z.string().optional(),
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    boardId: z.string().optional(),
  }).strict(),
  run_organization_execution: z.object({
    organizationId: z.string().optional(),
    organizationStepId: z.string().optional(),
    prompt: z.string().optional(),
  }).strict(),
  schedule_workflow: z.object({
    workflowId: z.string().optional(),
    workflowStepId: z.string().optional(),
    schedule: z.string().optional(),
  }).strict(),
  connect_channel: z.object({
    channel: z.string().min(1),
  }).strict(),
  recommend_templates: z.object({
    topic: z.string().optional(),
  }).strict(),
  summarize_hierarchy_activity: z.object({
    organizationId: z.string().optional(),
    organizationName: z.string().optional(),
    goalId: z.string().optional(),
    goalName: z.string().optional(),
    agentId: z.string().optional(),
    agentName: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }).strict(),
  summarize_state: z.object({
    domain: z.string().optional(),
  }).strict(),
  ask_clarifying_question: z.object({}).strict(),
  plan_dynamic_workflow: z.object({
    prompt: z.string().min(1).optional(),
  }).strict(),
  create_dynamic_workflow_run: z.object({
    planJson: z.string().optional(),
    approve: z.boolean().optional(),
  }).strict(),
  start_dynamic_workflow_run: z.object({
    runId: z.string().optional(),
  }).strict(),
  pause_dynamic_workflow_run: z.object({
    runId: z.string().optional(),
  }).strict(),
  resume_dynamic_workflow_run: z.object({
    runId: z.string().optional(),
  }).strict(),
  cancel_dynamic_workflow_run: z.object({
    runId: z.string().optional(),
  }).strict(),
  restart_dynamic_workflow_worker: z.object({
    runId: z.string().optional(),
    workerId: z.string().optional(),
  }).strict(),
  save_dynamic_workflow_command: z.object({
    runId: z.string().optional(),
    commandName: z.string().min(1).optional(),
  }).strict(),
  run_harness_template: z.object({
    templateId: z.string().optional(),
    inputs: z.record(z.unknown()).optional(),
  }).strict(),
};

const AppActionStepSchema: z.ZodType<AppActionStep> = AppActionStepBaseSchema.superRefine((step, ctx) => {
  const schema = paramSchemas[step.action];
  const parsed = schema.safeParse(step.params);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params", ...issue.path],
        message: issue.message,
      });
    }
  }
}) as z.ZodType<AppActionStep>;

const AppActionPlanSchema: z.ZodType<AppActionPlan> = z.object({
  version: z.literal(1),
  confidence: z.number().min(0).max(1),
  userIntent: z.string().min(1),
  requiresConfirmation: z.boolean(),
  clarificationQuestion: z.string().optional(),
  clarificationChoices: z.array(z.string().min(1)).max(4).optional(),
  assumptions: z.array(z.string()),
  steps: z.array(AppActionStepSchema),
}).strict();

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

export type AppActionRisk = "read" | "direct-write" | "confirm-write" | "destructive" | "sensitive";

export const DIRECT_WRITE_ACTIONS = new Set<AppActionKind>([
  "switch_org" as AppActionKind,
  "run_workflow" as AppActionKind,
  "run_schedule" as AppActionKind,
  "run_council",
  "rerun_council_session",
  "create_council_verdict_task",
  "run_organization_execution",
  "validate_channel" as AppActionKind,
  "refresh_surface" as AppActionKind,
]);

export const CONFIRM_WRITE_ACTIONS = new Set<AppActionKind>([
  "create_agent",
  "create_agents",
  "create_organization",
  "update_organization",
  "switch_organization",
  "apply_org_template",
  "assign_agents_to_organization",
  "create_board_task",
  "create_workflow_from_template",
  "toggle_workflow_active",
  "update_workflow_node",
  "set_workflow_node_model",
  "schedule_workflow",
  "create_goal",
  "update_goal",
  "update_agent_role",
  "update_agent_model_profile",
  "set_hierarchy_budget_policy",
  "set_hierarchy_approval_policy",
  "assign_goal_to_org_agents",
  "link_goal_sources",
  "export_org_package",
  "delete_organization" as AppActionKind,
  "delete_agent" as AppActionKind,
  "delete_council_session",
  "plan_dynamic_workflow",
  "create_dynamic_workflow_run",
  "start_dynamic_workflow_run",
  "pause_dynamic_workflow_run",
  "resume_dynamic_workflow_run",
  "cancel_dynamic_workflow_run",
  "restart_dynamic_workflow_worker",
  "save_dynamic_workflow_command",
  "run_harness_template",
]);

export const DESTRUCTIVE_ACTIONS = new Set<AppActionKind>([
  "delete_organization" as AppActionKind,
  "delete_agent" as AppActionKind,
  "delete_board_task" as AppActionKind,
  "delete_council_session",
]);

export const SENSITIVE_ACTIONS = new Set<AppActionKind>([
  "connect_channel",
  "update_config" as AppActionKind,
  "set_secret" as AppActionKind,
]);

export function classifyAppActionRisk(plan: { steps: { action: AppActionKind }[] }): AppActionRisk {
  const kinds = new Set(plan.steps.map(s => s.action));
  for (const k of kinds) { if (SENSITIVE_ACTIONS.has(k)) return "sensitive"; }
  for (const k of kinds) { if (DESTRUCTIVE_ACTIONS.has(k)) return "destructive"; }
  for (const k of kinds) { if (CONFIRM_WRITE_ACTIONS.has(k)) return "confirm-write"; }
  for (const k of kinds) { if (DIRECT_WRITE_ACTIONS.has(k)) return "direct-write"; }
  return "read";
}

// ---------------------------------------------------------------------------
// Destructive action guard
// ---------------------------------------------------------------------------

/** Pattern that matches action-name-like strings suggesting destructive intent. */
const DESTRUCTIVE_PATTERN = /\b(?:delete|remove|clear|reset|wipe|destroy|drop|purge|nuke)\b/i;

function containsDestructiveIntent(raw: unknown): boolean {
  if (typeof raw === "string") return DESTRUCTIVE_PATTERN.test(raw);
  if (Array.isArray(raw)) return raw.some(containsDestructiveIntent);
  if (raw !== null && typeof raw === "object") {
    return Object.values(raw as Record<string, unknown>).some(containsDestructiveIntent);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidateAppActionPlanResult =
  | { success: true; plan: AppActionPlan }
  | { success: false; error: string };

/**
 * Validate a raw parsed JSON value as an `AppActionPlan`.
 *
 * Rejects:
 * - unknown action kinds (Zod enum check)
 * - any action name or step label containing destructive keywords
 * - plans with version !== 1
 * - plans with file writes, shell commands, or credentials in step labels
 *   (matched by string heuristic on step labels)
 */
export function validateAppActionPlan(raw: unknown): ValidateAppActionPlanResult {
  const parsed = AppActionPlanSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    return {
      success: false,
      error: first
        ? `${first.path.join(".")}: ${first.message}`
        : "Plan did not match required schema.",
    };
  }

  const plan = parsed.data;

  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    if (stepIds.has(step.id)) {
      return {
        success: false,
        error: `Duplicate step id "${step.id}" is not allowed in app plans.`,
      };
    }
    stepIds.add(step.id);
  }

  // Check for destructive action names or labels
  for (const step of plan.steps) {
    if (containsDestructiveIntent(step.action) || containsDestructiveIntent(step.label)) {
      return {
        success: false,
        error: `Step "${step.id}" contains a destructive action ("${step.action}"). Destructive actions are not supported in app plans.`,
      };
    }
  }

  // Block shell/file-write/secrets in step labels
  const unsafeStepPattern =
    /\b(?:bash|shell|exec|eval|write\s+file|run\s+code|api.?key|secret|password|credential|token\s+value)\b/i;
  for (const step of plan.steps) {
    if (unsafeStepPattern.test(step.label)) {
      return {
        success: false,
        error: `Step "${step.id}" label contains unsafe operations that are not permitted in app plans.`,
      };
    }
  }

  return { success: true, plan };
}

function withoutMissingOrSelfDependencies(step: AppActionStep, validIds: Set<string>): AppActionStep {
  const dependsOn = Array.from(
    new Set((step.dependsOn ?? []).filter((id) => id !== step.id && validIds.has(id))),
  );
  return dependsOn.length > 0 ? { ...step, dependsOn } : { ...step, dependsOn: undefined };
}

function addDependency(step: AppActionStep, stepId: unknown, validIds: Set<string>): AppActionStep {
  if (typeof stepId !== "string" || !validIds.has(stepId) || stepId === step.id) return step;
  const dependsOn = new Set(step.dependsOn ?? []);
  dependsOn.add(stepId);
  return { ...step, dependsOn: Array.from(dependsOn) };
}

/**
 * Repair structural integrity of an already schema-valid plan without
 * changing user intent: remove dangling/self dependencies and infer obvious
 * dependencies from `*StepId` params.
 */
export function normalizeAppActionPlanStructure(plan: AppActionPlan): AppActionPlan {
  const validIds = new Set(plan.steps.map((step) => step.id));
  const steps = plan.steps.map((rawStep) => {
    let step = withoutMissingOrSelfDependencies(rawStep, validIds);
    const params = step.params;

    if (typeof params.memberStepId === "string") {
      step = addDependency(step, params.memberStepId, validIds);
    }
    if (typeof params.agentStepId === "string") {
      step = addDependency(step, params.agentStepId, validIds);
    }
    if (typeof params.organizationStepId === "string") {
      step = addDependency(step, params.organizationStepId, validIds);
    }
    if (typeof params.workflowStepId === "string") {
      step = addDependency(step, params.workflowStepId, validIds);
    }
    if (typeof params.taskStepId === "string") {
      step = addDependency(step, params.taskStepId, validIds);
    }
    if (typeof params.goalStepId === "string") {
      step = addDependency(step, params.goalStepId, validIds);
    }
    return step;
  });

  const choices =
    plan.clarificationChoices
      ?.map((choice) => choice.trim())
      .filter(Boolean)
      .slice(0, 4);

  return {
    ...plan,
    clarificationChoices: choices && choices.length > 0 ? choices : undefined,
    steps,
  };
}
