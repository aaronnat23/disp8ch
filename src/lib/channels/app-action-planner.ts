/**
 * LLM App-Action Planner
 *
 * Converts vague multi-domain WebChat prompts into structured, validated
 * AppActionPlan objects.  The planner:
 *   1. Builds compact context (agents, orgs, boards, templates, channels)
 *   2. Calls the configured model with a strict JSON-only system prompt
 *   3. Parses + validates the JSON response via validateAppActionPlan
 *   4. Returns null on unrecoverable failures
 */

import { logger } from "@/lib/utils/logger";
import {
  normalizeAppActionPlanStructure,
  validateAppActionPlan,
  type AppActionKind,
  type AppActionPlan,
  type AppActionStep,
} from "@/lib/channels/app-action-schema";
import { listWorkflowTemplateCatalog } from "@/lib/workflows/template-catalog";
import { WORKFLOW_TEMPLATE_DESCRIPTIONS } from "@/lib/workflows/template-recommendations";
import type { CallModelOptions } from "@/lib/agents/multi-provider";
import { getAbortSignal, isTurnAborted } from "@/lib/channels/turn-abort-registry";
import {
  isHierarchyMutationIntent,
  isWorkflowActivationMutationIntent,
  isWorkflowNodeEditMutationIntent,
} from "@/lib/channels/app-action-eligibility";
import { resolveNode, resolveWorkflow } from "@/lib/workflows/workflow-tool-ops";

const log = logger.child("app-action-planner");

// ---------------------------------------------------------------------------
// Cache & timing constants
// ---------------------------------------------------------------------------

let cachedCompactCtx: { data: CompactContext; ts: number; includeHierarchy: boolean } | null = null;
const COMPACT_CTX_CACHE_MS = 5_000;
const PLANNER_MODEL_TIMEOUT_MS = 12_000;

// ---------------------------------------------------------------------------
// Context builders (lightweight — avoid big DB scans)
// ---------------------------------------------------------------------------

type AgentCtx = { id: string; name: string; isDefault: boolean; isActive: boolean };
type OrgCtx = { id: string; name: string; memberCount: number };
type BoardCtx = { id: string; name: string };
type ChannelCtx = { channel: string; connected: boolean };
type HierarchyRoleCtx = {
  agentId: string;
  agentName: string;
  roleTitle: string;
  roleType: string;
  reportsTo: string | null;
  active: boolean;
};
type GoalCtx = {
  id: string;
  name: string;
  organizationId: string | null;
  status: string;
  level: string | null;
  parentGoalId: string | null;
};
type CompanyTemplateCtx = { id: string; name: string; roleCount: number; goalCount: number };

type CompactContext = {
  agents: AgentCtx[];
  orgs: OrgCtx[];
  boards: BoardCtx[];
  channels: ChannelCtx[];
  activeOrg: { id: string; name: string; mission: string | null } | null;
  hierarchyRoles: HierarchyRoleCtx[];
  goals: GoalCtx[];
  companyTemplates: CompanyTemplateCtx[];
};

function isHierarchyContextRelevant(message: string): boolean {
  return (
    isHierarchyMutationIntent(message) ||
    /\b(?:org(?:anization)?s?|hierarchy|team|crew|department|company|goal|objective|milestone|key\s+result|mission|report(?:s|ing)?\s+to|role|capabilit|vote\s+weight|template|source\s+pack|attach\b.*\b(?:doc|source|data)|assign\b.*\b(?:goal|agent|team|everyone))\b/i.test(
      message,
    )
  );
}

async function loadCompactContext(
  internalBaseUrl: string,
  options: { includeHierarchy?: boolean } = {},
): Promise<CompactContext> {
  const now = Date.now();
  const includeHierarchy = options.includeHierarchy === true;
  if (
    cachedCompactCtx &&
    now - cachedCompactCtx.ts < COMPACT_CTX_CACHE_MS &&
    (!includeHierarchy || cachedCompactCtx.includeHierarchy)
  ) {
    return cachedCompactCtx.data;
  }

  let agents: AgentCtx[] = [];
  let orgs: OrgCtx[] = [];
  let boards: BoardCtx[] = [];
  let channels: ChannelCtx[] = [];
  let activeOrg: { id: string; name: string; mission: string | null } | null = null;
  let hierarchyRoles: HierarchyRoleCtx[] = [];
  let goals: GoalCtx[] = [];
  let companyTemplates: CompanyTemplateCtx[] = [];

  try {
    const { getSqlite } = (await import("@/lib/db")) as typeof import("@/lib/db");
    const db = getSqlite();

    const agentRows = db
      .prepare(
        "SELECT id, name, is_default, is_active FROM agents ORDER BY is_default DESC, name ASC LIMIT 20",
      )
      .all() as Array<{ id: string; name: string; is_default: number; is_active: number }>;
    agents = agentRows.map((row) => ({
      id: row.id,
      name: row.name,
      isDefault: row.is_default === 1,
      isActive: row.is_active === 1,
    }));
  } catch {
    // DB not ready — skip
  }

  try {
    const { getSqlite } = (await import("@/lib/db")) as typeof import("@/lib/db");
    const db = getSqlite();

    const orgRows = db
      .prepare(
        "SELECT id, name, COALESCE(json_array_length(snapshot_json), 0) as member_count FROM hierarchy_organizations ORDER BY is_active DESC, name ASC LIMIT 10",
      )
      .all() as Array<{ id: string; name: string; member_count: number }>;
    orgs = orgRows.map((row) => ({
      id: row.id,
      name: row.name,
      memberCount: row.member_count,
    }));
  } catch {
    // Table may not exist yet
  }

  try {
    const { getSqlite } = (await import("@/lib/db")) as typeof import("@/lib/db");
    const db = getSqlite();

    const boardRows = db
      .prepare("SELECT id, name FROM boards ORDER BY name ASC LIMIT 10")
      .all() as Array<{ id: string; name: string }>;
    boards = boardRows.map((row) => ({ id: row.id, name: row.name }));
  } catch {
    // Table may not exist — use synthetic default
    boards = [{ id: "main-board", name: "Main Board" }];
  }

  // Channel statuses from DB
  try {
    const { getSqlite } = (await import("@/lib/db")) as typeof import("@/lib/db");
    const db = getSqlite();
    const channelRows = db
      .prepare("SELECT channel_type as channel, connected FROM channel_connections WHERE connected = 1")
      .all() as ChannelCtx[];
    channels = channelRows.map((row) => ({ channel: row.channel, connected: true }));
  } catch {
    // Not critical
  }

  if (includeHierarchy) {
    // Active organization (id/name/mission) — keep mission capped.
    try {
      const { getSqlite } = (await import("@/lib/db")) as typeof import("@/lib/db");
      const db = getSqlite();
      const cfg = db
        .prepare("SELECT active_organization_id FROM app_config WHERE id = 'default'")
        .get() as { active_organization_id?: string | null } | undefined;
      const activeId = cfg?.active_organization_id ? String(cfg.active_organization_id) : null;
      if (activeId) {
        const orgRow = db
          .prepare("SELECT id, name, mission FROM hierarchy_organizations WHERE id = ? LIMIT 1")
          .get(activeId) as { id: string; name: string; mission: string | null } | undefined;
        if (orgRow) {
          activeOrg = {
            id: orgRow.id,
            name: orgRow.name,
            mission: orgRow.mission ? String(orgRow.mission).slice(0, 200) : null,
          };
        }
      }
    } catch {
      // Table may not exist yet
    }

    // Hierarchy roles — active org agents first, capped at 30. Read-only join.
    try {
      const { getSqlite } = (await import("@/lib/db")) as typeof import("@/lib/db");
      const db = getSqlite();
      const roleRows = db
        .prepare(
          `SELECT r.agent_id as agentId, a.name as agentName, r.role_title as roleTitle,
                  r.role_type as roleType, r.reports_to as reportsTo, a.is_active as active
           FROM agent_roles r JOIN agents a ON a.id = r.agent_id
           ORDER BY a.is_active DESC, a.is_default DESC, r.updated_at DESC
           LIMIT 30`,
        )
        .all() as Array<{
          agentId: string;
          agentName: string;
          roleTitle: string | null;
          roleType: string | null;
          reportsTo: string | null;
          active: number;
        }>;
      hierarchyRoles = roleRows.map((row) => ({
        agentId: row.agentId,
        agentName: row.agentName,
        roleTitle: row.roleTitle ?? "",
        roleType: row.roleType ?? "worker",
        reportsTo: row.reportsTo ?? null,
        active: row.active === 1,
      }));
    } catch {
      // agent_roles table may not exist yet
    }

    // Goals — active org first, capped at 20. Descriptions omitted.
    try {
      const { getSqlite } = (await import("@/lib/db")) as typeof import("@/lib/db");
      const db = getSqlite();
      const activeId = activeOrg?.id ?? null;
      const goalRows = db
        .prepare(
          `SELECT id, name, organization_id as organizationId, status, level, parent_goal_id as parentGoalId
           FROM hierarchy_goals
           WHERE is_active = 1
           ORDER BY (organization_id = ?) DESC, updated_at DESC
           LIMIT 20`,
        )
        .all(activeId) as Array<{
          id: string;
          name: string;
          organizationId: string | null;
          status: string | null;
          level: string | null;
          parentGoalId: string | null;
        }>;
      goals = goalRows.map((row) => ({
        id: row.id,
        name: row.name,
        organizationId: row.organizationId ?? null,
        status: row.status ?? "planned",
        level: row.level ?? null,
        parentGoalId: row.parentGoalId ?? null,
      }));
    } catch {
      // hierarchy_goals table may not exist yet
    }

    // Company templates — static catalog, small.
    try {
      const { listCompanyTemplates } = await import("@/lib/hierarchy/company-templates");
      companyTemplates = listCompanyTemplates().map((template) => ({
        id: template.id,
        name: template.name,
        roleCount: template.roles.length,
        goalCount: template.goals.length,
      }));
    } catch {
      // Not critical
    }
  }

  const result = { agents, orgs, boards, channels, activeOrg, hierarchyRoles, goals, companyTemplates };
  cachedCompactCtx = { data: result, ts: Date.now(), includeHierarchy };
  return result;
}

// ---------------------------------------------------------------------------
// Planner system prompt
// ---------------------------------------------------------------------------

const ALLOWED_ACTIONS = [
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
];

const ACTION_PARAM_GUIDE = [
  "create_agent params: name?, purpose?, modelRef?",
  "create_agents params: count?, names?, purpose?",
  "create_organization params: name?, description?, memberStepId?, memberIds?, activate?",
  "update_organization params: organizationId?, organizationName?, organizationStepId?, name?, description?, mission?, activate?",
  "switch_organization params: organizationId?, organizationName?, organizationStepId?",
  "apply_org_template params: templateId?, templateName?, organizationName?, activate?",
  "assign_agents_to_organization params: organizationId?, organizationName?, organizationStepId?, agentIds?, agentNames?, agentStepId?",
  "assign_skill_to_agent params: agentId?, agentStepId?, skillId",
  "attach_extension_to_agent params: agentId?, agentStepId?, extensionId",
  "create_board_task params: boardId?, title?, description?, organizationId?, organizationStepId?, agentId?, agentStepId?",
  "link_board_task_to_agent params: taskId?, taskStepId?, agentId?, agentStepId?",
  "link_board_task_to_organization params: taskId?, taskStepId?, organizationId?, organizationStepId?",
  "link_board_task_to_goal params: taskId?, taskStepId?, goalId?, goalStepId?",
  "create_workflow_from_template params: template?, templateKey?, name?",
  "toggle_workflow_active params: workflowId?, workflowName?, workflowStepId?, active(required boolean). Use active=true for activate/enable/turn on; active=false for deactivate/disable/turn off.",
  "update_workflow_node params: workflowId?, workflowName?, workflowStepId?, nodeId?, nodeLabel?, updates(object of field->value, e.g. {systemPrompt:\"...\", url:\"...\", temperature:0.2}). Use the node's label (e.g. \"Summarizer\", \"Web Search\") for nodeLabel.",
  "set_workflow_node_model params: workflowId?, workflowName?, nodeId?, nodeLabel?, modelRef(required, e.g. \"deepseek-v4-flash\"). Omit nodeLabel to set the model on every agent node in the workflow.",
  "create_goal params: title?, organizationId?, organizationStepId?",
  "update_goal params: goalId?, goalName?, goalStepId?, organizationId?, organizationName?, name?, description?, status?(planned|active|blocked|done), level?(vision|mission|objective|key_result), parentGoalId?, parentGoalName?",
  "update_agent_role params: agentId?, agentName?, agentStepId?, organizationId?, organizationName?, roleType?(orchestrator|operations|specialist|worker|support), roleTitle?, roleDescription?, reportsToAgentId?, reportsToAgentName?, capabilities?, voteWeight?, active?",
  "update_agent_model_profile params: agentId?, agentName?, agentStepId?, organizationId?, organizationName?, modelRef?, systemPrompt?, temperature?, maxTokens?, enabledSkills?, enabledToolsets?, enabledExtensions?, disabledTools?, spendCapUsd?, spendWindowDays?, budgetAction?(warn|block)",
  "set_hierarchy_budget_policy params: organizationId?, organizationName?, goalId?, goalName?, agentId?, agentName?, scope(organization|goal|agent), softLimitUsd?, hardLimitUsd?, requireApprovalAboveUsd?, period?(daily|weekly|monthly|total), isActive?",
  "set_hierarchy_approval_policy params: organizationId?, organizationName?, scope(organization|goal|agent), actionPattern, approverAgentId?, approverAgentName?, requireHuman?, minRisk?(low|medium|high), isActive?",
  "assign_goal_to_org_agents params: goalId?, goalName?, goalStepId?, organizationId?, organizationName?, title?, description?, priority?(low|medium|high)",
  "link_goal_sources params: goalId?, goalName?, goalStepId?, organizationId?, organizationName?, documentIds?, documentNames?, mode?(append|replace)",
  "export_org_package params: organizationId?, organizationName?, organizationStepId?",
  "run_council params: topic?, organizationId?, organizationName?, organizationStepId?, agentIds?, agentNames?, agentStepId?, goalId?, goalName?, goalStepId?, documentIds?, documentNames?, useGoalDocuments?, options?, mode?(poll|debate), rounds?(2-5), decisionMode?(majority|consensus|weighted|ranked), synthesizerAgentId?, synthesizerAgentName?, useModeratorSynthesis?, discoverOptions?, costCapUsd?, createBoardTaskFromVerdict?, createFollowUpTasksFromConcerns?, boardId?",
  "rerun_council_session params: sessionId?, topic?, organizationId?, organizationName?",
  "delete_council_session params: sessionId?, topic?, organizationId?, organizationName?",
  "create_council_verdict_task params: sessionId?, topic?, organizationId?, organizationName?, boardId?",
  "run_organization_execution params: organizationId?, organizationStepId?, prompt?",
  "schedule_workflow params: workflowId?, workflowStepId?, schedule?",
  "connect_channel params: channel",
  "recommend_templates params: topic?",
  "summarize_hierarchy_activity params: organizationId?, organizationName?, goalId?, goalName?, agentId?, agentName?, limit?",
  "summarize_state params: domain?",
  "ask_clarifying_question params: {}",
].join("\n");

function buildSystemPrompt(): string {
  return [
    "You are the disp8ch app-action planner.",
    "Return ONLY valid JSON matching the schema below. Do not include markdown fences or explanatory text.",
    "",
    "You may ONLY use the following actions (exact strings):",
    ALLOWED_ACTIONS.map((a) => `  - ${a}`).join("\n"),
    "",
    "Schema:",
    JSON.stringify(
      {
        version: 1,
        confidence: "number 0-1",
        userIntent: "string",
        requiresConfirmation: "boolean (true for any state-changing action)",
        clarificationQuestion: "string or omit",
        clarificationChoices: ["optional array of up to 4 short choices"],
        assumptions: ["string"],
        steps: [
          {
            id: "short unique string",
            action: "one of the allowed actions",
            label: "human-readable description",
            params: { "action-specific params": "..." },
            dependsOn: ["step-id or omit"],
          },
        ],
      },
      null,
      2,
    ),
    "",
    "Action parameter guide. Use ONLY these param keys for each action:",
    ACTION_PARAM_GUIDE,
    "",
    "Rules:",
    "- If the user's request is unclear but recoverable, include explicit assumptions and proceed.",
    "- If required information is missing and cannot be reasonably assumed, use ask_clarifying_question with a single clarificationQuestion string, optional clarificationChoices, and 0 steps.",
    "- Never claim a feature, template, or agent exists unless present in the capability context.",
    "- Never include secrets, API keys, or raw credentials in a plan.",
    "- Set requiresConfirmation=true for any step that creates, links, or modifies app state.",
    "- Read-only steps (recommend_templates, summarize_hierarchy_activity, summarize_state) may set requiresConfirmation=false.",
    "- For ask_clarifying_question plans, steps must be empty [].",
    "- Clarification choices must be concrete, mutually exclusive, and no more than 4 items.",
    "- Keep params minimal: only include fields that are known or reasonably inferred.",
    "- Use null for name/title params that should be auto-generated.",
    "- Steps that depend on prior step outputs reference the prior step's id in dependsOn[].",
    "- Prefer the shortest complete plan, but do not drop explicit user requests just to stay under 4 steps.",
    "- For create_agents followed by create_organization, set create_organization.params.memberStepId to the create_agents step id.",
    "- Do not use placeholder ids like default-org unless they are present in context.",
    "",
    "Planning discipline:",
    "- Treat every requested clause as work to cover: create agents, assign skills, attach extensions, create orgs/hierarchies, run councils/debates, create workflows, schedule workflows, connect channels, create board tasks, and summarize/recommend read-only state.",
    "- Multi-step prompts often use plain English such as 'put them in a team', 'have them debate', 'argue through edge cases', 'prepare Telegram alerts', 'track the decision', or 'make a daily check'. Map those to the closest allowed action.",
    "- If the user asks for a council, debate, argument, vote, verdict, or decision by agents, include run_council.",
    "- For run_council, preserve Council-tab controls from user language: poll vs debate -> mode; 'rounds' -> rounds; majority/consensus/weighted/ranked -> decisionMode; named options -> options; moderator/synthesizer -> synthesizerAgentName/synthesizerAgentId or useModeratorSynthesis=true; named files/docs/sources -> documentNames/documentIds; goal context -> goalName/goalId and useGoalDocuments=true; cost/budget cap -> costCapUsd; 'create a task/card from the verdict' -> createBoardTaskFromVerdict=true; 'make follow-ups from concerns/dissent' -> createFollowUpTasksFromConcerns=true.",
    "- If the user asks to rerun/restore/replay a prior Council session, use rerun_council_session.",
    "- If the user asks to delete/remove a Council history/session, use delete_council_session.",
    "- If the user asks to create a board task/card from an existing Council verdict/session, use create_council_verdict_task.",
    "- If the user asks to put agents into an org, company, hierarchy, department, crew, or team, include create_organization after agent creation.",
    "- If the user names an EXISTING agent and asks to add/assign/move it to an existing org, use assign_agents_to_organization with ids from current app state. Never create a duplicate agent.",
    "- If the user asks to create a new agent and add it to an EXISTING org, create the agent first, then use assign_agents_to_organization with agentStepId and the existing organization id.",
    "- If the user asks to track, record, add to board, create a card, todo, follow-up, or next action, include create_board_task.",
    "- If the user asks for a workflow, pipeline, automation, monitor, scheduled check, daily/weekly run, or template, include create_workflow_from_template and include schedule_workflow when recurrence is requested.",
    "- If the user asks to activate, enable, deactivate, disable, turn on, or turn off an EXISTING workflow, use toggle_workflow_active.",
    "- Do NOT include update_workflow_node or set_workflow_node_model in a from-scratch create_workflow_from_template plan unless the user explicitly asks to edit a specific existing workflow node. A plain 'create a workflow that...' request should normally be one workflow-create step, plus schedule/channel/board steps only if requested.",
    "- If the user asks for a reminder, digest, report, news update, latest/current summary, or scheduled research summary, create a research/live-research workflow and schedule it. Do not create agents unless the user explicitly asks for agents, people, a team, or a crew.",
    "- If the user names Telegram, Slack, Discord, WhatsApp, Teams, BlueBubbles, WebChat, alerts, notifications, or updates as setup/routing work, include connect_channel for that channel.",
    "- If the user names a skill or extension for new agents, include assign_skill_to_agent or attach_extension_to_agent after creating the agents.",
    "",
    "Hierarchy operations:",
    "- If the user asks to rename, revise, update, activate, or change the mission/description of an existing org, use update_organization.",
    "- If the user asks to make an org active or switch orgs, use switch_organization.",
    "- If the user asks to use/apply a company template or org template (e.g. 'SaaS launch', 'client services'), use apply_org_template.",
    "- If the user asks to change goal status, level, parent, name, or description, use update_goal.",
    "- If the user asks to change an agent's hierarchy role, reporting line, capabilities, or vote weight, use update_agent_role.",
    "- If the user asks to change an agent's model, profile prompt, skills, toolsets, extensions, tool permissions, token limit, temperature, or budget, use update_agent_model_profile.",
    "- If the user asks to edit a node INSIDE a specific workflow (e.g. change a node's system prompt, URL, headers, temperature, code, or message), use update_workflow_node with that workflow's name and the node's label. To change the model/agent used by a workflow's agent node, use set_workflow_node_model.",
    "- If the user asks for org/goal/agent budget limits, spending limits, approval thresholds, or cost caps, use set_hierarchy_budget_policy.",
    "- If the user asks for approval chains, human approval, approver agents, or risk-based approval rules, use set_hierarchy_approval_policy.",
    "- If the user asks what an org, goal, or agent did recently, use summarize_hierarchy_activity.",
    "- If the user asks to assign a goal to the org/team/everyone/all agents, use assign_goal_to_org_agents.",
    "- If the user asks to attach documents, sources, files, source packs, or data sources to a goal, use link_goal_sources.",
    "- If the user asks to export/share/archive an org package, use export_org_package.",
    "- Prefer apply_org_template over create_organization + create_agents when the user names a known company/org template.",
    "- Before returning JSON, silently verify that each important noun/verb phrase in the user message is represented by either a step, an assumption, or a clarification question.",
  ].join("\n");
}

function buildRepairSystemPrompt(): string {
  return [
    "You are the disp8ch app-action plan coverage reviewer.",
    "Return ONLY valid JSON matching the original AppActionPlan schema. No prose, no markdown fences.",
    "",
    "Your job is to repair a draft plan if it missed explicit user-requested work.",
    "Do not rewrite a good plan for style. Keep existing ids when possible.",
    "Add missing steps only when the user plainly requested that surface or operation.",
    "Do not invent unsupported actions; use only the allowed action strings from the draft planner.",
    "Use ONLY the allowed param keys for each action.",
    "Preserve requiresConfirmation=true when the plan changes app state.",
    "",
    "Action parameter guide:",
    ACTION_PARAM_GUIDE,
    "",
    "Coverage checklist:",
    "- agents/personas/workers -> create_agent or create_agents",
    "- skills -> assign_skill_to_agent",
    "- extensions/plugins/tools attached to agents -> attach_extension_to_agent",
    "- org/company/team/hierarchy/crew/department -> create_organization",
    "- council/debate/argument/vote/verdict/decision by agents -> run_council",
    "- board/task/card/todo/follow-up/track/record next action -> create_board_task",
    "- workflow/pipeline/automation/template/monitor/check -> create_workflow_from_template",
    "- activate/enable/deactivate/disable workflow -> toggle_workflow_active",
    "- reminder/digest/report/news/latest/current summary -> create_workflow_from_template, usually live-research-assistant or research-assistant",
    "- daily/weekly/recurring/schedule/cron -> schedule_workflow",
    "- Telegram/Slack/Discord/WhatsApp/Teams/BlueBubbles/WebChat alerts/channel/notifications/updates -> connect_channel",
    "",
    "If a requested item is already covered by a step, do not duplicate it.",
  ].join("\n");
}

function buildSchemaRepairSystemPrompt(): string {
  return [
    "You are the disp8ch app-action JSON schema repairer.",
    "Return ONLY valid JSON matching the AppActionPlan schema. No prose, no markdown fences.",
    "The draft plan may contain correct intent but invalid param keys. Repair it without dropping requested work.",
    "Use ONLY allowed actions and ONLY the allowed param keys listed below.",
    "Map common invalid keys to valid ones:",
    "- skill or skillName -> skillId",
    "- extension or extensionName -> extensionId",
    "- taskIdStepId -> taskStepId",
    "- organizationIdStepId -> organizationStepId",
    "- workflowIdStepId -> workflowStepId",
    "- name on create_agents -> names or omit",
    "",
    "Action parameter guide:",
    ACTION_PARAM_GUIDE,
  ].join("\n");
}

function buildRepairUserMessage(
  originalUserMessage: string,
  draftPlan: AppActionPlan,
  plannerContextMessage: string,
  coverageNotes?: string[],
): string {
  return [
    "Original user message:",
    originalUserMessage,
    "",
    "Planner context:",
    plannerContextMessage,
    "",
    "Draft plan JSON:",
    JSON.stringify(draftPlan, null, 2),
    ...(coverageNotes && coverageNotes.length > 0
      ? [
          "",
          "Detected missing coverage that should be repaired if accurate:",
          ...coverageNotes.map((note) => `- ${note}`),
        ]
      : []),
    "",
    "Return the corrected complete plan JSON only.",
  ].join("\n");
}

function buildSchemaRepairUserMessage(args: {
  originalUserMessage: string;
  plannerContextMessage: string;
  rawPlan: unknown;
  validationError: string;
}): string {
  return [
    "Original user message:",
    args.originalUserMessage,
    "",
    "Planner context:",
    args.plannerContextMessage,
    "",
    "Validation error:",
    args.validationError,
    "",
    "Invalid draft plan JSON:",
    JSON.stringify(args.rawPlan, null, 2),
    "",
    "Return repaired valid plan JSON only.",
  ].join("\n");
}

function buildUserMessage(
  message: string,
  ctx: {
    sessionId: string;
    channel: string;
    agents: AgentCtx[];
    orgs: OrgCtx[];
    boards: BoardCtx[];
    channels: ChannelCtx[];
    activeOrg?: { id: string; name: string; mission: string | null } | null;
    hierarchyRoles?: HierarchyRoleCtx[];
    goals?: GoalCtx[];
    companyTemplates?: CompanyTemplateCtx[];
  },
): string {
  const templateCompact = listWorkflowTemplateCatalog()
    .slice(0, 30)
    .map((t) => {
      const desc = WORKFLOW_TEMPLATE_DESCRIPTIONS[t.key] ?? "";
      return `${t.key}: ${t.name}${desc ? ` — ${desc.split(".")[0]}` : ""}`;
    })
    .join("\n");

  const agentList =
    ctx.agents.length === 0
      ? "(none)"
      : ctx.agents
          .slice(0, 10)
          .map((a) => `${a.id}: ${a.name}${a.isDefault ? " (default)" : ""}${a.isActive ? "" : " [inactive]"}`)
          .join(", ");

  const orgList =
    ctx.orgs.length === 0
      ? "(none)"
      : ctx.orgs
          .slice(0, 5)
          .map((o) => `${o.id}: ${o.name} (${o.memberCount} members)`)
          .join(", ");

  const boardList =
    ctx.boards.length === 0
      ? "main-board (default)"
      : ctx.boards
          .slice(0, 5)
          .map((b) => `${b.id}: ${b.name}`)
          .join(", ");

  const channelList =
    ctx.channels.length === 0
      ? "(none configured)"
      : ctx.channels.map((c) => `${c.channel}:${c.connected ? "connected" : "off"}`).join(", ");

  // Compact hierarchy details are rendered only for org/team/goal/role/template
  // prompts; loadCompactContext also skips those DB reads for ordinary prompts.
  const hierarchyRelevant = isHierarchyContextRelevant(message);

  const lines = [
    `User message: "${message}"`,
    `Session: ${ctx.sessionId}  Channel: ${ctx.channel}`,
    "",
    "Current app state (compact):",
    `  Agents: ${agentList}`,
    `  Organizations: ${orgList}`,
    `  Boards: ${boardList}`,
    `  Channels: ${channelList}`,
  ];

  if (ctx.activeOrg) {
    lines.push(
      `  Active org: ${ctx.activeOrg.id}: ${ctx.activeOrg.name}${ctx.activeOrg.mission ? ` — mission: ${ctx.activeOrg.mission}` : ""}`,
    );
  }

  if (hierarchyRelevant) {
    const roles = (ctx.hierarchyRoles ?? []).slice(0, 30);
    if (roles.length > 0) {
      lines.push("", "Hierarchy roles (agentId: name — roleTitle [roleType], reportsTo):");
      lines.push(
        ...roles.map(
          (r) =>
            `  ${r.agentId}: ${r.agentName} — ${r.roleTitle || r.roleType} [${r.roleType}]${r.reportsTo ? `, reportsTo ${r.reportsTo}` : ""}${r.active ? "" : " [inactive]"}`,
        ),
      );
    }

    const goalList = (ctx.goals ?? []).slice(0, 20);
    if (goalList.length > 0) {
      lines.push("", "Goals (id: name [status/level], org):");
      lines.push(
        ...goalList.map(
          (g) =>
            `  ${g.id}: ${g.name} [${g.status}${g.level ? `/${g.level}` : ""}]${g.organizationId ? `, org ${g.organizationId}` : ""}${g.parentGoalId ? `, parent ${g.parentGoalId}` : ""}`,
        ),
      );
    }

    const templates = ctx.companyTemplates ?? [];
    if (templates.length > 0) {
      lines.push("", "Company templates (id: name — roles/goals):");
      lines.push(...templates.map((t) => `  ${t.id}: ${t.name} — ${t.roleCount} roles, ${t.goalCount} goals`));
    }
  }

  lines.push(
    "",
    "Available workflow templates:",
    templateCompact,
    "",
    "Return JSON only. No prose, no fences.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON extraction helper
// ---------------------------------------------------------------------------

function extractJson(raw: string): unknown {
  const stripped = raw.trim();

  // Try direct parse
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    // Strip markdown fences
    const fenced = stripped.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    try {
      return JSON.parse(fenced) as unknown;
    } catch {
      // Find first { ... } block
      const start = stripped.indexOf("{");
      const end = stripped.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(stripped.slice(start, end + 1)) as unknown;
        } catch {
          // fall through
        }
      }
      return null;
    }
  }
}

function inferRequestedSkillIds(message: string): string[] {
  const normalized = message.toLowerCase();
  const skills: string[] = [];
  const add = (id: string) => {
    if (!skills.includes(id)) skills.push(id);
  };
  if (/\bautonomous\s+researcher\b/.test(normalized)) add("autonomous-researcher");
  if (/\bcoding(?:\s+agent)?\s+skill\b|\bcoding\s+skill\b|\bcoding\s+(?:and|\/|\+)\s+research\s+skills?\b|\bcoding\s+agent\b|\bcode\s+review\b/.test(normalized)) add("coding:coding-agent");
  if (/\bresearch(?:er|ing)?\s+skill\b|\bresearch\s+skills?\b|\bresearcher\s+agent\b|\bcoding\s+(?:and|\/|\+)\s+research\s+skills?\b/.test(normalized)) add("autonomous-researcher");
  if (/\bdocument[-\s]+intelligence\b/.test(normalized)) add("document-intelligence");
  if (/\bcouncil\s+facilitator\b/.test(normalized)) add("council-facilitator");
  if (/\bboard[-\s]+ops\b|\bboard\s+skill\b/.test(normalized)) add("board-ops");
  if (/\bgithub(?:\s+ops)?\s+skill\b/.test(normalized)) add("github:github-ops");
  return skills;
}

function inferRequestedExtensionIds(message: string): string[] {
  const normalized = message.toLowerCase();
  const extensions: string[] = [];
  const add = (id: string) => {
    if (!extensions.includes(id)) extensions.push(id);
  };
  if (/\bweb[-\s]+research\b|\bweb\s+research\s+extension\b/.test(normalized)) add("web-research");
  if (/\bdata[-\s]+sources?\b|\bdata\s+sources?\s+extension\b/.test(normalized)) add("data-sources");
  if (/\bgithub\b/.test(normalized) && /\bextension|attach|with|repo|pull\s+requests?|prs?\b/.test(normalized)) add("github");
  if (/\bcoding\s+extension\b/.test(normalized)) add("coding");
  if (/\bdiffs?\s+extension\b/.test(normalized)) add("diffs");
  if (/\bmemory[-\s]+core\b|\bmemory\s+extension\b/.test(normalized)) add("memory-core");
  return extensions;
}

function normalizeAssignmentId(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

function normalizeChannelId(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^i-message$/, "bluebubbles")
    .replace(/^imessage$/, "bluebubbles")
    .replace(/^microsoft-teams$/, "teams")
    .replace(/^gchat$/, "google-chat");
}

function normalizeTemplateId(value: unknown): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return "";

  const aliases: Record<string, string> = {
    "api-monitor-with-alerts": "api-monitor",
    "api-monitoring": "api-monitor",
    "api-watch": "api-monitor",
    "channel-assistant": "channel-workspace-assistant",
    "telegram-intake": "telegram-board-intake",
    "telegram-board": "telegram-board-intake",
    "daily-health": "scheduled-health-check",
    "daily-health-check": "scheduled-health-check",
    "health-check": "scheduled-health-check",
    "document-workflow": "document-intelligence",
    "document-research": "document-intelligence",
    "research": "research-assistant",
    "news": "live-research-assistant",
    "news-digest": "live-research-assistant",
    "daily-news": "live-research-assistant",
    "daily-digest": "live-research-assistant",
    "research-digest": "live-research-assistant",
    "scheduled-research": "live-research-assistant",
    "autonomous-research": "autonomous-research-pipeline",
    "ops": "ops-control-tower",
    "operations": "ops-control-tower",
  };
  if (aliases[normalized]) return aliases[normalized];

  const catalog = listWorkflowTemplateCatalog();
  const direct = catalog.find((entry) => entry.key === normalized);
  if (direct) return direct.key;
  const byName = catalog.find((entry) => normalizeAssignmentId(entry.name) === normalized);
  return byName?.key ?? normalized;
}

function normalizeSkillId(value: unknown): string {
  const normalized = normalizeAssignmentId(value);
  const aliases: Record<string, string> = {
    coding: "coding:coding-agent",
    "coding-agent": "coding:coding-agent",
    research: "autonomous-researcher",
    researcher: "autonomous-researcher",
    "research-skill": "autonomous-researcher",
    "document-intelligence-skill": "document-intelligence",
    "council-skill": "council-facilitator",
    "board-skill": "board-ops",
    github: "github:github-ops",
    "github-ops": "github:github-ops",
  };
  return aliases[normalized] ?? normalized;
}

function normalizeExtensionId(value: unknown): string {
  const normalized = normalizeAssignmentId(value);
  const aliases: Record<string, string> = {
    "web-research-extension": "web-research",
    "data-source": "data-sources",
    "data-source-extension": "data-sources",
    "data-sources-extension": "data-sources",
    "memory": "memory-core",
    "memory-extension": "memory-core",
    "github-extension": "github",
  };
  return aliases[normalized] ?? normalized;
}

function stringListFromValue(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;
  return value
    .split(/\s*(?:,|;|\band\b)\s*/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function coerceRawAppActionPlan(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const source = raw as Record<string, unknown>;
  const stepsSource = Array.isArray(source.steps) ? source.steps : [];
  const steps = stepsSource.map((rawStep) => {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) return rawStep;
    const step = rawStep as Record<string, unknown>;
    const rawParams =
      step.params && typeof step.params === "object" && !Array.isArray(step.params)
        ? (step.params as Record<string, unknown>)
        : {};
    const params: Record<string, unknown> = { ...rawParams };

    if (params.skill === undefined && params.skillName !== undefined) params.skill = params.skillName;
    if (params.skillId === undefined && params.skill !== undefined) params.skillId = params.skill;
    if (params.extension === undefined && params.extensionName !== undefined) params.extension = params.extensionName;
    if (params.extensionId === undefined && params.extension !== undefined) params.extensionId = params.extension;
    if (params.taskStepId === undefined && params.taskIdStepId !== undefined) params.taskStepId = params.taskIdStepId;
    if (params.organizationStepId === undefined && params.organizationIdStepId !== undefined) {
      params.organizationStepId = params.organizationIdStepId;
    }
    if (params.workflowStepId === undefined && params.workflowIdStepId !== undefined) {
      params.workflowStepId = params.workflowIdStepId;
    }

    for (const key of ["names", "memberIds", "agentIds"] as const) {
      if (key in params) params[key] = stringListFromValue(params[key]);
    }
    if (typeof params.count === "string" && /^\d{1,2}$/.test(params.count.trim())) {
      params.count = Number.parseInt(params.count.trim(), 10);
    }
    if (typeof params.activate === "string" && /^(?:true|false)$/i.test(params.activate.trim())) {
      params.activate = params.activate.trim().toLowerCase() === "true";
    }

    return {
      ...step,
      params,
      dependsOn: typeof step.dependsOn === "string" ? [step.dependsOn] : step.dependsOn,
    };
  });

  const clarificationChoices =
    Array.isArray(source.clarificationChoices) || typeof source.clarificationChoices !== "string"
      ? source.clarificationChoices
      : stringListFromValue(source.clarificationChoices);
  const assumptions =
    Array.isArray(source.assumptions)
      ? source.assumptions
      : typeof source.assumptions === "string"
        ? [source.assumptions]
        : [];
  const isClarificationOnly =
    typeof source.clarificationQuestion === "string" &&
    steps.some((step) => step && typeof step === "object" && (step as { action?: unknown }).action === "ask_clarifying_question");

  return {
    ...source,
    requiresConfirmation: isClarificationOnly ? false : source.requiresConfirmation,
    clarificationChoices,
    assumptions,
    steps: isClarificationOnly ? [] : steps,
  };
}

function normalizeAppActionParams(plan: AppActionPlan): AppActionPlan {
  const steps = plan.steps.map((step): AppActionStep => {
    const params = { ...step.params };
    if (step.action === "connect_channel") {
      params.channel = normalizeChannelId(params.channel);
    }
    if (step.action === "assign_skill_to_agent") {
      params.skillId = normalizeSkillId(params.skillId);
    }
    if (step.action === "attach_extension_to_agent") {
      params.extensionId = normalizeExtensionId(params.extensionId);
    }
    if (step.action === "create_workflow_from_template") {
      if (typeof params.templateKey === "string") params.templateKey = normalizeTemplateId(params.templateKey);
      if (typeof params.template === "string") params.template = normalizeTemplateId(params.template);
    }
    if (step.action === "schedule_workflow" && typeof params.schedule === "string") {
      params.schedule = params.schedule.trim().toLowerCase();
    }
    return { ...step, params };
  });
  return normalizeAppActionPlanStructure({ ...plan, steps });
}

type CoverageSurface = {
  id: string;
  label: string;
  requested: boolean;
  actions: AppActionKind[];
};

function hasWriteSignal(message: string): boolean {
  return /\b(?:create|generate|make|build|need|want|set\s+up|setup|add|establish|form|start|run|launch|spin\s+up|organize|assemble|prepare|connect|link|assign|schedule|record|track|turn|put|have|ask)\b/i.test(message);
}

export function detectRequestedCoverage(message: string): CoverageSurface[] {
  const normalized = message.toLowerCase();
  const writeSignal = hasWriteSignal(message);
  const skillIds = inferRequestedSkillIds(message);
  const extensionIds = inferRequestedExtensionIds(message);
  const channel = inferRequestedChannel(message);
  return [
    {
      id: "agents",
      label: "agents/workers/team members",
      requested: writeSignal && /\b(?:agents?|assistants?|workers?|people|person|members?|team|crew|owners?)\b/.test(normalized),
      // Role updates also satisfy "agent" coverage — don't force create_agents
      // when the user is editing an existing agent's role/reporting line.
      actions: ["create_agent", "create_agents", "update_agent_role", "assign_agents_to_organization"],
    },
    {
      id: "organization",
      label: "organization/hierarchy/team structure",
      requested: writeSignal && /\b(?:org(?:anization)?|hierarchy|team|crew|department|structure)\b/.test(normalized),
      // Mutations of an existing org (switch/update/apply-template/assign) also
      // satisfy this coverage — only inject create_organization when none of
      // these org actions are present.
      actions: ["create_organization", "assign_agents_to_organization", "update_organization", "switch_organization", "apply_org_template"],
    },
    {
      id: "skills",
      label: "skill assignment",
      requested: skillIds.length > 0,
      actions: ["assign_skill_to_agent"],
    },
    {
      id: "extensions",
      label: "extension/tool attachment",
      requested: extensionIds.length > 0,
      actions: ["attach_extension_to_agent"],
    },
    {
      id: "council",
      label: "council/debate/decision",
      // Only explicit deliberation words force Council. Generic comparison/
      // evaluation words (compare, evaluate, research, investigate, generic
      // decision/decide) must NOT deterministically add a Council step — the
      // model may still choose Council when the full prompt implies deliberation.
      requested:
        /\b(?:council|debate|argue|argument|deliberat|vote|verdict|consensus)\b/.test(normalized) ||
        /\b(?:have|let|ask|get|run)\s+(?:them|the\s+agents?|agents?|the\s+org(?:anization)?|the\s+team|the\s+crew|the\s+council)\s+(?:to\s+)?(?:decide|discuss|debate|deliberate|vote|choose|pick)\b/.test(normalized) ||
        /\bdecision\s+(?:meeting|council|vote|panel)\b/.test(normalized),
      actions: ["run_council"],
    },
    {
      id: "council_history",
      label: "council history/session management",
      requested: /\b(?:rerun|replay|restore|delete|remove)\b[\s\S]{0,80}\bcouncil\b|\bcouncil\b[\s\S]{0,80}\b(?:session|history|verdict)\b[\s\S]{0,80}\b(?:task|card|todo)\b/.test(normalized),
      actions: ["rerun_council_session", "delete_council_session", "create_council_verdict_task"],
    },
    {
      id: "workflow",
      label: "workflow/automation/pipeline",
      requested: writeSignal && /\b(?:workflow|flow|pipeline|automation|automate|template|monitor|watch|check|operating\s+rhythm|reminder|digest|report|summary|summarize|news|latest|current)\b/.test(normalized),
      actions: ["create_workflow_from_template", "toggle_workflow_active"],
    },
    {
      id: "schedule",
      label: "schedule/recurrence",
      requested: /\b(?:schedule|scheduled|daily|weekly|recurring|cron|every\s+(?:day|week|morning|weekday))\b/.test(normalized),
      actions: ["schedule_workflow"],
    },
    {
      id: "board",
      label: "board task/tracking/follow-up",
      requested: writeSignal && /\b(?:board|task|card|todo|follow[-\s]?up|track|tracking|record|save\s+(?:the\s+)?(?:decision|verdict|outcome|result)|somewhere)\b/.test(normalized),
      actions: ["create_board_task", "link_board_task_to_agent", "link_board_task_to_organization", "link_board_task_to_goal"],
    },
    {
      id: "channel",
      label: "channel setup/alerts/notifications",
      requested: Boolean(channel),
      actions: ["connect_channel"],
    },
    {
      id: "goal",
      label: "goal/objective/milestone",
      requested: writeSignal && /\b(?:goal|objective|milestone|target)\b/.test(normalized),
      // Goal mutations (update/assign/link sources) also satisfy goal coverage.
      actions: ["create_goal", "link_board_task_to_goal", "update_goal", "assign_goal_to_org_agents", "link_goal_sources"],
    },
  ];
}

function findMissingCoverage(message: string, plan: AppActionPlan): CoverageSurface[] {
  const actions = new Set(plan.steps.map((step) => step.action));
  return detectRequestedCoverage(message).filter(
    (surface) => surface.requested && !surface.actions.some((action) => actions.has(action)),
  );
}

function buildCoverageNotes(message: string, plan: AppActionPlan): string[] {
  return findMissingCoverage(message, plan).map(
    (surface) => `The user appears to request ${surface.label}, but no ${surface.actions.join(" or ")} step is present.`,
  );
}

function inferRequestedAgentCount(message: string): number {
  const countMatch = message.match(/\b(\d{1,2})\s+(?:people|person|agents?|members?|researchers?|analysts?|workers?)\b/i);
  const teamCountMatch = message.match(/\b(\d{1,2})[-\s]*(?:person|member|agent|ai)?\s+team\b/i);
  const raw = countMatch?.[1] ?? teamCountMatch?.[1];
  return raw ? Math.max(1, Math.min(Number.parseInt(raw, 10), 10)) : 3;
}

function uniqueStepId(plan: AppActionPlan | { steps: AppActionStep[] }, preferred: string): string {
  const existing = new Set(plan.steps.map((step) => step.id));
  if (!existing.has(preferred)) return preferred;
  for (let index = 2; index < 50; index += 1) {
    const candidate = `${preferred}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${preferred}-${Date.now().toString(36)}`;
}

function includesEntityName(message: string, name: string): boolean {
  const normalizedMessage = message.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return normalizedName.length > 0 && ` ${normalizedMessage} `.includes(` ${normalizedName} `);
}

function extractQuotedValues(message: string): string[] {
  return Array.from(message.matchAll(/["']([^"']{1,120})["']/g))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function inferNewOrganizationName(message: string): string | null {
  const match = message.match(
    /\b(?:new\s+)?(?:org(?:anization)?|team|crew|department)\s+(?:called|named)\s+["']?(.+?)["']?(?:\s*$|[,.]|\s+and\b)/i,
  );
  return match?.[1]?.trim() || null;
}

function inferExistingOrganizationName(message: string): string | null {
  const quotedAfterEntity = message.match(
    /\b(?:org(?:anization)?|team|crew|department)\s+["']([^"']{1,120})["']/i,
  );
  if (quotedAfterEntity?.[1]?.trim()) return quotedAfterEntity[1].trim();

  const toEntity = message.match(
    /\b(?:to|into|in)\s+(?:the\s+)?(?:org(?:anization)?|team|crew|department)\s+(?:called\s+|named\s+)?["']?(.+?)["']?(?:\s*$|[,.]|\s+and\b)/i,
  );
  const value = toEntity?.[1]?.trim();
  return value && !/\b(?:new|called|named)\b/i.test(value) ? value : null;
}

function buildExistingAgentAssignmentPlan(
  message: string,
  ctx: CompactContext,
): AppActionPlan | null {
  const assignmentIntent =
    /\b(?:add|assign|put|move|place|include)\b[\s\S]{0,100}\b(?:org(?:anization)?|hierarchy|team|crew|department)\b/i.test(message) ||
    /\b(?:org(?:anization)?|hierarchy|team|crew|department)\b[\s\S]{0,100}\b(?:add|assign|put|move|place|include)\b/i.test(message);
  if (!assignmentIntent) return null;

  const namedOrg = ctx.orgs.find((org) => includesEntityName(message, org.name)) ?? null;
  const explicitOrganizationName = namedOrg?.name ?? inferExistingOrganizationName(message);
  const activeOrgRequested = /\b(?:active|current)\s+org(?:anization)?\b/i.test(message);
  const targetOrg = namedOrg ?? (activeOrgRequested ? ctx.activeOrg : null);
  const newOrgRequested =
    !targetOrg &&
    (/\b(?:create|make|build|set\s*up|setup)\b[\s\S]{0,50}\b(?:org(?:anization)?|team|crew|department)\b/i.test(message) ||
      /\bnew\s+(?:org(?:anization)?|team|crew|department)\b/i.test(message));
  if (!targetOrg && !newOrgRequested && !explicitOrganizationName) return null;

  const agents = ctx.agents.filter((agent) => agent.isActive && includesEntityName(message, agent.name));
  const agentIds = agents.map((agent) => agent.id);
  const matchedAgentNames = agents.map((agent) => agent.name);
  const quotedAgentNames = extractQuotedValues(message).filter((value) => {
    if (explicitOrganizationName && value.toLowerCase() === explicitOrganizationName.toLowerCase()) return false;
    if (matchedAgentNames.some((name) => name.toLowerCase() === value.toLowerCase())) return false;
    return true;
  });
  const agentNames = matchedAgentNames.length > 0 ? matchedAgentNames : quotedAgentNames;
  if (agentIds.length === 0 && agentNames.length === 0) return null;

  if (targetOrg || explicitOrganizationName) {
    const orgLabel = targetOrg?.name ?? explicitOrganizationName ?? "the requested organization";
    return {
      version: 1,
      confidence: targetOrg && agentIds.length > 0 ? 0.99 : 0.92,
      userIntent: `Assign ${agentNames.join(", ")} to ${orgLabel}.`,
      requiresConfirmation: true,
      assumptions: [
        targetOrg && agentIds.length > 0
          ? "Matched the named existing agent and organization from current app state; no duplicate agent will be created."
          : "Will resolve the named agent and organization at execution time; no duplicate agent will be created.",
      ],
      steps: [
        {
          id: "assign-agents",
          action: "assign_agents_to_organization",
          label: `Add ${agentNames.join(", ")} to ${orgLabel}`,
          params: {
            ...(targetOrg ? { organizationId: targetOrg.id } : { organizationName: explicitOrganizationName }),
            ...(agentIds.length > 0 ? { agentIds } : { agentNames }),
          },
        },
      ],
    };
  }

  const organizationName = inferNewOrganizationName(message);
  return {
    version: 1,
    confidence: 0.96,
    userIntent: `Create ${organizationName || "a new organization"} and assign ${agentNames.join(", ")} to it.`,
    requiresConfirmation: true,
    assumptions: [
      "Matched the named existing agent from current app state; no duplicate agent will be created.",
      ...(organizationName ? [] : ["No organization name was provided, so the app will generate one."]),
    ],
    steps: [
      {
        id: "org",
        action: "create_organization",
        label: `Create ${organizationName || "a new organization"}`,
        params: { name: organizationName, memberIds: [], activate: true },
      },
      {
        id: "assign-agents",
        action: "assign_agents_to_organization",
        label: `Add ${agentNames.join(", ")} to the new organization`,
        params: { organizationStepId: "org", agentIds },
        dependsOn: ["org"],
      },
    ],
  };
}

function withRequestedAgentAndOrganizationSteps(plan: AppActionPlan, message: string): AppActionPlan {
  const missing = new Set(findMissingCoverage(message, plan).map((surface) => surface.id));
  if (!missing.has("agents") && !missing.has("organization")) return plan;

  let steps = [...plan.steps];
  let assumptions = [...plan.assumptions];
  let agentStep = steps.find((step) => step.action === "create_agents" || step.action === "create_agent");

  if (missing.has("agents")) {
    const id = uniqueStepId({ steps }, "agents");
    agentStep = {
      id,
      action: "create_agents",
      label: "Create the requested agent team",
      params: { count: inferRequestedAgentCount(message), purpose: "requested multi-step work" },
    };
    steps = [agentStep, ...steps];
    assumptions = [...assumptions, "Agent/team wording was included as an editable agent creation step."];
  }

  if (missing.has("organization")) {
    const id = uniqueStepId({ steps }, "org");
    const orgStep = {
      id,
      action: "create_organization" as const,
      label: "Create the requested organization structure",
      params: {
        name: null,
        ...(agentStep ? { memberStepId: agentStep.id } : {}),
        activate: true,
      },
      dependsOn: agentStep ? [agentStep.id] : undefined,
    };
    const insertAfterAgent = agentStep ? steps.findIndex((step) => step.id === agentStep?.id) + 1 : 0;
    steps = [...steps.slice(0, insertAfterAgent), orgStep, ...steps.slice(insertAfterAgent)];
    assumptions = [...assumptions, "Organization/hierarchy wording was included as an editable organization step."];
  }

  return { ...plan, assumptions, steps };
}

function withRequestedSkillAndExtensionSteps(plan: AppActionPlan, message: string): AppActionPlan {
  const skillIds = inferRequestedSkillIds(message);
  const extensionIds = inferRequestedExtensionIds(message);
  if (skillIds.length === 0 && extensionIds.length === 0) return plan;

  const agentStep = plan.steps.find((step) => step.action === "create_agents" || step.action === "create_agent");
  if (!agentStep) return plan;

  const existingSkillIds = new Set(
    plan.steps
      .filter((step) => step.action === "assign_skill_to_agent")
      .map((step) => normalizeSkillId(step.params.skillId)),
  );
  const existingExtensionIds = new Set(
    plan.steps
      .filter((step) => step.action === "attach_extension_to_agent")
      .map((step) => normalizeExtensionId(step.params.extensionId)),
  );

  const additions = [
    ...skillIds
      .filter((skillId) => !existingSkillIds.has(normalizeSkillId(skillId)))
      .map((skillId) => ({
        id: `skill-${skillId.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`,
        action: "assign_skill_to_agent" as const,
        label: `Assign ${skillId} skill to the created agent team`,
        params: { agentStepId: agentStep.id, skillId },
        dependsOn: [agentStep.id],
      })),
    ...extensionIds
      .filter((extensionId) => !existingExtensionIds.has(normalizeExtensionId(extensionId)))
      .map((extensionId) => ({
        id: `extension-${extensionId.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`,
        action: "attach_extension_to_agent" as const,
        label: `Attach ${extensionId} extension to the created agent team`,
        params: { agentStepId: agentStep.id, extensionId },
        dependsOn: [agentStep.id],
      })),
  ];
  if (additions.length === 0) return plan;

  const insertAfter = plan.steps.findIndex((step) => step.id === agentStep.id);
  const steps = [
    ...plan.steps.slice(0, insertAfter + 1),
    ...additions,
    ...plan.steps.slice(insertAfter + 1),
  ];
  return {
    ...plan,
    assumptions: [
      ...plan.assumptions,
      "Explicit skill and extension mentions are included as editable assignment steps.",
    ],
    steps,
  };
}

function inferRequestedWorkflow(message: string): { templateKey: string; name: string; schedule?: string } | null {
  const normalized = message.toLowerCase();
  const hasDigestOrReportRequest = /\b(?:reminder|digest|briefing|report|summary|summar(?:y|ize|ise)|recap|roundup|news|latest|current|updates?)\b/.test(normalized);
  const hasResearchSubject = /\b(?:research|web|internet|news|latest|current|sources?|articles?|summar(?:y|ize|ise)|report|digest|briefing|recap|roundup)\b/.test(normalized);
  const hasWorkflowRequest =
    /\b(?:workflow|flow|pipeline|automation)\b/.test(normalized) ||
    (/\b(?:daily|weekly|scheduled?|recurring|cron)\b/.test(normalized) &&
      /\b(?:check|monitor|watch|review|report|summary|summar(?:y|ize|ise)|digest|briefing|recap|roundup|news|updates?)\b/.test(normalized)) ||
    (/\b(?:remind|reminder|send\s+me|tell\s+me|notify|prepare|give\s+me)\b/.test(normalized) && hasDigestOrReportRequest) ||
    /\b(?:monitoring|monitor|watch|keep\s+an\s+eye\s+on)\b/.test(normalized);
  if (!hasWorkflowRequest) return null;

  const hasWriteVerb = /\b(?:create|make|build|need|want|set\s+up|setup|prepare|add|schedule|organize|watch|monitor|keep\s+an\s+eye\s+on|automate|remind|send\s+me|tell\s+me|notify|give\s+me)\b/.test(normalized);
  if (!hasWriteVerb) return null;

  const templateKey = hasDigestOrReportRequest && hasResearchSubject
    ? /\b(?:latest|current|news|web|internet|sources?|articles?)\b/.test(normalized)
      ? "live-research-assistant"
      : "research-assistant"
    : /\b(?:api|endpoint|service|services)\b/.test(normalized)
    ? "api-monitor"
    : /\b(?:document|docs?|pdfs?|extract|notes?)\b/.test(normalized)
      ? "document-intelligence"
      : "scheduled-health-check";
  const timeMatch = message.match(/\b(?:at|around|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/i);
  const timeText = timeMatch
    ? `${timeMatch[1]}${timeMatch[2] ? `:${timeMatch[2]}` : ""}${timeMatch[3].replace(/\./g, "").toLowerCase()}`
    : undefined;
  const scheduleBase = /\bweekly|every\s+week\b/.test(normalized)
    ? "weekly"
    : /\bdaily|every\s+day|each\s+day|every\s+morning|monitoring\b/.test(normalized)
      ? "daily"
      : /\bschedule|scheduled|recurring|cron\b/.test(normalized)
        ? "recurring"
        : undefined;
  const schedule = scheduleBase && timeText ? `${scheduleBase} ${timeText}` : scheduleBase;
  const name = hasDigestOrReportRequest && hasResearchSubject
    ? /\bai\s+agents?\b|\bagentic\b|\bllm\b/i.test(message)
      ? "AI Agent News Digest"
      : /\bnews\b/.test(normalized)
        ? "News Digest"
        : "Research Summary Digest"
    : /\b(?:api|endpoint|service|services)\b/.test(normalized)
    ? "API Monitor"
    : /\b(?:document|docs?|pdfs?|extract|notes?)\b/.test(normalized)
      ? "Document Intelligence Workflow"
      : /\bmonitoring|monitor|watch\b/.test(normalized)
        ? "Daily Monitoring Workflow"
        : "Scheduled Health Check";

  return { templateKey, name, schedule };
}

function isDigestWorkflow(workflow: { templateKey: string; name: string; schedule?: string } | null): workflow is { templateKey: string; name: string; schedule?: string } {
  return Boolean(workflow && /(?:research|digest|news|summary)/i.test(`${workflow.templateKey} ${workflow.name}`));
}

function hasExplicitAgentCreationRequest(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    /\b(?:create|make|build|set\s+up|setup|add|form|assemble|spin\s+up|organize)\s+(?:a\s+|an\s+|the\s+)?(?:\d+\s+)?(?:agents?|assistants?|workers?|people|members?|team|crew)\b/.test(normalized) ||
    /\b(?:team|crew|org(?:anization)?|hierarchy)\s+(?:of|with)\s+(?:\d+\s+)?(?:agents?|assistants?|workers?|people|members?)\b/.test(normalized) ||
    /\b(?:put|save|assign)\s+(?:them|the\s+agents?|agents?)\s+(?:in|into|to)\s+(?:a\s+)?(?:team|org(?:anization)?|crew|hierarchy)\b/.test(normalized)
  );
}

function sanitizeDigestPlan(plan: AppActionPlan, message: string): AppActionPlan {
  const workflow = inferRequestedWorkflow(message);
  if (!isDigestWorkflow(workflow) || hasExplicitAgentCreationRequest(message)) return plan;
  if (!plan.steps.some((step) => step.action === "create_workflow_from_template")) return plan;

  const removableActions = new Set<AppActionKind>([
    "create_agent",
    "create_agents",
    "create_organization",
    "assign_agents_to_organization",
    "assign_skill_to_agent",
    "attach_extension_to_agent",
  ]);
  const removedIds = new Set(plan.steps.filter((step) => removableActions.has(step.action)).map((step) => step.id));
  if (removedIds.size === 0) return plan;

  const steps = plan.steps
    .filter((step) => !removedIds.has(step.id))
    .map((step) => {
      const dependsOn = step.dependsOn?.filter((id) => !removedIds.has(id));
      return { ...step, dependsOn: dependsOn && dependsOn.length > 0 ? dependsOn : undefined };
    });

  return normalizeAppActionParams({
    ...plan,
    assumptions: [
      ...plan.assumptions.filter((assumption) => !/agent\/team wording was included/i.test(assumption)),
      "The request is treated as a scheduled digest/report workflow; agent/team creation is omitted unless explicitly requested.",
    ],
    steps,
  });
}

function withRequestedWorkflowSteps(plan: AppActionPlan, message: string): AppActionPlan {
  const workflow = inferRequestedWorkflow(message);
  if (!workflow) return plan;

  const existingWorkflowStep = plan.steps.find((step) => step.action === "create_workflow_from_template");
  const hasWorkflowStep = Boolean(existingWorkflowStep);
  const hasScheduleStep = plan.steps.some((step) => step.action === "schedule_workflow");
  if (hasWorkflowStep && (hasScheduleStep || !workflow.schedule)) return plan;

  const orgStep = plan.steps.find((step) => step.action === "create_organization");
  const agentStep = plan.steps.find((step) => step.action === "create_agents" || step.action === "create_agent");
  const workflowStepId = existingWorkflowStep?.id || "workflow";
  const additions = [
    ...(hasWorkflowStep
      ? []
      : [
          {
            id: workflowStepId,
            action: "create_workflow_from_template" as const,
            label: `Create ${workflow.name}`,
            params: { templateKey: workflow.templateKey, name: workflow.name },
            dependsOn: orgStep ? [orgStep.id] : agentStep ? [agentStep.id] : undefined,
          },
        ]),
    ...(workflow.schedule && !hasScheduleStep
      ? [
          {
            id: "schedule",
            action: "schedule_workflow" as const,
            label: `Prepare ${workflow.name} for ${workflow.schedule} scheduling`,
            params: { workflowStepId, schedule: workflow.schedule },
            dependsOn: [workflowStepId],
          },
        ]
      : []),
  ];
  if (additions.length === 0) return plan;

  const boardIndex = plan.steps.findIndex((step) => step.action === "create_board_task");
  const insertIndex = boardIndex >= 0 ? boardIndex : plan.steps.length;
  return {
    ...plan,
    assumptions: [
      ...plan.assumptions,
      "Workflow wording was included as editable workflow setup steps.",
    ],
    steps: [
      ...plan.steps.slice(0, insertIndex),
      ...additions,
      ...plan.steps.slice(insertIndex),
    ],
  };
}

function inferRequestedCouncilTopic(message: string): string | null {
  const normalized = message.toLowerCase();
  if (!/\b(?:council|debate|argue|argument|discuss|deliberat|vote|verdict|decision|decide|consensus)\b/.test(normalized)) {
    return null;
  }
  const topicMatch = message.match(
    /\b(?:council\s+(?:about|on)|debate|argue(?:\s+through|\s+about|\s+over)?|discuss|deliberate(?:\s+on)?|vote\s+on|decide(?:\s+on|\s+between)?|make\s+(?:a\s+)?decision\s+(?:on|about))\s+(.+?)(?:,\s+and|\s+and\s+(?:create|add|track|save|put|make|schedule|notify|connect|keep)|$)/i,
  );
  if (topicMatch?.[1]?.trim()) return topicMatch[1].trim();

  const researchTopicMatch = message.match(
    /\b(?:research|investigate|compare|evaluate)\s+(.+?)(?:,\s*have\s+them\s+decide|,\s*let\s+them\s+decide|\s+and\s+have\s+them\s+decide|\s+and\s+let\s+them\s+decide|,\s*then\s+decide|$)/i,
  );
  return researchTopicMatch?.[1]?.trim() || "the requested decision";
}

function hasRichCouncilControlRequest(message: string): boolean {
  const normalized = message.toLowerCase();
  if (!/\b(?:council|debate|argue|argument|discuss|deliberat|vote|verdict|decision|decide|consensus)\b/.test(normalized)) {
    return false;
  }
  return /\b(?:poll|debate|rounds?|majority|consensus|weighted|ranked|options?|choose\s+between|moderator|moderate|synthesis|synthesizer|sources?|documents?|docs?|files?|brief|goal|cost\s+cap|budget\s+cap|verdict\s+task|task\s+from\s+verdict|follow[-\s]?ups?\s+from\s+(?:concerns|dissent)|concerns|dissent)\b/i.test(message);
}

function extractCouncilOptions(message: string): string[] {
  const match = message.match(
    /\b(?:whether\s+we\s+should|whether\s+to|between|choose\s+between|decide\s+between)\s+(.+?)(?:,\s*(?:use|with|and\s+use|and\s+create|then|while|for)\b|\s+and\s+(?:create|use|track|make|put|save)\b|$)/i,
  );
  const raw = match?.[1]?.trim();
  if (!raw) return [];
  const normalized = raw
    .replace(/\bor\b/gi, ",")
    .replace(/\band\b/gi, ",")
    .split(",")
    .map((option) => option.trim().replace(/[.;:]+$/g, ""))
    .filter((option) => option.length > 1 && option.length <= 120);
  const seen = new Set<string>();
  const options: string[] = [];
  for (const option of normalized) {
    const key = option.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(option);
    if (options.length >= 8) break;
  }
  return options.length >= 2 ? options : [];
}

function inferCouncilControlsFromMessage(message: string): Record<string, unknown> {
  const lower = message.toLowerCase();
  const params: Record<string, unknown> = {};
  if (/\bpoll\b/i.test(message)) params.mode = "poll";
  if (/\b(?:debate|rounds?|argue|deliberat)\b/i.test(message)) params.mode = "debate";

  const roundsMatch = message.match(/\b([2-5])\s*(?:round|rounds)\b/i);
  if (roundsMatch?.[1]) {
    params.rounds = Number(roundsMatch[1]);
    params.mode = "debate";
  }

  if (/\branked(?:\s+choice)?\b/i.test(message)) params.decisionMode = "ranked";
  else if (/\bweighted\b/i.test(message)) params.decisionMode = "weighted";
  else if (/\bconsensus\b/i.test(message)) params.decisionMode = "consensus";
  else if (/\bmajority\b/i.test(message)) params.decisionMode = "majority";

  const options = extractCouncilOptions(message);
  if (options.length >= 2) params.options = options;

  if (/\b(?:goal\s+documents?|goal\s+docs?|linked\s+(?:sources?|documents?|docs?))\b/i.test(message)) {
    params.useGoalDocuments = true;
  }
  if (/\b(?:documents?|docs?|sources?|brief|files?)\b/i.test(message) && /\b(?:use|attach|ground|with|from|include)\b/i.test(message)) {
    params.useGoalDocuments = params.useGoalDocuments ?? true;
  }

  const costMatch = message.match(/\b(?:cost|budget)\s+cap\s+(?:of\s+)?\$?([0-9]+(?:\.[0-9]+)?)/i);
  if (costMatch?.[1]) params.costCapUsd = Number(costMatch[1]);

  if (/\b(?:moderator|moderate|synthesis|synthesizer)\b/i.test(message)) {
    params.useModeratorSynthesis = true;
  }
  if (/\b(?:discover|propose|generate)\s+(?:the\s+)?options\b/i.test(message)) {
    params.discoverOptions = true;
  }
  if (/\b(?:do\s+not|don't)\s+(?:discover|propose|generate)\s+(?:the\s+)?options\b/i.test(message)) {
    params.discoverOptions = false;
  }
  if (/\b(?:task|card|todo)\b[\s\S]{0,80}\b(?:verdict|decision|outcome|result)\b/i.test(message) ||
      /\b(?:verdict|decision|outcome|result)\b[\s\S]{0,80}\b(?:task|card|todo)\b/i.test(message)) {
    params.createBoardTaskFromVerdict = true;
  }
  if (/\bfollow[-\s]?ups?\b[\s\S]{0,80}\b(?:concerns?|dissent|risks?)\b/i.test(message) ||
      /\b(?:concerns?|dissent|risks?)\b[\s\S]{0,80}\bfollow[-\s]?ups?\b/i.test(message)) {
    params.createFollowUpTasksFromConcerns = true;
  }

  return Object.keys(params).length > 0 && /\b(?:council|debate|argue|argument|discuss|deliberat|vote|verdict|decision|decide|consensus)\b/.test(lower)
    ? params
    : {};
}

function withRequestedCouncilStep(plan: AppActionPlan, message: string): AppActionPlan {
  const topic = inferRequestedCouncilTopic(message);
  if (!topic) return plan;
  if (plan.steps.some((step) => step.action === "run_council")) return plan;

  const orgStep = plan.steps.find((step) => step.action === "create_organization");
  const agentStep = plan.steps.find((step) => step.action === "create_agents" || step.action === "create_agent");
  if (!orgStep && !agentStep) return plan;

  const councilStep = {
    id: "council",
    action: "run_council" as const,
    label: `Prepare a council debate on ${topic}`,
    params: {
      topic,
      ...(orgStep ? { organizationStepId: orgStep.id } : {}),
      ...(agentStep ? { agentStepId: agentStep.id } : {}),
      ...inferCouncilControlsFromMessage(message),
    },
    dependsOn: orgStep ? [orgStep.id] : agentStep ? [agentStep.id] : undefined,
  };

  const boardIndex = plan.steps.findIndex((step) => step.action === "create_board_task");
  const insertIndex = boardIndex >= 0 ? boardIndex : plan.steps.length;
  const steps = [
    ...plan.steps.slice(0, insertIndex),
    councilStep,
    ...plan.steps.slice(insertIndex).map((step) => {
      if (step.action !== "create_board_task") return step;
      const dependsOn = new Set(step.dependsOn || []);
      dependsOn.add(councilStep.id);
      return { ...step, dependsOn: Array.from(dependsOn) };
    }),
  ];

  return {
    ...plan,
    assumptions: [
      ...plan.assumptions,
      "Council/debate wording was included as an editable council step.",
    ],
    steps,
  };
}

function withCouncilControlsFromMessage(plan: AppActionPlan, message: string): AppActionPlan {
  const controls = inferCouncilControlsFromMessage(message);
  if (Object.keys(controls).length === 0) return plan;
  let changed = false;
  const steps = plan.steps.map((step) => {
    if (step.action !== "run_council") return step;
    changed = true;
    return {
      ...step,
      params: {
        ...step.params,
        ...controls,
      },
    };
  });
  if (!changed) return plan;
  return {
    ...plan,
    assumptions: plan.assumptions.some((assumption) => /Council controls were preserved/i.test(assumption))
      ? plan.assumptions
      : [...plan.assumptions, "Council controls were preserved from the user request."],
    steps,
  };
}

function inferRequestedBoardTask(message: string): { title: string; description: string } | null {
  const normalized = message.toLowerCase();
  const hasBoardRequest = /\b(?:board|task|card|todo|follow[-\s]?up|track|tracking|record)\b/.test(normalized);
  const hasWriteIntent = /\b(?:create|make|add|put|track|record|save|log|capture)\b/.test(normalized);
  if (!hasBoardRequest || !hasWriteIntent) return null;

  const title =
    /\bdecision|verdict|outcome|result\b/.test(normalized)
      ? "Track decision outcome"
      : /\bfollow[-\s]?up\b/.test(normalized)
        ? "Track follow-up"
        : "Track requested action";
  return {
    title,
    description: "Created from the WebChat app-action plan to track the requested outcome.",
  };
}

function withRequestedBoardTaskStep(plan: AppActionPlan, message: string): AppActionPlan {
  const boardTask = inferRequestedBoardTask(message);
  if (!boardTask) return plan;
  if (plan.steps.some((step) => step.action === "create_board_task")) return plan;

  const orgStep = plan.steps.find((step) => step.action === "create_organization");
  const agentStep = plan.steps.find((step) => step.action === "create_agents" || step.action === "create_agent");
  const councilStep = plan.steps.find((step) => step.action === "run_council");
  const scheduleStep = plan.steps.find((step) => step.action === "schedule_workflow");
  const workflowStep = plan.steps.find((step) => step.action === "create_workflow_from_template");
  const dependsOn = [councilStep?.id, scheduleStep?.id, workflowStep?.id, orgStep?.id].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );

  const taskStep = {
    id: "board-task",
    action: "create_board_task" as const,
    label: boardTask.title,
    params: {
      boardId: "main-board",
      title: boardTask.title,
      description: boardTask.description,
      ...(orgStep ? { organizationStepId: orgStep.id } : {}),
      ...(agentStep ? { agentStepId: agentStep.id } : {}),
    },
    dependsOn: dependsOn.length > 0 ? Array.from(new Set(dependsOn)) : undefined,
  };

  return {
    ...plan,
    assumptions: [
      ...plan.assumptions,
      "Board tracking wording was included as an editable board task step.",
    ],
    steps: [...plan.steps, taskStep],
  };
}

function inferRequestedChannel(message: string): string | null {
  const normalized = message.toLowerCase();
  const channelMatch = normalized.match(/\b(telegram|slack|discord|whatsapp|webchat|bluebubbles|imessage|i\s*message|teams|microsoft\s+teams|google\s+chat|gchat)\b/)?.[1];
  const channel = channelMatch ? normalizeChannelId(channelMatch) : null;
  if (!channel) return null;
  if (!/\b(?:connect(?:ed|ion)?|channel|alert|alerts|notify|notification|updates?|send|reply|tell me|setup|set\s+up|prepare|finish)\b/.test(normalized)) return null;
  return channel;
}

function buildCouncilConcernBoardFallbackPlan(message: string): AppActionPlan | null {
  const normalized = message.toLowerCase();
  const wantsCouncil = /\b(?:council|debate|argue|argument|discuss|deliberat|vote|verdict|decision|decide|consensus)\b/.test(normalized);
  const wantsBoardTracking = /\b(?:board|tasks?|cards?|todos?|kanban|track|tracking|record|capture|follow[-\s]?ups?)\b/.test(normalized);
  const concernDriven = /\b(?:concerns?|risks?|dissent|objections?|blockers?|mitigations?|follow[-\s]?ups?)\b/.test(normalized);
  if (!wantsCouncil || !wantsBoardTracking || !concernDriven) return null;

  const topic = inferRequestedCouncilTopic(message) ?? "the requested topic";
  return {
    version: 1,
    confidence: 0.78,
    userIntent: `Run a council on ${topic} and track the concerns on the board.`,
    requiresConfirmation: true,
    assumptions: [
      "No organization was specified, so the active organization will be used if one is available.",
      "Council concerns will be represented as editable board follow-up work before any side effects run.",
    ],
    steps: [
      {
        id: "council",
        action: "run_council",
        label: `Run council on ${topic}`,
        params: {
          topic,
          boardId: "main-board",
          createFollowUpTasksFromConcerns: true,
          ...inferCouncilControlsFromMessage(message),
        },
      },
      {
        id: "board-task",
        action: "create_board_task",
        label: "Track council concerns",
        params: {
          boardId: "main-board",
          title: "Track council concerns",
          description: "Review the council concerns, risks, and objections, then turn them into mitigation tasks.",
        },
        dependsOn: ["council"],
      },
    ],
  };
}

function withRequestedChannelStep(plan: AppActionPlan, message: string): AppActionPlan {
  const channel = inferRequestedChannel(message);
  if (!channel) return plan;
  if (plan.steps.some((step) => step.action === "connect_channel" && normalizeChannelId(step.params.channel) === channel)) return plan;

  const channelStep = {
    id: `channel-${channel}`,
    action: "connect_channel" as const,
    label: `Prepare ${channel} channel setup guidance`,
    params: { channel },
  };
  const workflowIndex = plan.steps.findIndex((step) => step.action === "create_workflow_from_template");
  const boardIndex = plan.steps.findIndex((step) => step.action === "create_board_task");
  const indexes = [workflowIndex, boardIndex].filter((index) => index >= 0);
  const insertIndex = indexes.length > 0 ? Math.min(...indexes) : plan.steps.length;

  return {
    ...plan,
    assumptions: [
      ...plan.assumptions,
      "Channel wording was included as an editable channel setup step.",
    ],
    steps: [
      ...plan.steps.slice(0, insertIndex),
      channelStep,
      ...plan.steps.slice(insertIndex),
    ],
  };
}

function hasExplicitCouncilRequest(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    /\b(?:council|debate|argue|argument|deliberat|vote|verdict|consensus)\b/.test(normalized) ||
    /\b(?:have|let|ask|get|run|make)\s+(?:them|some\s+agents?|the\s+agents?|agents?|the\s+org(?:anization)?|the\s+team|the\s+crew|the\s+council)\s+(?:to\s+)?(?:decide|discuss|debate|deliberate|vote|choose|pick)\b/.test(normalized) ||
    /\bdecision\s+(?:meeting|council|vote|panel)\b/.test(normalized)
  );
}

function sanitizeUnrequestedCouncilSteps(plan: AppActionPlan, message: string): AppActionPlan {
  if (hasExplicitCouncilRequest(message)) return plan;
  const councilIds = new Set(plan.steps.filter((step) => step.action === "run_council").map((step) => step.id));
  if (councilIds.size === 0) return plan;
  return normalizeAppActionParams({
    ...plan,
    assumptions: plan.assumptions.filter((assumption) => !/\bcouncil|debate|deliberat|verdict|vote\b/i.test(assumption)),
    steps: plan.steps
      .filter((step) => !councilIds.has(step.id))
      .map((step) => {
        const dependsOn = step.dependsOn?.filter((id) => !councilIds.has(id));
        return { ...step, dependsOn: dependsOn && dependsOn.length > 0 ? dependsOn : undefined };
      }),
  });
}

function sanitizeUnrequestedWorkflowMutationSteps(plan: AppActionPlan, message: string): AppActionPlan {
  const allowNodeEdits = isWorkflowNodeEditMutationIntent(message);
  const allowLifecycle = isWorkflowActivationMutationIntent(message);
  const removedIds = new Set(
    plan.steps
      .filter((step) => {
        if ((step.action === "update_workflow_node" || step.action === "set_workflow_node_model") && !allowNodeEdits) return true;
        if (step.action === "toggle_workflow_active" && !allowLifecycle) return true;
        return false;
      })
      .map((step) => step.id),
  );
  if (removedIds.size === 0) return plan;
  return normalizeAppActionParams({
    ...plan,
    assumptions: [
      ...plan.assumptions,
      "Unrequested workflow node-edit/lifecycle actions were removed; plain workflow creation stays to create/schedule/channel/board steps only.",
    ],
    steps: plan.steps
      .filter((step) => !removedIds.has(step.id))
      .map((step) => {
        const dependsOn = step.dependsOn?.filter((id) => !removedIds.has(id));
        return { ...step, dependsOn: dependsOn && dependsOn.length > 0 ? dependsOn : undefined };
      }),
  });
}

function sanitizeFocusedWorkflowMutationPlan(plan: AppActionPlan, message: string): AppActionPlan {
  const allowNodeEdits = isWorkflowNodeEditMutationIntent(message);
  const allowLifecycle = isWorkflowActivationMutationIntent(message);
  if (!allowNodeEdits && !allowLifecycle) return plan;

  const allowed = new Set<AppActionKind>([
    ...(allowNodeEdits ? ["update_workflow_node", "set_workflow_node_model"] as AppActionKind[] : []),
    ...(allowLifecycle ? ["toggle_workflow_active"] as AppActionKind[] : []),
    "ask_clarifying_question",
  ]);
  const removedIds = new Set(plan.steps.filter((step) => !allowed.has(step.action)).map((step) => step.id));
  if (removedIds.size === 0) return plan;
  return normalizeAppActionParams({
    ...plan,
    assumptions: [
      ...plan.assumptions,
      "This is an existing-workflow edit, so unrelated create-agent/create-workflow steps were removed.",
    ],
    steps: plan.steps
      .filter((step) => !removedIds.has(step.id))
      .map((step) => {
        const dependsOn = step.dependsOn?.filter((id) => !removedIds.has(id));
        return { ...step, dependsOn: dependsOn && dependsOn.length > 0 ? dependsOn : undefined };
      }),
  });
}

function augmentPlanFromMessage(plan: AppActionPlan, message: string): AppActionPlan {
  const focusedWorkflowMutation = isWorkflowNodeEditMutationIntent(message) || isWorkflowActivationMutationIntent(message);
  if (focusedWorkflowMutation) {
    return sanitizeFocusedWorkflowMutationPlan(
      sanitizeUnrequestedWorkflowMutationSteps(normalizeAppActionParams(plan), message),
      message,
    );
  }

  return sanitizeUnrequestedWorkflowMutationSteps(sanitizeUnrequestedCouncilSteps(
    normalizeAppActionParams(
      withCouncilControlsFromMessage(
        withRequestedChannelStep(
          withRequestedBoardTaskStep(
            withRequestedCouncilStep(
              withRequestedWorkflowSteps(
                withRequestedSkillAndExtensionSteps(
                  withRequestedAgentAndOrganizationSteps(plan, message),
                  message,
                ),
                message,
              ),
              message,
            ),
            message,
          ),
          message,
        ),
        message,
      ),
    ),
    message,
  ), message);
}

function clarificationPlan(question: string, choices: string[] = []): AppActionPlan {
  return {
    version: 1,
    confidence: 0.93,
    userIntent: "Clarify the target before editing workflow state.",
    requiresConfirmation: false,
    clarificationQuestion: question,
    clarificationChoices: choices.slice(0, 4),
    assumptions: [],
    steps: [],
  };
}

const WORKFLOW_AGENT_NODE_TYPES = new Set(["claude-agent", "integration-agent", "parallel-agents", "spawn-coding-agent"]);

function isGenericAgentNodeLabel(value: unknown): boolean {
  return /^(?:agent|agents|agent\s+node|agent\s+nodes|model|model\s+node)$/i.test(String(value || "").trim());
}

function normalizeGenericWorkflowModelTargets(plan: AppActionPlan): AppActionPlan {
  let changed = false;
  const steps = plan.steps.map((step) => {
    if (step.action !== "set_workflow_node_model" || !isGenericAgentNodeLabel(step.params.nodeLabel)) return step;

    const workflowId = typeof step.params.workflowId === "string" ? step.params.workflowId.trim() : "";
    const workflowName = typeof step.params.workflowName === "string" ? step.params.workflowName.trim() : "";
    const resolved = workflowId ? resolveWorkflow({ id: workflowId }) : workflowName ? resolveWorkflow({ name: workflowName }) : null;
    const agentNodes = resolved?.workflow?.nodes.filter((node) => WORKFLOW_AGENT_NODE_TYPES.has(node.type)) ?? [];
    if (agentNodes.length !== 1) return step;

    changed = true;
    const target = agentNodes[0]!;
    return {
      ...step,
      params: {
        ...step.params,
        nodeId: target.id,
        nodeLabel: String(target.data?.label ?? target.id),
      },
    };
  });
  if (!changed) return plan;
  return {
    ...plan,
    assumptions: [
      ...plan.assumptions.filter((assumption) => !/\blabel(?:ed)? ['"]?agent['"]?/i.test(assumption)),
      "The generic 'agent node' target matched the only agent-capable node in the workflow.",
    ],
    steps,
  };
}

function preflightWorkflowEditAmbiguity(plan: AppActionPlan): AppActionPlan | null {
  const editSteps = plan.steps.filter((step) => step.action === "update_workflow_node" || step.action === "set_workflow_node_model");
  if (editSteps.length === 0) return null;

  try {
    for (const step of editSteps) {
      const params = step.params ?? {};
      const workflowId = typeof params.workflowId === "string" ? params.workflowId.trim() : "";
      const workflowName = typeof params.workflowName === "string" ? params.workflowName.trim() : "";
      if (!workflowId && !workflowName) {
        return clarificationPlan("Which workflow should I edit?");
      }

      const resolved = workflowId ? resolveWorkflow({ id: workflowId }) : resolveWorkflow({ name: workflowName });
      if (resolved.ambiguous.length > 1) {
        return clarificationPlan(
          `Multiple workflows match "${workflowName}". Which one should I edit?`,
          resolved.ambiguous.map((workflow) => workflow.name),
        );
      }
      if (!resolved.workflow) {
        return clarificationPlan(`I could not find a workflow named "${workflowName || workflowId}". Which workflow should I edit?`);
      }

      const nodeId = typeof params.nodeId === "string" ? params.nodeId.trim() : "";
      const nodeLabel = typeof params.nodeLabel === "string" ? params.nodeLabel.trim() : "";
      if (step.action === "set_workflow_node_model" && isGenericAgentNodeLabel(nodeLabel)) {
        const agentNodes = resolved.workflow.nodes.filter((node) => WORKFLOW_AGENT_NODE_TYPES.has(node.type));
        if (agentNodes.length > 1) {
          return clarificationPlan(
            `Multiple agent nodes in "${resolved.workflow.name}" could use that model. Which one should I edit?`,
            agentNodes.map((node) => `${String(node.data?.label ?? node.id)} (${node.type})`),
          );
        }
        if (agentNodes.length === 0) {
          return clarificationPlan(`I could not find an agent node in "${resolved.workflow.name}". Which node should I edit?`);
        }
      }
      if (step.action === "set_workflow_node_model" && !nodeId && !nodeLabel) {
        continue;
      }
      if (!nodeId && !nodeLabel) {
        return clarificationPlan(`Which node in "${resolved.workflow.name}" should I edit?`);
      }

      const nodeMatch = resolveNode(resolved.workflow.nodes, { nodeId: nodeId || undefined, nodeLabel: nodeLabel || undefined });
      if (nodeMatch.ambiguous.length > 1) {
        return clarificationPlan(
          `Multiple nodes in "${resolved.workflow.name}" match "${nodeLabel}". Which one should I edit?`,
          nodeMatch.ambiguous.map((node) => `${node.label} (${node.type})`),
        );
      }
      if (!nodeMatch.node) {
        return clarificationPlan(`I could not find a node matching "${nodeLabel || nodeId}" in "${resolved.workflow.name}". Which node should I edit?`);
      }
    }
  } catch (error) {
    log.debug("preflightWorkflowEditAmbiguity failed", { error: String(error) });
  }

  return null;
}

function buildCoverageFallbackPlan(message: string): AppActionPlan | null {
  const normalized = message.toLowerCase();
  if (!hasWriteSignal(message) || /\boptimi[sz](?:e|ing|ation)?\b/.test(normalized)) return null;

  const requested = new Set(detectRequestedCoverage(message).filter((surface) => surface.requested).map((surface) => surface.id));
  const meaningfulSurfaceCount = ["agents", "organization", "council", "workflow", "schedule", "board", "channel", "goal", "skills", "extensions"]
    .filter((surface) => requested.has(surface)).length;
  if (meaningfulSurfaceCount < 3) return null;

  const steps: AppActionStep[] = [];
  const assumptions: string[] = [
    "The model did not return a complete structured plan, so this fallback covers the requested app surfaces conservatively.",
  ];

  let agentStepId: string | undefined;
  let orgStepId: string | undefined;
  let workflowStepId: string | undefined;
  let councilStepId: string | undefined;

  if (requested.has("agents") || requested.has("skills") || requested.has("extensions")) {
    agentStepId = "agents";
    steps.push({
      id: agentStepId,
      action: "create_agents",
      label: "Create the requested agent team",
      params: {
        count: inferRequestedAgentCount(message),
        purpose: /\bapi|reliability|incident|support|triage\b/.test(normalized)
          ? "operations and reliability work"
          : "requested multi-step work",
      },
    });
  }

  if (requested.has("skills") && agentStepId) {
    for (const skillId of inferRequestedSkillIds(message)) {
      steps.push({
        id: uniqueStepId({ steps }, `skill-${skillId.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`),
        action: "assign_skill_to_agent",
        label: `Assign ${skillId} skill`,
        params: { agentStepId, skillId },
        dependsOn: [agentStepId],
      });
    }
  }

  if (requested.has("extensions") && agentStepId) {
    for (const extensionId of inferRequestedExtensionIds(message)) {
      steps.push({
        id: uniqueStepId({ steps }, `extension-${extensionId.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`),
        action: "attach_extension_to_agent",
        label: `Attach ${extensionId} extension`,
        params: { agentStepId, extensionId },
        dependsOn: [agentStepId],
      });
    }
  }

  if (requested.has("organization")) {
    orgStepId = "org";
    steps.push({
      id: orgStepId,
      action: "create_organization",
      label: "Create the requested organization structure",
      params: {
        name: /\bapi|reliability\b/.test(normalized)
          ? "API Reliability Team"
          : /\bsupport|triage\b/.test(normalized)
            ? "Support Triage Team"
            : null,
        ...(agentStepId ? { memberStepId: agentStepId } : {}),
        activate: true,
      },
      dependsOn: agentStepId ? [agentStepId] : undefined,
    });
  }

  if (requested.has("goal")) {
    steps.push({
      id: "goal",
      action: "create_goal",
      label: "Create the requested goal",
      params: {
        title: /\blaunch\b/.test(normalized) ? "Launch Goal" : "Requested Goal",
        ...(orgStepId ? { organizationStepId: orgStepId } : {}),
      },
      dependsOn: orgStepId ? [orgStepId] : undefined,
    });
  }

  if (requested.has("council") && (orgStepId || agentStepId)) {
    councilStepId = "council";
    steps.push({
      id: councilStepId,
      action: "run_council",
      label: "Run the requested council debate",
      params: {
        topic: inferRequestedCouncilTopic(message) || "the requested decision",
        ...(orgStepId ? { organizationStepId: orgStepId } : {}),
        ...(agentStepId ? { agentStepId } : {}),
      },
      dependsOn: orgStepId ? [orgStepId] : agentStepId ? [agentStepId] : undefined,
    });
  }

  if (requested.has("workflow")) {
    const workflow = inferRequestedWorkflow(message) || {
      templateKey: /\bapi|endpoint|service\b/.test(normalized) ? "api-monitor" : "scheduled-health-check",
      name: /\bapi|endpoint|service\b/.test(normalized) ? "API Reliability Workflow" : "Requested Workflow",
      schedule: requested.has("schedule") ? "recurring" : undefined,
    };
    workflowStepId = "workflow";
    steps.push({
      id: workflowStepId,
      action: "create_workflow_from_template",
      label: `Create ${workflow.name}`,
      params: { templateKey: workflow.templateKey, name: workflow.name },
      dependsOn: orgStepId ? [orgStepId] : agentStepId ? [agentStepId] : undefined,
    });
    if (requested.has("schedule") || workflow.schedule) {
      steps.push({
        id: "schedule",
        action: "schedule_workflow",
        label: `Prepare ${workflow.name} for scheduling`,
        params: { workflowStepId, schedule: workflow.schedule || "recurring" },
        dependsOn: [workflowStepId],
      });
    }
  }

  if (requested.has("channel")) {
    const channel = inferRequestedChannel(message);
    if (channel) {
      steps.push({
        id: `channel-${channel}`,
        action: "connect_channel",
        label: `Prepare ${channel} channel setup guidance`,
        params: { channel },
      });
    }
  }

  if (requested.has("board")) {
    steps.push({
      id: "board-task",
      action: "create_board_task",
      label: "Create the requested board follow-up",
      params: {
        boardId: "main-board",
        title: /\bapi|reliability\b/.test(normalized)
          ? "API reliability follow-up"
          : /\bdecision|verdict|outcome\b/.test(normalized)
            ? "Track decision outcome"
            : "Track requested follow-up",
        description: "Track the outcome and follow-up actions from this WebChat plan.",
        ...(orgStepId ? { organizationStepId: orgStepId } : {}),
        ...(agentStepId ? { agentStepId } : {}),
      },
      dependsOn: Array.from(new Set([councilStepId, workflowStepId, orgStepId].filter((id): id is string => Boolean(id)))),
    });
  }

  if (steps.length < 2) return null;
  return normalizeAppActionParams({
    version: 1,
    confidence: 0.61,
    userIntent: "Create a structured app plan for the requested multi-step work.",
    requiresConfirmation: steps.some((step) => !["recommend_templates", "summarize_state"].includes(step.action)),
    assumptions,
    steps,
  });
}

function hasMultiStepPlanningSignals(message: string): boolean {
  const normalized = message.toLowerCase();
  const surfaces = [
    /\bagents?|assistants?|workers?|people|members?\b/,
    /\bskills?\b/,
    /\bextensions?|plugins?|tools?\b/,
    /\borg(?:anization)?|company|hierarchy|team|crew|department\b/,
    /\bcouncil|debate|argue|argument|vote|verdict|decision|decide|deliberat|discuss\b/,
    /\bworkflow|pipeline|automation|template|monitor|check\b/,
    /\bschedule|daily|weekly|recurring|cron\b/,
    /\bboard|task|card|todo|follow[-\s]?up|track|record\b/,
    /\btelegram|slack|discord|whatsapp|teams|bluebubbles|webchat|channel|alerts?|notifications?\b/,
  ].filter((pattern) => pattern.test(normalized)).length;
  return surfaces >= 3 || /\b(?:and then|then|also|after that|followed by|once .* done)\b/.test(normalized);
}

type PlannerModelConfig = Pick<CallModelOptions, "provider" | "modelId" | "apiKey" | "baseUrl" | "fastMode"> & {
  temperature?: number;
};

async function repairPlanCoverageWithModel(args: {
  message: string;
  draftPlan: AppActionPlan;
  plannerContextMessage: string;
  coverageNotes?: string[];
  modelConfig: PlannerModelConfig;
  callModel: (options: CallModelOptions) => Promise<{ response: string }>;
}): Promise<AppActionPlan> {
  if (!hasMultiStepPlanningSignals(args.message)) return args.draftPlan;

  try {
    const result = await args.callModel({
      provider: args.modelConfig.provider,
      modelId: args.modelConfig.modelId,
      apiKey: args.modelConfig.apiKey,
      baseUrl: args.modelConfig.baseUrl,
      systemPrompt: buildRepairSystemPrompt(),
      userMessage: buildRepairUserMessage(
        args.message,
        args.draftPlan,
        args.plannerContextMessage,
        args.coverageNotes,
      ),
      maxTokens: 4000,
      temperature: 0,
      fastMode: args.modelConfig.fastMode,
    });
    const rawJson = extractJson(result.response);
    if (!rawJson) return args.draftPlan;
    const validation = validateAppActionPlan(coerceRawAppActionPlan(rawJson));
    if (!validation.success) {
      log.debug("planAppAction: coverage repair validation failed", { error: validation.error, rawJson });
      return args.draftPlan;
    }
    log.info("planAppAction: model coverage repair accepted", {
      originalStepCount: args.draftPlan.steps.length,
      repairedStepCount: validation.plan.steps.length,
    });
    return normalizeAppActionParams(validation.plan);
  } catch (err) {
    log.debug("planAppAction: model coverage repair failed", { error: String(err) });
    return args.draftPlan;
  }
}

async function repairInvalidPlanWithModel(args: {
  message: string;
  rawPlan: unknown;
  validationError: string;
  plannerContextMessage: string;
  modelConfig: PlannerModelConfig;
  callModel: (options: CallModelOptions) => Promise<{ response: string }>;
}): Promise<AppActionPlan | null> {
  try {
    const result = await args.callModel({
      provider: args.modelConfig.provider,
      modelId: args.modelConfig.modelId,
      apiKey: args.modelConfig.apiKey,
      baseUrl: args.modelConfig.baseUrl,
      systemPrompt: buildSchemaRepairSystemPrompt(),
      userMessage: buildSchemaRepairUserMessage({
        originalUserMessage: args.message,
        plannerContextMessage: args.plannerContextMessage,
        rawPlan: args.rawPlan,
        validationError: args.validationError,
      }),
      maxTokens: 4000,
      temperature: 0,
      fastMode: args.modelConfig.fastMode,
    });
    const rawJson = extractJson(result.response);
    if (!rawJson) return null;
    const validation = validateAppActionPlan(coerceRawAppActionPlan(rawJson));
    if (!validation.success) {
      log.debug("planAppAction: schema repair validation failed", { error: validation.error, rawJson });
      return null;
    }
    log.info("planAppAction: model schema repair accepted", {
      repairedStepCount: validation.plan.steps.length,
    });
    return normalizeAppActionParams(validation.plan);
  } catch (err) {
    log.debug("planAppAction: model schema repair failed", { error: String(err) });
    return null;
  }
}

function hasStrongMutationSignals(message: string): boolean {
  const n = message.toLowerCase();
  return (
    (/\b(?:create|make|add)\b/.test(n) && /\b(?:agents?|people|person)\b/.test(n)) ||
    /\b(?:create\s+(?:\d+\s+)?agent|make\s+(?:\d+\s+)?agent|add\s+(?:\d+\s+)?agent)\b/i.test(message)
  ) && (
    /\b(?:org|organization|team|company|crew)\b/.test(n) ||
    /\b(?:task|research|run|board|track)\b/.test(n)
  );
}

function extractWorkflowLifecycleTarget(message: string): { workflowName: string | null; active: boolean } | null {
  if (!isWorkflowActivationMutationIntent(message)) return null;
  const active = !/\b(?:deactivate|disable|turn\s+off)\b/i.test(message);
  const quoted =
    message.match(/["\u201C]([^"\u201D]+)["\u201D]\s+workflow/i)?.[1] ??
    message.match(/\bworkflow\s+(?:named|called)\s+["\u201C]?([^"\u201D.?!]+)["\u201D]?/i)?.[1] ??
    message.match(/\b(?:activate|enable|deactivate|disable|turn\s+(?:on|off))\s+(?:the\s+)?["\u201C]([^"\u201D]+)["\u201D](?:\s+workflow)?/i)?.[1];
  if (quoted?.trim()) return { workflowName: quoted.trim(), active };

  const beforeWorkflow = message.match(/\b(?:activate|enable|deactivate|disable|turn\s+(?:on|off))\s+(?:the\s+)?(.+?)\s+workflow\b/i)?.[1];
  if (beforeWorkflow?.trim()) {
    const cleaned = beforeWorkflow
      .replace(/^(?:the|my|our)\s+/i, "")
      .replace(/\s+(?:please|now)$/i, "")
      .trim();
    if (cleaned && !/^(?:workflow|it|this|that)$/i.test(cleaned)) return { workflowName: cleaned, active };
  }

  return { workflowName: null, active };
}

function buildHeuristicFallbackPlan(message: string): AppActionPlan | null {
  const normalized = message.toLowerCase();
  const countMatch = message.match(/\b(\d{1,2})\s+(?:people|person|agents?|members?|researchers?|analysts?)\b/i);
  const requestedCount = countMatch?.[1] ? Math.max(1, Math.min(Number.parseInt(countMatch[1], 10), 10)) : null;
  const teamCountMatch = message.match(/\b(\d{1,2})[-\s]*(?:person|member|agent|ai)?\s+team\b/i);
  const requestedTeamCount = requestedCount ?? (teamCountMatch?.[1] ? Math.max(1, Math.min(Number.parseInt(teamCountMatch[1], 10), 10)) : null);

  const requestedWorkflow = inferRequestedWorkflow(message);
  const lifecycleTarget = extractWorkflowLifecycleTarget(message);
  if (lifecycleTarget) {
    if (!lifecycleTarget.workflowName) {
      return {
        version: 1,
        confidence: 0.86,
        userIntent: lifecycleTarget.active ? "Activate a workflow." : "Deactivate a workflow.",
        requiresConfirmation: false,
        clarificationQuestion: `Which workflow should I ${lifecycleTarget.active ? "activate" : "deactivate"}?`,
        clarificationChoices: [],
        assumptions: [],
        steps: [],
      };
    }
    return {
      version: 1,
      confidence: 0.88,
      userIntent: `${lifecycleTarget.active ? "Activate" : "Deactivate"} workflow "${lifecycleTarget.workflowName}".`,
      requiresConfirmation: true,
      assumptions: ["Workflow activation changes runtime behavior and needs confirmation."],
      steps: [
        {
          id: "workflow-toggle",
          action: "toggle_workflow_active",
          label: `${lifecycleTarget.active ? "Activate" : "Deactivate"} workflow "${lifecycleTarget.workflowName}"`,
          params: { workflowName: lifecycleTarget.workflowName, active: lifecycleTarget.active },
        },
      ],
    };
  }
  if (isDigestWorkflow(requestedWorkflow) && requestedWorkflow.schedule && !hasExplicitAgentCreationRequest(message)) {
    const channel = inferRequestedChannel(message);
    return {
      version: 1,
      confidence: 0.74,
      userIntent: `Create and schedule ${requestedWorkflow.name}.`,
      requiresConfirmation: true,
      assumptions: [
        `Selected '${requestedWorkflow.templateKey}' as the closest workflow template for the requested digest/report.`,
        channel
          ? `The ${channel} channel must already be configured before summaries can be delivered there.`
          : "No delivery channel was named, so the summary is assumed to be delivered through the current WebChat/default app notification surface.",
      ],
      steps: [
        ...(channel
          ? [
              {
                id: `channel-${channel}`,
                action: "connect_channel" as const,
                label: `Prepare ${channel} channel setup guidance`,
                params: { channel },
              },
            ]
          : []),
        {
          id: "workflow",
          action: "create_workflow_from_template",
          label: `Create ${requestedWorkflow.name}`,
          params: { templateKey: requestedWorkflow.templateKey, name: requestedWorkflow.name },
          dependsOn: channel ? [`channel-${channel}`] : undefined,
        },
        {
          id: "schedule",
          action: "schedule_workflow",
          label: `Prepare ${requestedWorkflow.name} for ${requestedWorkflow.schedule} scheduling`,
          params: { workflowStepId: "workflow", schedule: requestedWorkflow.schedule },
          dependsOn: ["workflow"],
        },
      ],
    };
  }

  const councilConcernBoardFallback = buildCouncilConcernBoardFallbackPlan(message);
  if (councilConcernBoardFallback) return councilConcernBoardFallback;

  const coverageFallback = buildCoverageFallbackPlan(message);
  if (coverageFallback) return coverageFallback;

  if (
    /\b(?:turn\s+this\s+into|proper\s+operating\s+setup|operating\s+setup|end[-\s]?to[-\s]?end\s+setup|whole\s+setup)\b/.test(normalized) &&
    /\b(?:owners?|people|team|agents?|structure|hierarchy|org(?:anization)?)\b/.test(normalized) &&
    /\b(?:decision|debate|council|vote|verdict)\b/.test(normalized) &&
    /\b(?:automation|workflow|automate|pipeline)\b/.test(normalized) &&
    /\b(?:tracking|track|board|task|follow[-\s]?up)\b/.test(normalized)
  ) {
    return {
      version: 1,
      confidence: 0.75,
      userIntent: "Create a complete operating setup with owners, hierarchy, council decisioning, automation, and board tracking.",
      requiresConfirmation: true,
      assumptions: [
        "No exact team size was provided, so the app will create three owner agents.",
        "The hierarchy will be represented by a new active organization.",
        "The automation will use the closest available launch/operations workflow template.",
      ],
      steps: [
        {
          id: "agents",
          action: "create_agents",
          label: "Create operating owner agents",
          params: { count: requestedTeamCount ?? 3, purpose: "operating setup" },
        },
        {
          id: "org",
          action: "create_organization",
          label: "Create the operating hierarchy",
          params: { name: "Operating Team", memberStepId: "agents", activate: true },
          dependsOn: ["agents"],
        },
        {
          id: "council",
          action: "run_council",
          label: "Run the decision debate",
          params: { topic: "operating decision and launch readiness", organizationStepId: "org", agentStepId: "agents" },
          dependsOn: ["org"],
        },
        {
          id: "workflow",
          action: "create_workflow_from_template",
          label: "Create the operating workflow",
          params: {
            templateKey: /\blaunch|ops|operations?\b/.test(normalized) ? "ops-control-tower" : "hierarchy-orchestrator-team",
            name: /\blaunch\b/.test(normalized) ? "Product Launch Operating Workflow" : "Operating Setup Workflow",
          },
          dependsOn: ["org"],
        },
        {
          id: "task",
          action: "create_board_task",
          label: "Track the operating decision",
          params: {
            boardId: "main-board",
            title: /\blaunch\b/.test(normalized) ? "Track product launch decision" : "Track operating setup decision",
            description: "Track the council decision, workflow setup, and next operating actions.",
            organizationStepId: "org",
            agentStepId: "agents",
          },
          dependsOn: ["council", "workflow"],
        },
      ],
    };
  }

  if (
    /\b(?:set\s+up|setup|create|make|build|organize|form|assemble)\b/.test(normalized) &&
    /\bagents?\b/.test(normalized) &&
    /\b(?:org|organization|team|hierarchy)\b/.test(normalized) &&
    /\b(?:schedule|daily|weekly|recurring|cron|check|monitor)\b/.test(normalized)
  ) {
    const count = requestedTeamCount ?? 3;
    const workflowName = /\bhealth\b/.test(normalized) ? "Daily Health Check" : "Daily Team Check";
    return {
      version: 1,
      confidence: 0.75,
      userIntent: "Create agents, save them as an organization, and prepare a daily check workflow.",
      requiresConfirmation: true,
      assumptions: [
        countMatch?.[1] || teamCountMatch?.[1]
          ? `The requested team size is ${count}.`
          : "No exact team size was provided, so the app will create three agents.",
        "The daily check target was not specified, so the app will create a starter workflow that can be configured.",
      ],
      steps: [
        {
          id: "agents",
          action: "create_agents",
          label: `Create ${count} agents`,
          params: { count, purpose: "daily operations check" },
        },
        {
          id: "org",
          action: "create_organization",
          label: "Create an active organization with the new agents",
          params: { name: "Daily Check Team", memberStepId: "agents", activate: true },
          dependsOn: ["agents"],
        },
        {
          id: "workflow",
          action: "create_workflow_from_template",
          label: "Create a daily check workflow",
          params: { templateKey: "scheduled-health-check", name: workflowName },
          dependsOn: ["org"],
        },
        {
          id: "schedule",
          action: "schedule_workflow",
          label: "Prepare the workflow for daily scheduling",
          params: { workflowStepId: "workflow", schedule: "daily" },
          dependsOn: ["workflow"],
        },
      ],
    };
  }

  if (
    /\b(?:create|make|set\s+up|setup|organize|form|assemble|build)\b/.test(normalized) &&
    /\b(?:team|org(?:anization)?|hierarchy)\b/.test(normalized) &&
    /\b(?:agents?|people|person|members?|ai)\b/.test(normalized) &&
    !/\b(?:debate|discuss|council|board|task|schedule|daily|workflow)\b/.test(normalized)
  ) {
    const count = requestedTeamCount ?? 3;
    return {
      version: 1,
      confidence: 0.75,
      userIntent: `Create a ${count}-agent team and save it as an organization.`,
      requiresConfirmation: true,
      assumptions: [
        countMatch?.[1] || teamCountMatch?.[1]
          ? `The requested team size is ${count}.`
          : "No exact team size was provided, so the app will create three agents.",
        "No team purpose was provided, so generic lead/ops/specialist roles will be used.",
      ],
      steps: [
        {
          id: "agents",
          action: "create_agents",
          label: `Create ${count} team agents`,
          params: { count, purpose: "team" },
        },
        {
          id: "org",
          action: "create_organization",
          label: "Create an active organization with the team",
          params: { name: "AI Team", memberStepId: "agents", activate: true },
          dependsOn: ["agents"],
        },
      ],
    };
  }

  if (
    /\b(?:org(?:anization)?|team|crew|agents?|startup|whoever|people|person|members?)\b/.test(normalized) &&
    /\bboards?|tasks?|cards?|kanban|tracked|tracking|somewhere|first\s+work|next\s+steps?\b/.test(normalized) &&
    /\bcreate|make|need|want|set\s+up|put|add|organize|assemble|form|build|track|record\b/.test(normalized)
  ) {
    const taskTitle = /\bverdict|decision|recommendation\b/.test(normalized)
      ? "Record team verdict"
      : "Define initial organization task";
    return {
      version: 1,
      confidence: 0.62,
      userIntent: "Create an organization and add a linked board task.",
      requiresConfirmation: true,
      assumptions: [
        "No organization name was provided, so the app will generate one.",
        "No task title was provided, so the app will create a starter task.",
      ],
      steps: [
        {
          id: "agents",
          action: "create_agents",
          label: "Create a small starter agent team",
          params: { count: requestedCount ?? 3, purpose: /\bresearch|ocr|llm|model|benchmark\b/.test(normalized) ? "research" : "starter organization" },
        },
        {
          id: "org",
          action: "create_organization",
          label: "Create an active organization with the new agents",
          params: {
            name: /\bstartup\b/.test(normalized) ? "Startup Team" : null,
            memberStepId: "agents",
            activate: true,
          },
          dependsOn: ["agents"],
        },
        {
          id: "task",
          action: "create_board_task",
          label: "Create a starter board task linked to the organization",
          params: {
            boardId: "main-board",
            title: taskTitle,
            description: "Created from WebChat app-action planner.",
            organizationStepId: "org",
          },
          dependsOn: ["org"],
        },
      ],
    };
  }

  if (
    (/\b(?:research|study|investigate)\b/.test(normalized) ||
      /\bocr|llm|models?|benchmark|current|latest|document|workflow|intelligence|apis?|reliability|incident|failure|failing\b/.test(normalized)) &&
    /\bteam|agents?|people|person|members?|crew|org(?:anization)?|council|analysts?|researchers?\b/.test(normalized) &&
    // Explicit deliberation only — `compare`/generic `decision` must not force a
    // Council step in the deterministic fallback.
    (/\b(?:debate|council|discuss|deliberat|verdict|consensus|argue|argument)\b/.test(normalized) ||
      /\b(?:have|let)\s+(?:them|the\s+agents?|the\s+org|the\s+team)\s+decide\b/.test(normalized))
  ) {
    const topicMatch = message.match(/\b(?:debate|discuss|deliberate(?:\s+on)?|council\s+on|compare|decide(?:\s+on)?|pick)\s+(?:on|about|over|between)?\s*(.+)$/i);
    const topic = topicMatch?.[1]?.trim() || "the requested research topic";
    const count = requestedCount ?? 3;
    const needsBoardVerdict = /\b(?:board|task|card|todo|kanban|verdict|decision|recommendation)\b/.test(normalized);
    return {
      version: 1,
      confidence: 0.64,
      userIntent: needsBoardVerdict
        ? `Set up a research team, run a council debate on ${topic}, and add the verdict to the board.`
        : `Set up a research team and run a council debate on ${topic}.`,
      requiresConfirmation: true,
      assumptions: [
        countMatch?.[1]
          ? `The requested team size is ${count}.`
          : "No exact team size was provided, so the app will create three research agents.",
        "The council topic is inferred from the end of the message.",
      ],
      steps: [
        {
          id: "agents",
          action: "create_agents",
          label: `Create ${count} research agents`,
          params: { count, purpose: "research" },
        },
        {
          id: "org",
          action: "create_organization",
          label: "Create an active research organization",
          params: { name: "Research Team", memberStepId: "agents", activate: true },
          dependsOn: ["agents"],
        },
        {
          id: "council",
          action: "run_council",
          label: `Prepare a council debate on ${topic}`,
          params: { topic, organizationStepId: "org", agentStepId: "agents" },
          dependsOn: ["org"],
        },
        ...(needsBoardVerdict
          ? [
              {
                id: "verdict-task",
                action: "create_board_task" as const,
                label: "Create a board task for the council verdict",
                params: {
                  boardId: "main-board",
                  title: "Record OCR LLM council verdict",
                  description: "Capture the council verdict, rationale, and follow-up actions.",
                  organizationStepId: "org",
                },
                dependsOn: ["council"],
              },
            ]
          : []),
      ],
    };
  }

  if (
    /\b(?:research|study|investigate|sources?|ocr|llm|models?|benchmark|compare|document|docs?|pdfs?|extract|notes?)\b/.test(normalized) &&
    (/\bworkflows?|pipeline|automation\b/.test(normalized) || /\b(?:pdfs?|documents?|docs?)\b/.test(normalized)) &&
    /\b(?:need|want|create|make|build|set\s+up|prepare|choose|recommend|suggest|pick)\b/.test(normalized)
  ) {
    const hasFollowUpTasks = /\b(?:follow[-\s]?up|tasks?|board|todo|next\s+steps?)\b/.test(normalized);
    const templateKey = /\b(?:document|docs?|extract|notes?)\b/.test(normalized)
      ? "document-intelligence"
      : /\b(?:autonomous|sources?|gather|multi[-\s]?step|pipeline|evidence)\b/.test(normalized)
        ? "autonomous-research-pipeline"
        : "research-assistant";
    return {
      version: 1,
      confidence: 0.67,
      userIntent: hasFollowUpTasks
        ? "Create a research workflow and add a follow-up task to the board."
        : "Create a research workflow from the closest available template.",
      requiresConfirmation: true,
      assumptions: [
        `Selected '${templateKey}' as the closest available research template.`,
        ...(hasFollowUpTasks
          ? ["Follow-up task details were not specified, so the app will create a starter review task."]
          : []),
      ],
      steps: [
        {
          id: "templates",
          action: "recommend_templates",
          label: "Recommend research workflow templates",
          params: { topic: message },
        },
        {
          id: "workflow",
          action: "create_workflow_from_template",
          label: "Create the research workflow",
          params: {
            templateKey,
            name: /\b(?:document|docs?|extract|notes?)\b/.test(normalized)
              ? "Document Research Workflow"
              : /\bocr|llm|models?|benchmark|compare\b/.test(normalized)
              ? "Model Comparison Research Workflow"
              : "Research Workflow",
          },
          dependsOn: ["templates"],
        },
        ...(hasFollowUpTasks
          ? [
              {
                id: "follow-up-task",
                action: "create_board_task" as const,
                label: "Create a board task for research follow-up",
                params: {
                  boardId: "main-board",
                  title: "Review research workflow outputs",
                  description: "Track follow-up actions from the research workflow.",
                },
                dependsOn: ["workflow"],
              },
            ]
          : []),
      ],
    };
  }

  if (
    /\b(?:create|make|build|set\s+up|prepare)\b/.test(normalized) &&
    /\b(?:api|apis|endpoint|endpoints|service|services)\b/.test(normalized) &&
    /\b(?:monitor|watch|keep\s+an\s+eye\s+on|alerts?|failures?|failing|flaky|health)\b/.test(normalized)
  ) {
    const nameMatch = message.match(/\b(?:called|named)\s+["']?([^"',.]+?)["']?(?:\s+to|\s+for|\s+that|\s+and|$)/i);
    const workflowName = nameMatch?.[1]?.trim() || "API Watch";
    const hasSchedule = /\b(?:every|weekday|daily|weekly|schedule|cron|morning|am|pm)\b/.test(normalized);
    return {
      version: 1,
      confidence: 0.66,
      userIntent: `Create an API monitoring workflow named ${workflowName}${hasSchedule ? " and prepare it for scheduling" : ""}.`,
      requiresConfirmation: true,
      assumptions: [
        "The API Monitor with Alerts template is the closest available template.",
        "Exporting to a file is not a supported app-action step, so the workflow can be exported from the Workflows tab after creation.",
      ],
      steps: [
        {
          id: "workflow",
          action: "create_workflow_from_template",
          label: `Create ${workflowName} from the API monitor template`,
          params: { templateKey: "api-monitor", name: workflowName },
        },
        ...(hasSchedule
          ? [
              {
                id: "schedule",
                action: "schedule_workflow" as const,
                label: "Prepare the workflow for scheduler setup",
                params: { workflowStepId: "workflow", schedule: "weekday morning" },
                dependsOn: ["workflow"],
              },
            ]
          : []),
      ],
    };
  }

  if (
    /\b(?:telegram|slack|discord|whatsapp)\b/.test(normalized) &&
    /\b(?:alerts?|notifications?|notify|send|route)\b/.test(normalized) &&
    /\b(?:research|workflow|automation|schedule|daily|weekly)\b/.test(normalized) &&
    /\b(?:set\s+up|setup|create|make|build|connect|wire)\b/.test(normalized)
  ) {
    const channel = (normalized.match(/\b(telegram|slack|discord|whatsapp)\b/)?.[1] || "telegram").toLowerCase();
    const templateKey = /\bresearch\b/.test(normalized) ? "research-assistant" : "channel-workspace-assistant";
    return {
      version: 1,
      confidence: 0.66,
      userIntent: `Set up ${channel} alerts for the requested automation.`,
      requiresConfirmation: true,
      assumptions: [
        `The ${channel} connection must already be configured in Channels or Settings before alerts can send.`,
        `Selected '${templateKey}' as the closest available workflow template.`,
      ],
      steps: [
        {
          id: "connect-channel",
          action: "connect_channel",
          label: `Validate ${channel} channel connection`,
          params: { channel },
        },
        {
          id: "workflow",
          action: "create_workflow_from_template",
          label: `Create ${channel} alert workflow`,
          params: { templateKey, name: `${channel[0]?.toUpperCase() ?? "T"}${channel.slice(1)} Research Alerts` },
          dependsOn: ["connect-channel"],
        },
      ],
    };
  }

  if (
    (/\boptimi[sz](?:e|ing|ation)?\b/.test(normalized) && /\bworkflows?\b/.test(normalized) && /\bagents?\b/.test(normalized)) ||
    /\bmake\s+(?:my|the|these|our)?\s*(?:agents?\s+and\s+workflows?|workflows?\s+and\s+agents?)\s+better\b/.test(normalized)
  ) {
    return {
      version: 1,
      confidence: 0.7,
      userIntent: "Optimize workflows and agents.",
      requiresConfirmation: false,
      clarificationQuestion:
        "Do you want a read-only audit report first, or should I prepare a change plan for workflows and agents that you can confirm before anything is modified?",
      clarificationChoices: [
        "Read-only audit report first",
        "Prepare a confirmable change plan",
        "Focus only on workflows",
        "Focus only on agents",
      ],
      assumptions: [],
      steps: [],
    };
  }

  if (hasStrongMutationSignals(message)) {
    const count = requestedTeamCount ?? 3;
    return {
      version: 1,
      confidence: 0.75,
      userIntent: "Configure the app based on the multi-step request.",
      requiresConfirmation: true,
      assumptions: [
        countMatch?.[1] || teamCountMatch?.[1]
          ? `The requested team size is ${count}.`
          : "No exact team size was provided, so the app will create agents.",
        "The exact scope was inferred from the request details.",
      ],
      steps: [
        {
          id: "agents",
          action: "create_agents",
          label: `Create ${count} agents`,
          params: { count, purpose: "requested setup" },
        },
        {
          id: "org",
          action: "create_organization",
          label: "Create an organization with the agents",
          params: { name: null, memberStepId: "agents", activate: true },
          dependsOn: ["agents"],
        },
      ],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function planAppAction(
  message: string,
  ctx: {
    sessionId: string;
    channel: string;
    internalBaseUrl?: string | null;
    clientTurnId?: string;
    onStatus?: (phase: string, label: string, detail?: string) => void;
  },
): Promise<AppActionPlan | null> {
  const baseUrl = String(
    ctx.internalBaseUrl ||
      process.env.INTERNAL_API_BASE_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.APP_URL ||
      `http://127.0.0.1:${process.env.PORT ?? 3100}`,
  ).replace(/\/+$/, "");

  const hierarchyRelevant = isHierarchyContextRelevant(message);
  ctx.onStatus?.("routing", "Preparing app plan...", "Checking what needs to be changed");
  ctx.onStatus?.(
    "loading-context",
    hierarchyRelevant ? "Loading app and hierarchy context..." : "Loading compact app context...",
  );

  let compactCtx: CompactContext;
  try {
    compactCtx = await loadCompactContext(baseUrl, { includeHierarchy: hierarchyRelevant });
  } catch (err) {
    log.warn("planAppAction: context load failed", { error: String(err) });
    compactCtx = {
      agents: [],
      orgs: [],
      boards: [],
      channels: [],
      activeOrg: null,
      hierarchyRoles: [],
      goals: [],
      companyTemplates: [],
    };
  }

  const existingAgentAssignment = buildExistingAgentAssignmentPlan(message, compactCtx);
  if (existingAgentAssignment) {
    const validation = validateAppActionPlan(existingAgentAssignment);
    if (validation.success) {
      log.info("planAppAction: resolved existing agent assignment deterministically", {
        userIntent: validation.plan.userIntent,
        stepCount: validation.plan.steps.length,
      });
      return validation.plan;
    }
  }

  const clarificationPreflight = buildHeuristicFallbackPlan(message);
  if (
    clarificationPreflight &&
    clarificationPreflight.steps.length === 0 &&
    clarificationPreflight.clarificationQuestion
  ) {
    return clarificationPreflight;
  }

  if (ctx.clientTurnId && isTurnAborted(ctx.clientTurnId)) {
    log.info("planAppAction: turn aborted before planning");
    const fallback = buildHeuristicFallbackPlan(message);
    return fallback ? augmentPlanFromMessage(fallback, message) : null;
  }

  // Try deterministic plan first for high-confidence patterns
  const deterministic = buildHeuristicFallbackPlan(message);
  if (deterministic && deterministic.steps.length > 0) {
    const augmented = sanitizeDigestPlan(augmentPlanFromMessage(deterministic, message), message);
    const deterministicCouncilConcernFollowUp =
      augmented.steps.some((step) => step.action === "create_board_task") &&
      augmented.steps.some((step) =>
        step.action === "run_council" &&
        step.params.createFollowUpTasksFromConcerns === true
      );
    const richCouncilNeedsModel =
      augmented.steps.some((step) => step.action === "run_council") &&
      hasRichCouncilControlRequest(message) &&
      !deterministicCouncilConcernFollowUp;
    if ((augmented.confidence ?? 0) >= 0.70 && !richCouncilNeedsModel) {
      log.info("planAppAction: using deterministic plan (skipping LLM)", {
        userIntent: augmented.userIntent,
        stepCount: augmented.steps.length,
        confidence: augmented.confidence,
      });
      ctx.onStatus?.("finalizing", "Building plan from known patterns...");
      const augmentedValidation = validateAppActionPlan(augmented);
      if (augmentedValidation.success) {
        return augmentedValidation.plan;
      }
      return deterministic;
    }
    if (richCouncilNeedsModel) {
      log.info("planAppAction: rich council controls detected — using model planner instead of deterministic shortcut");
    }
  }

  let modelResponse: string;
  let modelConfigForRepair: PlannerModelConfig | null = null;
  let callModelForRepair: ((options: CallModelOptions) => Promise<{ response: string }>) | null = null;
  let plannerContextMessage = "";
  ctx.onStatus?.("drafting-plan", "Drafting an app plan...");
  try {
    const [{ getModelConfig }, { callModel }] = await Promise.all([
      import("@/lib/agents/model-router") as Promise<typeof import("@/lib/agents/model-router")>,
      import("@/lib/agents/multi-provider") as Promise<typeof import("@/lib/agents/multi-provider")>,
    ]);
    const { providerRequiresApiKey } = await import("@/lib/agents/provider-plugins");
    const modelConfig = getModelConfig({ sessionId: ctx.sessionId });
    if (!modelConfig.apiKey && providerRequiresApiKey(modelConfig.provider)) {
      log.debug("planAppAction: no model API key configured — skipping planner");
      return null;
    }
    modelConfigForRepair = modelConfig;
    callModelForRepair = callModel;
    plannerContextMessage = buildUserMessage(message, {
      sessionId: ctx.sessionId,
      channel: ctx.channel,
      ...compactCtx,
    });

    const abortSignal = ctx.clientTurnId ? getAbortSignal(ctx.clientTurnId) : undefined;
    const abortPromise = abortSignal
      ? new Promise<never>((_, reject) => {
          if (abortSignal.aborted) {
            reject(new Error("Planner model aborted"));
            return;
          }
          abortSignal.addEventListener("abort", () => reject(new Error("Planner model aborted")), { once: true });
        })
      : null;
    const result = await Promise.race([
      callModel({
        provider: modelConfig.provider,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        systemPrompt: buildSystemPrompt(),
        userMessage: plannerContextMessage,
        maxTokens: 1200,
        temperature: 0,
        fastMode: modelConfig.fastMode,
      }),
      ...(abortPromise ? [abortPromise] : []),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Planner model timed out")), PLANNER_MODEL_TIMEOUT_MS)
      ),
    ]);

    modelResponse = result.response;
  } catch (err) {
    log.warn("planAppAction: model call failed", { error: String(err) });
    if (ctx.clientTurnId && isTurnAborted(ctx.clientTurnId)) {
      log.info("planAppAction: turn aborted during model call");
      const fallback = buildHeuristicFallbackPlan(message);
      return fallback ? augmentPlanFromMessage(fallback, message) : null;
    }
    ctx.onStatus?.("finalizing", "Building plan from patterns (model unavailable)...");
    const fallback = buildHeuristicFallbackPlan(message);
    return fallback ? augmentPlanFromMessage(fallback, message) : null;
  }

  const rawJson = extractJson(modelResponse);
  if (!rawJson) {
    log.debug("planAppAction: no JSON found in model response", { modelResponse });
    const fallback = buildHeuristicFallbackPlan(message);
    return fallback ? augmentPlanFromMessage(fallback, message) : null;
  }

  const coercedRawJson = coerceRawAppActionPlan(rawJson);
  const validation = validateAppActionPlan(coercedRawJson);
  let draftPlan: AppActionPlan;
  if (!validation.success) {
    log.debug("planAppAction: plan validation failed", { error: validation.error, rawJson: coercedRawJson });
    const repairedInvalidPlan =
      modelConfigForRepair && callModelForRepair
        ? await repairInvalidPlanWithModel({
            message,
            rawPlan: coercedRawJson,
            validationError: validation.error,
            plannerContextMessage,
            modelConfig: modelConfigForRepair,
            callModel: callModelForRepair,
          })
        : null;
    if (repairedInvalidPlan) {
      draftPlan = normalizeAppActionParams(repairedInvalidPlan);
    } else {
      const fallback = buildHeuristicFallbackPlan(message);
      return fallback ? augmentPlanFromMessage(fallback, message) : null;
    }
  } else {
    draftPlan = normalizeAppActionParams(validation.plan);
  }

  ctx.onStatus?.("reviewing-plan", "Checking that all requested capabilities are covered...");
  const coverageNotes = buildCoverageNotes(message, draftPlan);
  let repairedPlan = draftPlan;

  if (coverageNotes.length > 0) {
    log.info("planAppAction: coverage critic found missing surfaces", {
      missing: coverageNotes,
      userIntent: draftPlan.userIntent,
    });

    // Run deterministic augmentation BEFORE model repair
    const locallyAugmented = augmentPlanFromMessage(draftPlan, message);
    const notesAfterAugment = buildCoverageNotes(message, locallyAugmented);
    if (notesAfterAugment.length === 0) {
      log.info("planAppAction: deterministic augmentation resolved coverage — skipping model repair");
      repairedPlan = locallyAugmented;
    } else {
      ctx.onStatus?.("reviewing-plan", "Checking that all requested capabilities are covered...",
        `${notesAfterAugment.length} gaps remain after local augmentation`);
      repairedPlan = modelConfigForRepair && callModelForRepair
        ? await repairPlanCoverageWithModel({
            message,
            draftPlan: locallyAugmented,
            plannerContextMessage,
            coverageNotes: notesAfterAugment,
            modelConfig: modelConfigForRepair,
            callModel: callModelForRepair,
          })
        : draftPlan;
    }
  }

  const augmentedPlan = normalizeGenericWorkflowModelTargets(
    sanitizeDigestPlan(augmentPlanFromMessage(repairedPlan, message), message),
  );
  const augmentedValidation = validateAppActionPlan(augmentedPlan);
  if (!augmentedValidation.success) {
    log.debug("planAppAction: augmented plan validation failed", {
      error: augmentedValidation.error,
      augmentedPlan,
    });
    return repairedPlan;
  }

  const workflowEditClarification = preflightWorkflowEditAmbiguity(augmentedValidation.plan);
  if (workflowEditClarification) {
    return workflowEditClarification;
  }

  ctx.onStatus?.("finalizing", "Preparing confirmation preview...");
  log.info("planAppAction: plan validated", {
    userIntent: augmentedValidation.plan.userIntent,
    stepCount: augmentedValidation.plan.steps.length,
    requiresConfirmation: augmentedValidation.plan.requiresConfirmation,
    confidence: augmentedValidation.plan.confidence,
    remainingMissingCoverage: findMissingCoverage(message, augmentedValidation.plan).map((surface) => surface.id),
    optimizationNotes: {
      usedDeterministicPlan: false,
      usedTimeoutFallback: false,
    },
  });

  return augmentedValidation.plan;
}
