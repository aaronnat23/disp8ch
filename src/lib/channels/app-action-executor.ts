/**
 * App-Action Plan Executor
 *
 * Executes a validated AppActionPlan by mapping each action to existing
 * internal API calls or library functions. Execution is NOT LLM-driven —
 * only schema-validated typed actions are run.
 *
 * Execution order respects the `dependsOn` field via a simple topological
 * sort. Failed dependencies halt execution at the first blocked step.
 */

import { logger } from "@/lib/utils/logger";
import type { AppActionPlan, AppActionStep, AppActionKind } from "@/lib/channels/app-action-schema";
import { recommendWorkflowTemplates } from "@/lib/workflows/template-recommendations";
import { resolveWorkflow, resolveNode, isFieldEditable, validateWorkflowNodes, saveWorkflowNodes, saveWorkflowActive } from "@/lib/workflows/workflow-tool-ops";

const log = logger.child("app-action-executor");

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type AppActionStepResult = {
  id: string;
  action: AppActionKind;
  ok: boolean;
  output?: unknown;
  error?: string;
};

export type AppActionExecutionReport = {
  stepsAttempted: number;
  stepsSucceeded: number;
  stepResults: AppActionStepResult[];
  summary: string;
};

// ---------------------------------------------------------------------------
// Topological sort
// ---------------------------------------------------------------------------

function topoSort(steps: AppActionStep[]): AppActionStep[] {
  const byId = new Map<string, AppActionStep>(steps.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const result: AppActionStep[] = [];

  function visit(id: string, ancestors: Set<string>): void {
    if (visited.has(id)) return;
    if (ancestors.has(id)) {
      log.warn("app-action-executor: circular dependency detected", { id });
      return;
    }
    const step = byId.get(id);
    if (!step) return;
    const next = new Set(ancestors);
    next.add(id);
    for (const dep of step.dependsOn ?? []) {
      visit(dep, next);
    }
    visited.add(id);
    result.push(step);
  }

  for (const step of steps) {
    visit(step.id, new Set());
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal base URL resolver
// ---------------------------------------------------------------------------

function resolveBase(explicit?: string | null): string {
  const raw =
    String(explicit || "").trim() ||
    String(process.env.INTERNAL_API_BASE_URL || "").trim() ||
    String(process.env.NEXT_PUBLIC_APP_URL || "").trim() ||
    String(process.env.APP_URL || "").trim();
  if (raw) {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    return withScheme.replace(/\/+$/, "");
  }
  return `http://127.0.0.1:${process.env.PORT ?? 3100}`;
}

function inferGeneratedOrganizationName(): string {
  return `Planner Organization ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
}

function normalizeAgentIdForPlanner(name: string): string {
  return (
    String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  );
}

async function makeUniqueAgentName(name: string): Promise<string> {
  try {
    const { getSqlite } = (await import("@/lib/db")) as typeof import("@/lib/db");
    const db = getSqlite();
    let candidate = name;
    let candidateId = normalizeAgentIdForPlanner(candidate);
    let suffix = 2;
    while (db.prepare("SELECT id FROM agents WHERE id = ? LIMIT 1").get(candidateId)) {
      candidate = `${name} ${suffix}`;
      candidateId = normalizeAgentIdForPlanner(candidate);
      suffix += 1;
    }
    return candidate;
  } catch {
    return `${name} ${Date.now().toString(36)}`;
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

type StepOutputMap = Map<string, unknown>;

async function handleCreateAgent(
  step: AppActionStep,
  base: string,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  const name =
    typeof step.params.name === "string" && step.params.name
      ? step.params.name
      : `Agent ${Date.now().toString(36)}`;

  try {
    const res = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, isActive: true }),
    });
    const data = (await res.json()) as { success?: boolean; data?: { id?: string; name?: string }; error?: string };
    if (!res.ok || !data.success) {
      return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, output: { id: data.data?.id, name: data.data?.name } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleCreateAgents(
  step: AppActionStep,
  base: string,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  const requestedNames = Array.isArray(step.params.names)
    ? step.params.names.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    : [];
  const count = requestedNames.length > 0
    ? Math.min(requestedNames.length, 10)
    : typeof step.params.count === "number" && step.params.count > 0
    ? Math.min(step.params.count, 10)
    : 3;
  const purpose = typeof step.params.purpose === "string" ? step.params.purpose : "general work";
  const roleNames = ["Lead", "Ops", "Specialist", "Analyst", "Researcher"];

  const created: Array<{ id: string; name: string }> = [];
  for (let i = 0; i < count; i++) {
    const suffix = roleNames[i] ?? `Worker ${i + 1}`;
    const name = await makeUniqueAgentName(
      (requestedNames[i] ?? `${purpose.split(" ").slice(-1)[0] ?? "Team"} ${suffix}`).replace(/\s{2,}/g, " "),
    );
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, isActive: true }),
      });
      const data = (await res.json()) as { success?: boolean; data?: { id?: string; name?: string }; error?: string };
      if (res.ok && data.success && data.data?.id) {
        created.push({ id: data.data.id, name: data.data.name ?? name });
      }
    } catch {
      // continue with next agent
    }
  }
  if (created.length === 0) {
    return { ok: false, error: "No agents could be created." };
  }
  return { ok: true, output: { agents: created, ids: created.map((a) => a.id) } };
}

async function handleCreateOrganization(
  step: AppActionStep,
  _base: string,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  // Resolve member agent IDs from explicit params or a prior step. An explicit
  // empty memberIds array means "create an empty org"; it must not clone the
  // currently active hierarchy snapshot.
  const explicitMemberIds = Array.isArray(step.params.memberIds)
    ? step.params.memberIds.map(String).filter(Boolean)
    : null;
  const hasExplicitMemberIds = explicitMemberIds !== null;
  let agentIds: string[] = explicitMemberIds ?? [];
  const memberStepId = typeof step.params.memberStepId === "string" ? step.params.memberStepId : null;
  if (memberStepId) {
    const priorOutput = outputs.get(memberStepId);
    if (priorOutput && typeof priorOutput === "object" && priorOutput !== null) {
      const priorIds = (priorOutput as Record<string, unknown>).ids;
      if (Array.isArray(priorIds)) {
        agentIds = priorIds.map(String);
      }
    }
  }

  const orgName =
    typeof step.params.name === "string" && step.params.name
      ? step.params.name
      : inferGeneratedOrganizationName();

  try {
    const { saveSelectedHierarchyOrganization, saveCurrentHierarchyOrganization } = await import("@/lib/hierarchy/organizations");
    const organization = hasExplicitMemberIds || agentIds.length > 0
      ? saveSelectedHierarchyOrganization({
          name: orgName,
          description: typeof step.params.description === "string" ? step.params.description : "Created from WebChat app-action planner.",
          activate: step.params.activate !== false,
          memberIds: agentIds,
        })
      : saveCurrentHierarchyOrganization({
          name: orgName,
          description: typeof step.params.description === "string" ? step.params.description : "Created from WebChat app-action planner.",
          activate: step.params.activate !== false,
        });
    return {
      ok: true,
      output: {
        id: organization.id,
        name: organization.name,
        memberCount: organization.memberCount,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; data: { success?: boolean; data?: unknown; error?: string } }> {
  const res = await fetch(url, init);
  const data = (await res.json()) as { success?: boolean; data?: unknown; error?: string };
  return { ok: res.ok, status: res.status, data };
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArrayParam(params: Record<string, unknown>, key: string, maxItems = 24): string[] {
  const raw = params[key];
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/\r?\n|,/g)
      : [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    output.push(normalized);
    if (output.length >= maxItems) break;
  }
  return output;
}

function enumParam<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = typeof params[key] === "string" ? String(params[key]).trim().toLowerCase() : "";
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function clampNumberParam(params: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const raw = Number(params[key]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

async function resolveFirstBoardId(explicit?: string | null): Promise<string> {
  const requested = String(explicit || "").trim();
  if (requested && requested !== "main-board") return requested;
  try {
    const { getSqlite } = (await import("@/lib/db")) as typeof import("@/lib/db");
    const row = getSqlite()
      .prepare("SELECT id FROM boards ORDER BY created_at ASC LIMIT 1")
      .get() as { id: string } | undefined;
    if (row?.id) return row.id;
  } catch {
    // keep conventional fallback
  }
  return requested || "main-board";
}

async function handleCreateBoardTask(
  step: AppActionStep,
  base: string,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  // Resolve boardId — prefer param, fallback to first board
  let boardId = typeof step.params.boardId === "string" ? step.params.boardId : "main-board";

  // Resolve organizationId from prior step
  let organizationId: string | undefined;
  const orgStepId = typeof step.params.organizationStepId === "string" ? step.params.organizationStepId : null;
  if (orgStepId) {
    const priorOutput = outputs.get(orgStepId);
    if (priorOutput && typeof priorOutput === "object" && priorOutput !== null) {
      const priorId = (priorOutput as Record<string, unknown>).id;
      if (typeof priorId === "string") organizationId = priorId;
    }
  }
  if (!organizationId && typeof step.params.organizationId === "string") {
    const priorOutput = outputs.get(step.params.organizationId);
    if (priorOutput && typeof priorOutput === "object" && priorOutput !== null) {
      const priorId = (priorOutput as Record<string, unknown>).id;
      if (typeof priorId === "string") organizationId = priorId;
    }
    if (!organizationId) organizationId = step.params.organizationId;
  }

  // If boardId is "main-board", try to resolve the actual first board
  if (boardId === "main-board") {
    boardId = await resolveFirstBoardId(boardId);
  }

  const title =
    typeof step.params.title === "string" && step.params.title
      ? step.params.title
      : "New Task";
  const description = typeof step.params.description === "string" ? step.params.description : undefined;

  try {
    const body: Record<string, unknown> = {
      boardId,
      title,
      description,
      status: typeof step.params.status === "string" ? step.params.status : "inbox",
    };
    if (organizationId) body.organizationId = organizationId;

    const { ok, status, data } = await fetchJson(`${base}/api/boards/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!ok || !data.success) {
      return { ok: false, error: data.error ?? `HTTP ${status}` };
    }
    const task = data.data as { id?: string; title?: string } | undefined;
    return { ok: true, output: { id: task?.id, title: task?.title, boardId } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleCreateGoal(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  const title =
    typeof step.params.title === "string" && step.params.title
      ? step.params.title
      : "New Goal";

  let organizationId: string | undefined;
  const orgStepId = typeof step.params.organizationStepId === "string" ? step.params.organizationStepId : null;
  if (orgStepId) {
    const priorOutput = outputs.get(orgStepId);
    if (priorOutput && typeof priorOutput === "object" && priorOutput !== null) {
      const priorId = (priorOutput as Record<string, unknown>).id;
      if (typeof priorId === "string") organizationId = priorId;
    }
  }
  if (!organizationId && typeof step.params.organizationId === "string") {
    organizationId = step.params.organizationId;
  }

  try {
    const { createHierarchyGoal } = await import("@/lib/hierarchy/goals");
    const goal = createHierarchyGoal({
      name: title,
      organizationId: organizationId ?? null,
    });
    return { ok: true, output: { id: goal.id, title: goal.name, organizationId: goal.organizationId } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleLinkBoardTask(
  step: AppActionStep,
  base: string,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  // Resolve task id
  let taskId = typeof step.params.taskId === "string" ? step.params.taskId : null;
  if (taskId && outputs.has(taskId)) {
    const priorOutput = outputs.get(taskId);
    if (priorOutput && typeof priorOutput === "object" && priorOutput !== null) {
      const priorId = (priorOutput as Record<string, unknown>).id;
      if (typeof priorId === "string") taskId = priorId;
    }
  }
  const taskStepId = typeof step.params.taskStepId === "string" ? step.params.taskStepId : null;
  if (!taskId && taskStepId) {
    const priorOutput = outputs.get(taskStepId);
    if (priorOutput && typeof priorOutput === "object" && priorOutput !== null) {
      const priorId = (priorOutput as Record<string, unknown>).id;
      if (typeof priorId === "string") taskId = priorId;
    }
  }
  if (!taskId) {
    for (const output of outputs.values()) {
      if (output && typeof output === "object" && output !== null) {
        const maybe = output as Record<string, unknown>;
        if (typeof maybe.id === "string" && typeof maybe.title === "string") {
          taskId = maybe.id;
          break;
        }
      }
    }
  }
  if (!taskId) {
    return { ok: false, error: "No task id available to link." };
  }

  const patch: Record<string, unknown> = {};

  if (step.action === "link_board_task_to_organization") {
    let orgId = typeof step.params.organizationId === "string" ? step.params.organizationId : null;
    if (orgId && outputs.has(orgId)) {
      const priorOutput = outputs.get(orgId);
      if (priorOutput && typeof priorOutput === "object" && priorOutput !== null) {
        const priorId = (priorOutput as Record<string, unknown>).id;
        if (typeof priorId === "string") orgId = priorId;
      }
    }
    const orgStepId = typeof step.params.organizationStepId === "string" ? step.params.organizationStepId : null;
    if (!orgId && orgStepId) {
      const priorOutput = outputs.get(orgStepId);
      if (priorOutput && typeof priorOutput === "object" && priorOutput !== null) {
        const priorId = (priorOutput as Record<string, unknown>).id;
        if (typeof priorId === "string") orgId = priorId;
      }
    }
    if (!orgId) {
      for (const output of outputs.values()) {
        if (output && typeof output === "object" && output !== null) {
          const maybe = output as Record<string, unknown>;
          if (typeof maybe.id === "string" && typeof maybe.name === "string" && "memberCount" in maybe) {
            orgId = maybe.id;
            break;
          }
        }
      }
    }
    if (!orgId) return { ok: false, error: "No organization id available to link." };
    patch.organizationId = orgId;
  } else if (step.action === "link_board_task_to_agent") {
    let agentId = typeof step.params.agentId === "string" ? step.params.agentId : null;
    const agentStepId = typeof step.params.agentStepId === "string" ? step.params.agentStepId : null;
    if (!agentId && agentStepId) {
      const priorOutput = outputs.get(agentStepId);
      if (priorOutput && typeof priorOutput === "object" && priorOutput !== null) {
        const priorId = (priorOutput as Record<string, unknown>).id;
        if (typeof priorId === "string") agentId = priorId;
        const ids = (priorOutput as Record<string, unknown>).ids;
        if (!agentId && Array.isArray(ids) && typeof ids[0] === "string") agentId = ids[0];
      }
    }
    if (!agentId) return { ok: false, error: "No agent id available to link." };
    patch.assignedAgentId = agentId;
  } else if (step.action === "link_board_task_to_goal") {
    let goalId = typeof step.params.goalId === "string" ? step.params.goalId : null;
    const goalStepId = typeof step.params.goalStepId === "string" ? step.params.goalStepId : null;
    if (!goalId && goalStepId) {
      const priorOutput = outputs.get(goalStepId);
      if (priorOutput && typeof priorOutput === "object" && priorOutput !== null) {
        const priorId = (priorOutput as Record<string, unknown>).id;
        if (typeof priorId === "string") goalId = priorId;
      }
    }
    if (!goalId) return { ok: false, error: "No goal id available to link." };
    patch.goalId = goalId;
  }

  try {
    const { updateBoardTask } = await import("@/lib/boards/manager");
    const task = updateBoardTask(taskId, patch);
    return { ok: true, output: { taskId, ...patch, title: task.title } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function resolveAgentIdFromStep(step: AppActionStep, outputs: StepOutputMap): string | null {
  if (typeof step.params.agentId === "string" && step.params.agentId.trim()) {
    return step.params.agentId.trim();
  }
  const agentStepId = typeof step.params.agentStepId === "string" ? step.params.agentStepId : null;
  if (!agentStepId) return null;
  const priorOutput = outputs.get(agentStepId);
  if (!priorOutput || typeof priorOutput !== "object") return null;
  const prior = priorOutput as Record<string, unknown>;
  if (typeof prior.id === "string") return prior.id;
  if (Array.isArray(prior.ids) && typeof prior.ids[0] === "string") return prior.ids[0];
  return null;
}

function resolveAgentIdsFromStep(step: AppActionStep, outputs: StepOutputMap): string[] {
  const direct = resolveAgentIdFromStep(step, outputs);
  const ids = direct ? [direct] : [];
  const agentStepId = typeof step.params.agentStepId === "string" ? step.params.agentStepId : null;
  if (agentStepId) {
    const priorOutput = outputs.get(agentStepId);
    if (priorOutput && typeof priorOutput === "object") {
      const priorIds = (priorOutput as Record<string, unknown>).ids;
      if (Array.isArray(priorIds)) {
        ids.push(...priorIds.map(String).filter(Boolean));
      }
    }
  }
  return Array.from(new Set(ids));
}

async function handleAssignSkillToAgent(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  const agentIds = resolveAgentIdsFromStep(step, outputs);
  const skillId = typeof step.params.skillId === "string" ? step.params.skillId.trim() : "";
  if (agentIds.length === 0 || !skillId) return { ok: false, error: "agentId and skillId are required." };
  try {
    const { getAgentById, setAgentEnabledSkills } = await import("@/lib/agents/registry");
    const updatedIds: string[] = [];
    for (const agentId of agentIds) {
      const agent = getAgentById(agentId);
      if (!agent) return { ok: false, error: `Agent not found: ${agentId}` };
      const next = Array.from(new Set([...(agent.enabledSkills ?? []), skillId]));
      const updated = setAgentEnabledSkills(agent.id, next);
      updatedIds.push(updated.id);
    }
    return { ok: true, output: { agentIds: updatedIds, skillId } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleAttachExtensionToAgent(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  const agentIds = resolveAgentIdsFromStep(step, outputs);
  const extensionId = typeof step.params.extensionId === "string" ? step.params.extensionId.trim() : "";
  if (agentIds.length === 0 || !extensionId) return { ok: false, error: "agentId and extensionId are required." };
  try {
    const { getAgentById, setAgentExtensions } = await import("@/lib/agents/registry");
    const updatedIds: string[] = [];
    for (const agentId of agentIds) {
      const agent = getAgentById(agentId);
      if (!agent) return { ok: false, error: `Agent not found: ${agentId}` };
      const next = Array.from(new Set([...(agent.enabledExtensions ?? []), extensionId]));
      const updated = setAgentExtensions(agent.id, next);
      updatedIds.push(updated.id);
    }
    return { ok: true, output: { agentIds: updatedIds, extensionId } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleCreateWorkflowFromTemplate(
  step: AppActionStep,
  base: string,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  const templateRef =
    typeof step.params.template === "string" ? step.params.template :
    typeof step.params.templateKey === "string" ? step.params.templateKey : null;
  const workflowName =
    typeof step.params.name === "string" && step.params.name
      ? step.params.name
      : templateRef
        ? `${templateRef} ${new Date().toISOString().slice(0, 16)}`
        : `Workflow ${new Date().toISOString().slice(0, 16)}`;

  if (!templateRef) {
    return { ok: false, error: "No template key provided for create_workflow_from_template." };
  }

  try {
    const res = await fetch(`${base}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: workflowName, template: templateRef }),
    });
    const data = (await res.json()) as { success?: boolean; data?: { id?: string; name?: string }; error?: string };
    if (!res.ok || !data.success) {
      return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, output: { id: data.data?.id, name: data.data?.name } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Resolve the target workflow for a node-edit action: explicit id, a prior step's
 * created-workflow id, or a fuzzy name match.
 */
function resolveWorkflowIdForNodeEdit(step: AppActionStep, outputs: StepOutputMap): { id: string } | { error: string } {
  let workflowId = typeof step.params.workflowId === "string" ? step.params.workflowId : null;
  const workflowStepId = typeof step.params.workflowStepId === "string" ? step.params.workflowStepId : null;
  if (!workflowId && workflowStepId) {
    const prior = outputs.get(workflowStepId);
    if (prior && typeof prior === "object" && prior !== null) {
      const priorId = (prior as Record<string, unknown>).id ?? (prior as Record<string, unknown>).workflowId;
      if (typeof priorId === "string") workflowId = priorId;
    }
  }
  if (workflowId) {
    const { workflow } = resolveWorkflow({ id: workflowId });
    if (!workflow) return { error: `Workflow not found: ${workflowId}.` };
    return { id: workflow.id };
  }
  const name = typeof step.params.workflowName === "string" ? step.params.workflowName : undefined;
  const { workflow, ambiguous } = resolveWorkflow({ name });
  if (workflow) return { id: workflow.id };
  if (ambiguous.length > 1) return { error: `Multiple workflows match "${name}": ${ambiguous.map((w) => w.name).join(", ")}. Specify which one.` };
  return { error: `Could not resolve a workflow to edit${name ? ` (named "${name}")` : ""}.` };
}

async function handleUpdateWorkflowNode(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const wf = resolveWorkflowIdForNodeEdit(step, outputs);
    if ("error" in wf) return { ok: false, error: wf.error };
    const { workflow } = resolveWorkflow({ id: wf.id });
    if (!workflow) return { ok: false, error: "Workflow not found." };

    const nodeId = typeof step.params.nodeId === "string" ? step.params.nodeId : undefined;
    const nodeLabel = typeof step.params.nodeLabel === "string" ? step.params.nodeLabel : undefined;
    const { node, ambiguous } = resolveNode(workflow.nodes, { nodeId, nodeLabel });
    if (!node) {
      if (ambiguous.length > 1) return { ok: false, error: `Multiple nodes match "${nodeLabel}": ${ambiguous.map((a) => `${a.label} (${a.type})`).join(", ")}. Specify which one.` };
      return { ok: false, error: `Could not find a node matching "${nodeLabel ?? nodeId ?? "(none)"}" in workflow "${workflow.name}".` };
    }

    const updates = step.params.updates && typeof step.params.updates === "object"
      ? step.params.updates as Record<string, unknown>
      : {};
    const applied: string[] = [];
    const rejected: string[] = [];
    const newData: Record<string, unknown> = { ...(node.data ?? {}) };
    for (const [key, value] of Object.entries(updates)) {
      if (key === "label" || isFieldEditable(node.type, key)) {
        newData[key] = value;
        applied.push(key);
      } else {
        rejected.push(key);
      }
    }
    if (applied.length === 0) {
      return { ok: false, error: `No editable fields for node "${String(node.data?.label ?? node.id)}" (${node.type})${rejected.length ? `. Not editable: ${rejected.join(", ")}` : ""}.` };
    }

    const newNodes = workflow.nodes.map((n) => (n.id === node.id ? { ...n, data: newData } : n));
    const validation = validateWorkflowNodes(workflow.id, newNodes);
    if (!validation.ok) {
      return { ok: false, error: `Edit would break the workflow: ${validation.errors.map((e) => e.message).join("; ")}` };
    }
    saveWorkflowNodes(workflow.id, newNodes);
    return {
      ok: true,
      output: { workflowId: workflow.id, workflowName: workflow.name, nodeId: node.id, nodeLabel: String(node.data?.label ?? node.id), applied, rejected },
    };
  } catch (error) {
    return { ok: false, error: `Failed to update workflow node: ${String(error)}` };
  }
}

async function handleSetWorkflowNodeModel(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const modelRef = typeof step.params.modelRef === "string" ? step.params.modelRef.trim() : "";
    if (!modelRef) return { ok: false, error: "No model specified." };
    const wf = resolveWorkflowIdForNodeEdit(step, outputs);
    if ("error" in wf) return { ok: false, error: wf.error };
    const { workflow } = resolveWorkflow({ id: wf.id });
    if (!workflow) return { ok: false, error: "Workflow not found." };

    const nodeId = typeof step.params.nodeId === "string" ? step.params.nodeId : undefined;
    const nodeLabel = typeof step.params.nodeLabel === "string" ? step.params.nodeLabel : undefined;
    // If no node specified, target all agent-capable nodes (mirrors workflow_set_model behavior).
    const agentTypes = new Set(["claude-agent", "integration-agent", "parallel-agents", "spawn-coding-agent"]);
    let targets = (nodeId || nodeLabel)
      ? (() => { const { node } = resolveNode(workflow.nodes, { nodeId, nodeLabel }); return node ? [node] : []; })()
      : workflow.nodes.filter((n) => agentTypes.has(n.type));
    if (targets.length === 0) return { ok: false, error: `No agent node found to set the model on in workflow "${workflow.name}".` };

    const updated: string[] = [];
    const skipped: string[] = [];
    const newNodes = workflow.nodes.map((n) => {
      if (!targets.some((t) => t.id === n.id)) return n;
      const after: Record<string, unknown> = { ...(n.data ?? {}) };
      // Respect agentId binding (a configured agent owns the model) — don't silently override it.
      if ("agentId" in after && after.agentId) {
        skipped.push(`${String(n.data?.label ?? n.id)} (uses an agent binding)`);
        return n;
      }
      after.model = modelRef;
      after.modelRef = modelRef;
      updated.push(String(n.data?.label ?? n.id));
      return { ...n, data: after };
    });
    if (updated.length === 0) {
      return { ok: false, error: `Could not set the model: ${skipped.length ? skipped.join("; ") + ". Update the bound agent's model instead." : "no eligible nodes."}` };
    }
    saveWorkflowNodes(workflow.id, newNodes);
    return { ok: true, output: { workflowId: workflow.id, workflowName: workflow.name, model: modelRef, updated, skipped } };
  } catch (error) {
    return { ok: false, error: `Failed to set workflow node model: ${String(error)}` };
  }
}

async function handleToggleWorkflowActive(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const wf = resolveWorkflowIdForNodeEdit(step, outputs);
    if ("error" in wf) return { ok: false, error: wf.error };
    const { workflow } = resolveWorkflow({ id: wf.id });
    if (!workflow) return { ok: false, error: "Workflow not found." };
    const active = step.params.active === true;
    saveWorkflowActive(workflow.id, active);
    return {
      ok: true,
      output: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        active,
      },
    };
  } catch (error) {
    return { ok: false, error: `Failed to update workflow active state: ${String(error)}` };
  }
}

async function handleScheduleWorkflow(
  step: AppActionStep,
  base: string,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  // Resolve workflow id from prior step if not explicit
  let workflowId = typeof step.params.workflowId === "string" ? step.params.workflowId : null;
  const workflowStepId = typeof step.params.workflowStepId === "string" ? step.params.workflowStepId : null;
  if (!workflowId && workflowStepId) {
    const priorOutput = outputs.get(workflowStepId);
    if (priorOutput && typeof priorOutput === "object" && priorOutput !== null) {
      const priorId = (priorOutput as Record<string, unknown>).id;
      if (typeof priorId === "string") workflowId = priorId;
    }
  }

  if (!workflowId) {
    return {
      ok: true,
      output: {
        note: "Workflow scheduling requires a workflow id. Create the workflow first, then use the Scheduler tab to configure the cron expression.",
      },
    };
  }

  // Trigger cron resync so the new workflow is picked up
  try {
    await fetch(`${base}/api/cron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resync" }),
    });
    return {
      ok: true,
      output: {
        workflowId,
        note: "Cron scheduler resynced. Configure the cron expression in the Scheduler tab.",
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function handleRecommendTemplates(
  step: AppActionStep,
): { ok: boolean; output?: unknown; error?: string } {
  const topic = typeof step.params.topic === "string" ? step.params.topic : "";
  const recommendations = recommendWorkflowTemplates(topic, 5);
  if (recommendations.length === 0) {
    return {
      ok: true,
      output: {
        message: "No workflow templates matched the topic. Use 'list workflow templates' to see all available templates.",
        templates: [],
      },
    };
  }
  return {
    ok: true,
    output: {
      templates: recommendations.map((r) => ({
        key: r.entry.key,
        name: r.entry.name,
        score: r.score,
      })),
    },
  };
}

function handleInformational(
  step: AppActionStep,
): { ok: boolean; output?: unknown; error?: string } {
  switch (step.action) {
    case "run_organization_execution":
      return {
        ok: true,
        output: {
          message:
            "Organization execution mode has been queued. Send a message like 'analyze [topic] using my org' to start.",
        },
      };
    case "connect_channel":
      return {
        ok: true,
        output: {
          message:
            "Channel connections are configured in Settings > Channels. The planner cannot automatically connect channels — please visit that tab and follow the setup instructions.",
        },
      };
    case "summarize_state":
      return {
        ok: true,
        output: {
          message:
            "Use 'show dashboard', 'list agents', 'list workflows', 'list boards', or 'show hierarchy' to get a current state summary.",
        },
      };
    case "ask_clarifying_question":
      return { ok: true, output: { message: step.label } };
    default:
      return { ok: true, output: { message: step.label } };
  }
}

async function handleRunCouncil(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  const topic = typeof step.params.topic === "string" && step.params.topic.trim()
    ? step.params.topic.trim()
    : "Review the requested topic and provide a recommendation.";

  const organization = await resolveOrganizationRef(step.params, outputs);
  const goal = await resolveGoalRef(step.params, outputs, organization?.id ?? null);
  let agentIds = await resolveAgentIdsForCouncil(step.params, outputs, organization?.id ?? null);
  if (agentIds.length < 2 && organization) {
    try {
      const { listHierarchyOrganizationMembers } = await import("@/lib/hierarchy/organizations");
      agentIds = listHierarchyOrganizationMembers(organization.id)
        .filter((member) => member.agentActive !== false && member.agent.isActive !== false)
        .map((member) => member.agent.id)
        .filter(Boolean)
        .slice(0, 12);
    } catch {
      // Fall back to global active agents below.
    }
  }

  if (agentIds.length < 2) {
    try {
      const { getSqlite } = (await import("@/lib/db")) as typeof import("@/lib/db");
      const db = getSqlite();
      const rows = db
        .prepare("SELECT id FROM agents WHERE is_active = 1 ORDER BY is_default DESC, created_at ASC LIMIT 12")
        .all() as Array<{ id: string }>;
      agentIds = rows.map((row) => row.id).slice(0, 12);
    } catch {
      // handled below
    }
  }

  if (agentIds.length < 2) {
    return {
      ok: true,
      output: {
        message: "Council needs at least two active agents. Create or enable more agents, then run the council prompt again.",
        suggestedPrompt: `run a council on ${topic}`,
      },
    };
  }

  const councilMode = enumParam(step.params, "mode", ["poll", "debate"] as const, "debate");
  const rounds = councilMode === "debate" ? clampNumberParam(step.params, "rounds", 3, 2, 5) : 1;
  const decisionMode = enumParam(
    step.params,
    "decisionMode",
    ["majority", "consensus", "weighted", "ranked"] as const,
    "majority",
  );
  const documentIds = await resolveCouncilDocumentIds(step.params, goal);
  const options = stringArrayParam(step.params, "options", 8);
  const explicitSynthesizerAgentId = await resolveSynthesizerAgentId(step.params, organization?.id ?? null);
  const synthesizerAgentId = explicitSynthesizerAgentId ?? (step.params.useModeratorSynthesis === true ? agentIds[0] : undefined);
  const discoverOptions = typeof step.params.discoverOptions === "boolean"
    ? step.params.discoverOptions
    : options.length < 2;
  const costCapUsd = typeof step.params.costCapUsd === "number" && Number.isFinite(step.params.costCapUsd)
    ? step.params.costCapUsd
    : undefined;

  // Budget enforcement: gate the council run against any org/goal/agent budget
  // policy before spending. ~0.003/1k tokens, ~900 tokens/agent × rounds.
  try {
    const organizationId = organization?.id ?? (await import("@/lib/hierarchy/organizations")).getActiveHierarchyOrganization()?.id ?? null;
    const estimatedCostUsd = (agentIds.length * 900 * rounds / 1000) * 0.003;
    const { enforceHierarchyBudgetGate } = await import("@/lib/hierarchy/policies");
    const gate = enforceHierarchyBudgetGate({
      organizationId,
      estimatedCostUsd,
      action: `the ${councilMode} council ${councilMode === "debate" ? `(${rounds} rounds)` : ""}`.trim(),
    });
    if (!gate.allowed) {
      return { ok: false, error: gate.message ?? gate.reason ?? "Council blocked by budget policy." };
    }
    if (gate.requiresApproval) {
      return {
        ok: true,
        output: { message: gate.message, requiresApproval: true, estimatedCostUsd, policyId: gate.policyId },
      };
    }

    // Approval-chain enforcement: gate the council run against any org approval
    // policy (creates/reuses a pending approval request, assigns approver agent).
    const { requireHierarchyApproval } = await import("@/lib/hierarchy/approval-enforcement");
    const approval = requireHierarchyApproval({
      organizationId,
      action: "run_council",
      risk: "medium",
      summary: `Council ${councilMode}: ${topic}`.slice(0, 200),
    });
    if (approval.required) {
      return {
        ok: true,
        output: {
          message: approval.message,
          requiresApproval: true,
          approvalRequestId: approval.request?.id ?? null,
          approverAgentId: approval.request?.approverAgentId ?? null,
        },
      };
    }
  } catch {
    // If policy evaluation fails, do not block the council; fall through.
  }

  try {
    const { runCouncilSession } = await import("@/lib/council/service");
    const result = await runCouncilSession({
      topic,
      agentIds,
      documentIds,
      options: options.length >= 2 ? options : undefined,
      mode: councilMode,
      rounds,
      decisionMode,
      synthesizerAgentId,
      discoverOptions,
      costCapUsd,
    });
    const sessionId = `webchat-council-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { saveCouncilSession } = await import("@/lib/council/persistence");
      saveCouncilSession({
        id: sessionId,
        orgId: organization?.id ?? null,
        topic: result.topic,
        mode: councilMode,
        votingMethod: result.decisionMode,
        participants: agentIds,
        options: result.options,
        result,
        verdict: result.conclusion ?? null,
      });
    } catch {
      // Non-fatal: the WebChat response still carries the council result.
    }

    const createdBoardTaskIds: string[] = [];
    if (step.params.createBoardTaskFromVerdict === true || step.params.createFollowUpTasksFromConcerns === true) {
      try {
        const { createBoardTask } = await import("@/lib/boards/manager");
        const boardId = await resolveFirstBoardId(stringParam(step.params, "boardId"));
        if (step.params.createBoardTaskFromVerdict === true) {
          const verdictTask = createBoardTask({
            boardId,
            title: `Council verdict: ${result.topic.slice(0, 80)}`,
            description: [
              result.winner ? `Winner: ${result.winner}` : "Winner: Undecided",
              `Mode: ${result.decisionMode}`,
              `Council mode: ${councilMode}`,
              `Participants: ${result.participants}`,
              result.conclusion,
              result.synthesis ? `\nSynthesis:\n${result.synthesis}` : "",
            ].filter(Boolean).join("\n"),
            status: "inbox",
            priority: "medium",
            organizationId: organization?.id ?? null,
            goalId: goal?.id ?? null,
            linkedDocumentIds: documentIds,
            sourceType: "council",
            sourceRef: sessionId,
          });
          createdBoardTaskIds.push(verdictTask.id);
        }
        if (step.params.createFollowUpTasksFromConcerns === true) {
          const finalRound = result.rounds ?? 1;
          const concernOpinions = result.opinions
            .filter((opinion) => (opinion.round ?? finalRound) === finalRound)
            .filter((opinion) => String(opinion.concerns || "").trim().length > 10)
            .slice(0, 5);
          for (const opinion of concernOpinions) {
            const followUp = createBoardTask({
              boardId,
              title: `Council concern: ${opinion.concerns.slice(0, 80)}`,
              description: `Raised by ${opinion.agentName} (${opinion.roleTitle}) in council on: ${result.topic}\n\n${opinion.concerns}`,
              status: "inbox",
              priority: "medium",
              organizationId: organization?.id ?? null,
              goalId: goal?.id ?? null,
              linkedDocumentIds: documentIds,
              sourceType: "council",
              sourceRef: sessionId,
            });
            createdBoardTaskIds.push(followUp.id);
          }
        }
      } catch (taskError) {
        return {
          ok: true,
          output: {
            topic: result.topic,
            organizationId: organization?.id ?? null,
            organizationName: organization?.name ?? null,
            goalId: goal?.id ?? null,
            goalName: goal?.name ?? null,
            conclusion: result.conclusion,
            winner: result.winner,
            participants: result.participants,
            simulatedCount: result.simulatedCount,
            synthesis: result.synthesis,
            sessionId,
            boardTaskError: String(taskError),
          },
        };
      }
    }

    return {
      ok: true,
      output: {
        topic: result.topic,
        organizationId: organization?.id ?? null,
        organizationName: organization?.name ?? null,
        goalId: goal?.id ?? null,
        goalName: goal?.name ?? null,
        documentIds,
        mode: councilMode,
        rounds: result.rounds,
        decisionMode: result.decisionMode,
        options: result.options,
        conclusion: result.conclusion,
        winner: result.winner,
        participants: result.participants,
        simulatedCount: result.simulatedCount,
        synthesis: result.synthesis,
        dissentCount: result.dissent.length,
        totalCostUsd: result.totalCostUsd,
        sessionId,
        createdBoardTaskIds,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleRerunCouncilSession(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const session = await resolveCouncilSessionRef(step.params, outputs);
    if (!session) return { ok: false, error: "Could not resolve a Council session to rerun." };
    const priorResult = parseJsonObject(session.result);
    const documentIds = Array.isArray(priorResult?.documentsUsed)
      ? (priorResult.documentsUsed as Array<Record<string, unknown>>).map((doc) => String(doc.id || "")).filter(Boolean)
      : [];
    const { runCouncilSession } = await import("@/lib/council/service");
    const result = await runCouncilSession({
      topic: session.topic,
      agentIds: parseJsonArray(session.participants).slice(0, 12),
      documentIds,
      options: parseJsonArray(session.options).slice(0, 8),
      mode: session.mode === "debate" ? "debate" : "poll",
      rounds: typeof priorResult?.rounds === "number" ? Math.max(2, Math.min(5, Math.round(priorResult.rounds))) : undefined,
      decisionMode: ["majority", "consensus", "weighted", "ranked"].includes(session.votingMethod)
        ? (session.votingMethod as "majority" | "consensus" | "weighted" | "ranked")
        : "majority",
    });
    const newSessionId = `webchat-council-rerun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { saveCouncilSession } = await import("@/lib/council/persistence");
    saveCouncilSession({
      id: newSessionId,
      orgId: session.orgId,
      topic: result.topic,
      mode: session.mode,
      votingMethod: result.decisionMode,
      participants: parseJsonArray(session.participants),
      options: result.options,
      result,
      verdict: result.conclusion ?? null,
    });
    return {
      ok: true,
      output: {
        id: newSessionId,
        sourceSessionId: session.id,
        topic: result.topic,
        conclusion: result.conclusion,
        winner: result.winner,
        participants: result.participants,
        decisionMode: result.decisionMode,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleDeleteCouncilSession(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  const session = await resolveCouncilSessionRef(step.params, outputs);
  if (!session) return { ok: false, error: "Could not resolve a Council session to delete." };
  const { deleteCouncilSession } = await import("@/lib/council/persistence");
  const deleted = deleteCouncilSession(session.id);
  return {
    ok: deleted,
    output: deleted ? { id: session.id, topic: session.topic, deleted: true } : undefined,
    error: deleted ? undefined : "Council session delete failed.",
  };
}

async function handleCreateCouncilVerdictTask(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const session = await resolveCouncilSessionRef(step.params, outputs);
    if (!session) return { ok: false, error: "Could not resolve a Council session for verdict task creation." };
    const priorResult = parseJsonObject(session.result);
    const documentIds = Array.isArray(priorResult?.documentsUsed)
      ? (priorResult.documentsUsed as Array<Record<string, unknown>>).map((doc) => String(doc.id || "")).filter(Boolean)
      : [];
    const boardId = await resolveFirstBoardId(stringParam(step.params, "boardId"));
    const { createBoardTask } = await import("@/lib/boards/manager");
    const task = createBoardTask({
      boardId,
      title: `Council verdict: ${session.topic.slice(0, 80)}`,
      description: [
        priorResult?.winner ? `Winner: ${String(priorResult.winner)}` : "Winner: Undecided",
        `Mode: ${session.votingMethod}`,
        `Participants: ${parseJsonArray(session.participants).length}`,
        session.verdict ?? "",
      ].filter(Boolean).join("\n"),
      status: "inbox",
      priority: "medium",
      organizationId: session.orgId,
      linkedDocumentIds: documentIds,
      sourceType: "council",
      sourceRef: session.id,
    });
    return { ok: true, output: { id: task.id, title: task.title, boardId, sessionId: session.id } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Hierarchy reference resolvers
// ---------------------------------------------------------------------------

function extractIdFromStepOutput(outputs: StepOutputMap, stepId: string | null | undefined): string | null {
  if (!stepId) return null;
  const prior = outputs.get(stepId);
  if (prior && typeof prior === "object" && prior !== null) {
    const id = (prior as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  return null;
}

type HierarchyOrgRecord = Awaited<ReturnType<typeof import("@/lib/hierarchy/organizations")["getActiveHierarchyOrganization"]>>;

async function resolveOrganizationRef(
  params: Record<string, unknown>,
  outputs: StepOutputMap,
): Promise<NonNullable<HierarchyOrgRecord> | null> {
  const {
    getActiveHierarchyOrganization,
    resolveHierarchyOrganization,
    getHierarchyOrganizationById,
  } = await import("@/lib/hierarchy/organizations");

  const stepId = typeof params.organizationStepId === "string" ? params.organizationStepId : null;
  const fromStep = extractIdFromStepOutput(outputs, stepId);
  if (fromStep) {
    const byStep = getHierarchyOrganizationById(fromStep) ?? resolveHierarchyOrganization(fromStep);
    if (byStep) return byStep;
  }

  if (typeof params.organizationId === "string" && params.organizationId.trim()) {
    // organizationId may itself reference a prior step output id
    const viaStep = extractIdFromStepOutput(outputs, params.organizationId);
    const found =
      (viaStep ? getHierarchyOrganizationById(viaStep) : null) ??
      resolveHierarchyOrganization(params.organizationId);
    if (found) return found;
  }

  if (typeof params.organizationName === "string" && params.organizationName.trim()) {
    const byName = resolveHierarchyOrganization(params.organizationName);
    if (byName) return byName;
  }

  return getActiveHierarchyOrganization();
}

async function resolveGoalRef(
  params: Record<string, unknown>,
  outputs: StepOutputMap,
  organizationId?: string | null,
) {
  const { getHierarchyGoalById, resolveHierarchyGoal } = await import("@/lib/hierarchy/goals");

  const stepId = typeof params.goalStepId === "string" ? params.goalStepId : null;
  const fromStep = extractIdFromStepOutput(outputs, stepId);
  if (fromStep) {
    const byStep = getHierarchyGoalById(fromStep);
    if (byStep) return byStep;
  }

  if (typeof params.goalId === "string" && params.goalId.trim()) {
    const direct = getHierarchyGoalById(params.goalId) ?? resolveHierarchyGoal(params.goalId, organizationId ?? null);
    if (direct) return direct;
  }

  if (typeof params.goalName === "string" && params.goalName.trim()) {
    const byName = resolveHierarchyGoal(params.goalName, organizationId ?? null);
    if (byName) return byName;
  }

  return null;
}

async function resolveAgentRef(
  params: Record<string, unknown>,
  outputs: StepOutputMap,
  organizationId?: string | null,
  nameKey: "agentName" | "reportsToAgentName" = "agentName",
  idKey: "agentId" | "reportsToAgentId" = "agentId",
  stepKey: "agentStepId" = "agentStepId",
) {
  const { getAgentById, listAgents } = await import("@/lib/agents/registry");

  if (idKey === "agentId") {
    const fromStep = resolveAgentIdFromStep(
      { id: "", action: "create_agent", label: "", params } as unknown as AppActionStep,
      outputs,
    );
    if (fromStep) {
      const agent = getAgentById(fromStep);
      if (agent) return agent;
    }
  }

  const explicitId = typeof params[idKey] === "string" ? String(params[idKey]).trim() : "";
  if (explicitId) {
    const byId = getAgentById(explicitId);
    if (byId) return byId;
  }

  const name = typeof params[nameKey] === "string" ? String(params[nameKey]).trim() : "";
  if (name) {
    const lower = name.toLowerCase();
    let candidates = listAgents();
    if (organizationId) {
      try {
        const { listHierarchyOrganizationMembers } = await import("@/lib/hierarchy/organizations");
        const memberIds = new Set(
          listHierarchyOrganizationMembers(organizationId).map((member) => member.agent.id),
        );
        const scoped = candidates.filter((agent) => memberIds.has(agent.id));
        if (scoped.length > 0) candidates = scoped;
      } catch {
        // fall back to global agent list
      }
    }
    const exact = candidates.find((agent) => agent.name.toLowerCase() === lower);
    if (exact) return exact;
    const partial = candidates.find((agent) => agent.name.toLowerCase().includes(lower));
    if (partial) return partial;
  }

  return null;
}

async function resolveAgentIdsForCouncil(
  params: Record<string, unknown>,
  outputs: StepOutputMap,
  organizationId?: string | null,
): Promise<string[]> {
  const resolved: string[] = [];

  const agentStepId = stringParam(params, "agentStepId");
  if (agentStepId) {
    const priorOutput = outputs.get(agentStepId);
    if (priorOutput && typeof priorOutput === "object" && priorOutput !== null) {
      const ids = (priorOutput as Record<string, unknown>).ids;
      if (Array.isArray(ids)) resolved.push(...ids.map(String).filter(Boolean));
    }
  }

  resolved.push(...stringArrayParam(params, "agentIds", 12));

  const names = stringArrayParam(params, "agentNames", 12);
  if (names.length > 0) {
    const { listAgents } = await import("@/lib/agents/registry");
    let candidates = listAgents().filter((agent) => agent.isActive);
    if (organizationId) {
      try {
        const { listHierarchyOrganizationMembers } = await import("@/lib/hierarchy/organizations");
        const memberIds = new Set(listHierarchyOrganizationMembers(organizationId).map((member) => member.agent.id));
        const scoped = candidates.filter((agent) => memberIds.has(agent.id));
        if (scoped.length > 0) candidates = scoped;
      } catch {
        // fall back to global candidates
      }
    }
    for (const name of names) {
      const lower = name.toLowerCase();
      const match =
        candidates.find((agent) => agent.id === name) ??
        candidates.find((agent) => agent.name.toLowerCase() === lower) ??
        candidates.find((agent) => agent.name.toLowerCase().includes(lower));
      if (match) resolved.push(match.id);
    }
  }

  if (resolved.length < 2) {
    for (const output of outputs.values()) {
      if (output && typeof output === "object" && output !== null) {
        const ids = (output as Record<string, unknown>).ids;
        if (Array.isArray(ids)) resolved.push(...ids.map(String).filter(Boolean));
      }
    }
  }

  return Array.from(new Set(resolved.filter(Boolean))).slice(0, 12);
}

async function resolveSynthesizerAgentId(
  params: Record<string, unknown>,
  organizationId?: string | null,
): Promise<string | undefined> {
  const explicitId = stringParam(params, "synthesizerAgentId");
  if (explicitId) return explicitId;
  const name = stringParam(params, "synthesizerAgentName");
  if (!name) return undefined;

  const { listAgents } = await import("@/lib/agents/registry");
  let candidates = listAgents().filter((agent) => agent.isActive);
  if (organizationId) {
    try {
      const { listHierarchyOrganizationMembers } = await import("@/lib/hierarchy/organizations");
      const memberIds = new Set(listHierarchyOrganizationMembers(organizationId).map((member) => member.agent.id));
      const scoped = candidates.filter((agent) => memberIds.has(agent.id));
      if (scoped.length > 0) candidates = scoped;
    } catch {
      // fall back to all active agents
    }
  }
  const lower = name.toLowerCase();
  return (
    candidates.find((agent) => agent.id === name) ??
    candidates.find((agent) => agent.name.toLowerCase() === lower) ??
    candidates.find((agent) => agent.name.toLowerCase().includes(lower))
  )?.id;
}

async function resolveCouncilDocumentIds(
  params: Record<string, unknown>,
  goal: { linkedDocumentIds?: string[] } | null | undefined,
): Promise<string[]> {
  const resolved = [...stringArrayParam(params, "documentIds", 6)];
  const names = stringArrayParam(params, "documentNames", 6);
  if (names.length > 0) {
    const { getDocumentById, getDocumentByName, listDocuments } = await import("@/lib/documents/store");
    const allDocs = listDocuments();
    for (const name of names) {
      const lower = name.toLowerCase();
      const byId = getDocumentById(name);
      const byName = getDocumentByName(name);
      const byList =
        allDocs.find((doc) => doc.name.toLowerCase() === lower) ??
        allDocs.find((doc) => doc.name.toLowerCase().includes(lower));
      const doc = byId ?? byName ?? byList ?? null;
      if (doc) resolved.push(doc.id);
    }
  }

  const shouldUseGoalDocuments =
    params.useGoalDocuments === true ||
    (resolved.length === 0 && Boolean(goal) && (params.goalId !== undefined || params.goalName !== undefined || params.goalStepId !== undefined));
  if (shouldUseGoalDocuments && Array.isArray(goal?.linkedDocumentIds)) {
    resolved.push(...goal.linkedDocumentIds);
  }

  return Array.from(new Set(resolved.filter(Boolean))).slice(0, 6);
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function resolveCouncilSessionRef(params: Record<string, unknown>, outputs: StepOutputMap) {
  const { getCouncilSession, listCouncilSessions } = await import("@/lib/council/persistence");
  const explicitSessionId = stringParam(params, "sessionId") ?? extractIdFromStepOutput(outputs, stringParam(params, "sessionStepId"));
  if (explicitSessionId) {
    const direct = getCouncilSession(explicitSessionId);
    if (direct) return direct;
  }
  const org = await resolveOrganizationRef(params, outputs);
  const topic = stringParam(params, "topic")?.toLowerCase();
  const sessions = listCouncilSessions(org?.id ?? null, 50);
  if (!topic) return sessions[0] ?? null;
  return (
    sessions.find((session) => session.topic.toLowerCase() === topic) ??
    sessions.find((session) => session.topic.toLowerCase().includes(topic)) ??
    null
  );
}

async function resolveTemplateRef(params: Record<string, unknown>) {
  const { getCompanyTemplate, listCompanyTemplates } = await import("@/lib/hierarchy/company-templates");

  if (typeof params.templateId === "string" && params.templateId.trim()) {
    const byId = getCompanyTemplate(params.templateId);
    if (byId) return byId;
  }

  const name = typeof params.templateName === "string" ? params.templateName.trim().toLowerCase() : "";
  if (name) {
    const templates = listCompanyTemplates();
    return (
      templates.find((template) => template.id.toLowerCase() === name) ??
      templates.find((template) => template.name.toLowerCase() === name) ??
      templates.find((template) => template.name.toLowerCase().includes(name)) ??
      templates.find((template) => template.tags.some((tag) => name.includes(tag.toLowerCase()))) ??
      null
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Hierarchy action handlers
// ---------------------------------------------------------------------------

async function handleUpdateOrganization(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const org = await resolveOrganizationRef(step.params, outputs);
    if (!org) return { ok: false, error: "Could not resolve an organization to update." };
    const { updateHierarchyOrganization } = await import("@/lib/hierarchy/organizations");
    const patch: { name?: string; description?: string | null; mission?: string | null; activate?: boolean } = {};
    if (typeof step.params.name === "string") patch.name = step.params.name;
    if (step.params.description !== undefined) patch.description = step.params.description as string | null;
    if (step.params.mission !== undefined) patch.mission = step.params.mission as string | null;
    if (typeof step.params.activate === "boolean") patch.activate = step.params.activate;
    const updated = updateHierarchyOrganization(org.id, patch);
    return {
      ok: true,
      output: {
        id: updated.id,
        name: updated.name,
        mission: updated.mission,
        memberCount: updated.memberCount,
        isActive: updated.isActive,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleSwitchOrganization(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const org = await resolveOrganizationRef(step.params, outputs);
    if (!org) return { ok: false, error: "Could not resolve an organization to switch to." };
    const { applyHierarchyOrganization } = await import("@/lib/hierarchy/organizations");
    const active = applyHierarchyOrganization(org.id);
    return {
      ok: true,
      output: { id: active.id, name: active.name, memberCount: active.memberCount, isActive: true },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleApplyOrgTemplate(
  step: AppActionStep,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const template = await resolveTemplateRef(step.params);
    if (!template) {
      const { listCompanyTemplates } = await import("@/lib/hierarchy/company-templates");
      const names = listCompanyTemplates().map((t) => t.name).join(", ");
      return { ok: false, error: `No matching company template. Available templates: ${names}` };
    }
    const { applyCompanyTemplate } = await import("@/lib/hierarchy/company-templates");
    const applied = applyCompanyTemplate({
      templateId: template.id,
      organizationName: typeof step.params.organizationName === "string" ? step.params.organizationName : null,
      activate: step.params.activate !== false,
    });
    return {
      ok: true,
      output: {
        id: applied.organization.id,
        name: applied.organization.name,
        template: template.name,
        createdAgents: applied.createdAgents.map((agent) => ({ id: agent.id, name: agent.name })),
        agentCount: applied.organization.memberCount,
        goals: applied.goals.map((goal) => ({ id: goal.id, name: goal.name })),
        goalCount: applied.goals.length,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleUpdateGoal(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const org = await resolveOrganizationRef(step.params, outputs);
    const goal = await resolveGoalRef(step.params, outputs, org?.id ?? null);
    if (!goal) return { ok: false, error: "Could not resolve a goal to update." };

    const { updateHierarchyGoal, resolveHierarchyGoal } = await import("@/lib/hierarchy/goals");
    const patch: Record<string, unknown> = {};
    if (typeof step.params.name === "string") patch.name = step.params.name;
    if (step.params.description !== undefined) patch.description = step.params.description;
    if (typeof step.params.status === "string") patch.status = step.params.status;
    if (step.params.level !== undefined) patch.level = step.params.level;

    if (step.params.parentGoalId !== undefined) {
      patch.parentGoalId = step.params.parentGoalId;
    }
    if (typeof step.params.parentGoalName === "string" && step.params.parentGoalName.trim()) {
      const parent = resolveHierarchyGoal(step.params.parentGoalName, goal.organizationId);
      if (parent && parent.id !== goal.id) patch.parentGoalId = parent.id;
    }

    const updated = updateHierarchyGoal(goal.id, patch);
    return {
      ok: true,
      output: {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        level: updated.level,
        parentGoalId: updated.parentGoalId,
        parentGoalName: updated.parentGoalName,
        organizationId: updated.organizationId,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleUpdateAgentRole(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const org = await resolveOrganizationRef(step.params, outputs);
    const agent = await resolveAgentRef(step.params, outputs, org?.id ?? null);
    if (!agent) return { ok: false, error: "Could not resolve which agent's role to update." };

    const { updateAgentRole } = await import("@/lib/agents/roles");
    const patch: Record<string, unknown> = {};
    if (typeof step.params.roleType === "string") patch.roleType = step.params.roleType;
    if (typeof step.params.roleTitle === "string") patch.roleTitle = step.params.roleTitle;
    if (typeof step.params.roleDescription === "string") patch.roleDescription = step.params.roleDescription;
    if (Array.isArray(step.params.capabilities)) patch.capabilities = step.params.capabilities;
    if (typeof step.params.voteWeight === "number") patch.voteWeight = step.params.voteWeight;

    if (step.params.reportsToAgentId !== undefined && step.params.reportsToAgentId === null) {
      patch.reportsTo = null;
    } else if (typeof step.params.reportsToAgentId === "string" && step.params.reportsToAgentId.trim()) {
      patch.reportsTo = step.params.reportsToAgentId.trim();
    }
    if (typeof step.params.reportsToAgentName === "string" && step.params.reportsToAgentName.trim()) {
      const manager = await resolveAgentRef(
        step.params,
        outputs,
        org?.id ?? null,
        "reportsToAgentName",
        "reportsToAgentId",
      );
      if (manager) patch.reportsTo = manager.id;
    }

    const role = updateAgentRole(agent.id, patch);
    return {
      ok: true,
      output: {
        agentId: agent.id,
        agentName: agent.name,
        roleType: role.roleType,
        roleTitle: role.roleTitle,
        reportsTo: role.reportsTo,
        capabilities: role.capabilities,
        voteWeight: role.voteWeight,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleUpdateAgentModelProfile(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const org = await resolveOrganizationRef(step.params, outputs);
    const agent = await resolveAgentRef(step.params, outputs, org?.id ?? null);
    if (!agent) return { ok: false, error: "Could not resolve which agent to update." };

    const { updateAgent } = await import("@/lib/agents/registry");
    const { recordHierarchyActivityEvent } = await import("@/lib/hierarchy/activity");
    const patch: Record<string, unknown> = {};
    for (const key of [
      "modelRef",
      "systemPrompt",
      "temperature",
      "maxTokens",
      "enabledSkills",
      "enabledToolsets",
      "enabledExtensions",
      "disabledTools",
      "spendCapUsd",
      "spendWindowDays",
      "budgetAction",
    ]) {
      if (step.params[key] !== undefined) patch[key] = step.params[key];
    }
    const updated = updateAgent(agent.id, patch);
    recordHierarchyActivityEvent({
      organizationId: org?.id ?? null,
      agentId: updated.id,
      eventType: "agent.profile_updated",
      title: `Agent profile updated: ${updated.name}`,
      summary: "Updated agent model/profile/skills/budget settings from WebChat.",
      metadata: {
        modelRef: updated.modelRef,
        enabledSkills: updated.enabledSkills,
        enabledToolsets: updated.enabledToolsets,
        enabledExtensions: updated.enabledExtensions,
        spendCapUsd: updated.spendCapUsd,
        budgetAction: updated.budgetAction,
      },
    });
    return {
      ok: true,
      output: {
        agentId: updated.id,
        name: updated.name,
        modelRef: updated.modelRef,
        temperature: updated.temperature,
        maxTokens: updated.maxTokens,
        enabledSkills: updated.enabledSkills,
        enabledToolsets: updated.enabledToolsets,
        enabledExtensions: updated.enabledExtensions,
        spendCapUsd: updated.spendCapUsd,
        budgetAction: updated.budgetAction,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleSetHierarchyBudgetPolicy(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const org = await resolveOrganizationRef(step.params, outputs);
    const goal = await resolveGoalRef(step.params, outputs, org?.id ?? null);
    const agent = await resolveAgentRef(step.params, outputs, org?.id ?? null);
    const { upsertHierarchyBudgetPolicy } = await import("@/lib/hierarchy/policies");
    const policy = upsertHierarchyBudgetPolicy({
      organizationId: org?.id ?? null,
      goalId: goal?.id ?? (typeof step.params.goalId === "string" ? step.params.goalId : null),
      agentId: agent?.id ?? (typeof step.params.agentId === "string" ? step.params.agentId : null),
      scope: step.params.scope as "organization" | "goal" | "agent",
      softLimitUsd: step.params.softLimitUsd as number | null | undefined,
      hardLimitUsd: step.params.hardLimitUsd as number | null | undefined,
      requireApprovalAboveUsd: step.params.requireApprovalAboveUsd as number | null | undefined,
      period: step.params.period as "daily" | "weekly" | "monthly" | "total" | undefined,
      isActive: step.params.isActive as boolean | undefined,
    });
    return { ok: true, output: policy };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleSetHierarchyApprovalPolicy(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const org = await resolveOrganizationRef(step.params, outputs);
    const approver =
      typeof step.params.approverAgentName === "string" || typeof step.params.approverAgentId === "string"
        ? await resolveAgentRef(
            { ...step.params, agentName: step.params.approverAgentName, agentId: step.params.approverAgentId },
            outputs,
            org?.id ?? null,
          )
        : null;
    const { upsertHierarchyApprovalPolicy } = await import("@/lib/hierarchy/policies");
    const policy = upsertHierarchyApprovalPolicy({
      organizationId: org?.id ?? null,
      scope: step.params.scope as "organization" | "goal" | "agent",
      actionPattern: String(step.params.actionPattern || "*"),
      approverAgentId: approver?.id ?? (step.params.approverAgentId as string | null | undefined),
      requireHuman: step.params.requireHuman as boolean | undefined,
      minRisk: step.params.minRisk as "low" | "medium" | "high" | undefined,
      isActive: step.params.isActive as boolean | undefined,
    });
    return { ok: true, output: policy };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleSummarizeHierarchyActivity(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const org = await resolveOrganizationRef(step.params, outputs);
    const goal = await resolveGoalRef(step.params, outputs, org?.id ?? null);
    const agent = await resolveAgentRef(step.params, outputs, org?.id ?? null);
    const { summarizeHierarchyActivity } = await import("@/lib/hierarchy/activity");
    const summary = summarizeHierarchyActivity({
      organizationId: org?.id ?? null,
      goalId: goal?.id ?? null,
      agentId: agent?.id ?? null,
      limit: typeof step.params.limit === "number" ? step.params.limit : 12,
    });
    return { ok: true, output: summary };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleAssignAgentsToOrganization(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const org = await resolveOrganizationRef(step.params, outputs);
    if (!org) return { ok: false, error: "Could not resolve the organization to assign agents to." };

    let agentIds: string[] = Array.isArray(step.params.agentIds)
      ? step.params.agentIds.map(String).filter(Boolean)
      : [];

    const agentStepId = typeof step.params.agentStepId === "string" ? step.params.agentStepId : null;
    if (agentStepId) {
      const prior = outputs.get(agentStepId);
      if (prior && typeof prior === "object" && prior !== null) {
        const ids = (prior as Record<string, unknown>).ids;
        if (Array.isArray(ids)) agentIds.push(...ids.map(String).filter(Boolean));
        const single = (prior as Record<string, unknown>).id;
        if (typeof single === "string") agentIds.push(single);
      }
    }
    agentIds = Array.from(new Set(agentIds));
    if (agentIds.length === 0) {
      return { ok: false, error: "No agents available to add to the organization." };
    }

    const { addAgentsToHierarchyOrganization } = await import("@/lib/hierarchy/organizations");
    const updated = addAgentsToHierarchyOrganization(org.id, agentIds);
    return {
      ok: true,
      output: {
        id: updated.id,
        name: updated.name,
        memberCount: updated.memberCount,
        assignedAgentIds: agentIds,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleAssignGoalToOrgAgents(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const org = await resolveOrganizationRef(step.params, outputs);
    if (!org) return { ok: false, error: "Could not resolve the organization for goal assignment." };
    const goal = await resolveGoalRef(step.params, outputs, org.id);
    if (!goal) return { ok: false, error: "Could not resolve the goal to assign." };

    const { listHierarchyOrganizationMembers } = await import("@/lib/hierarchy/organizations");
    const members = listHierarchyOrganizationMembers(org.id).filter((member) => member.agentActive);
    if (members.length === 0) {
      return { ok: false, error: "The organization has no active agents to assign." };
    }

    const { createBoardTask } = await import("@/lib/boards/manager");
    let boardId = "main-board";
    try {
      const { getSqlite } = (await import("@/lib/db")) as typeof import("@/lib/db");
      const row = getSqlite()
        .prepare("SELECT id FROM boards ORDER BY created_at ASC LIMIT 1")
        .get() as { id: string } | undefined;
      if (row?.id) boardId = row.id;
    } catch {
      // keep default
    }

    const priority = typeof step.params.priority === "string" ? step.params.priority : "medium";
    const baseTitle = typeof step.params.title === "string" && step.params.title.trim()
      ? step.params.title.trim()
      : goal.name;
    const description = typeof step.params.description === "string" ? step.params.description : undefined;

    const created: string[] = [];
    const assignedNames: string[] = [];
    for (const member of members) {
      try {
        const task = createBoardTask({
          boardId,
          title: `${baseTitle} — ${member.role.roleTitle || member.agent.name}`,
          description,
          status: "inbox",
          priority: priority as "low" | "medium" | "high",
          organizationId: org.id,
          goalId: goal.id,
          assignedAgentId: member.agent.id,
        });
        created.push(task.id);
        assignedNames.push(member.agent.name);
      } catch {
        // continue with next member
      }
    }

    if (created.length === 0) {
      return { ok: false, error: "Could not create any board tasks for the assignment." };
    }

    return {
      ok: true,
      output: {
        goalId: goal.id,
        goalName: goal.name,
        organizationId: org.id,
        created: created.length,
        total: members.length,
        agentNames: assignedNames,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleLinkGoalSources(
  step: AppActionStep,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const org = await resolveOrganizationRef(step.params, outputs);
    const goal = await resolveGoalRef(step.params, outputs, org?.id ?? null);
    if (!goal) return { ok: false, error: "Could not resolve the goal to attach sources to." };

    const { listDocuments, searchDocuments } = await import("@/lib/documents/store");
    const allDocs = listDocuments();
    const docsById = new Map(allDocs.map((doc) => [doc.id, doc]));

    const resolvedIds: string[] = [];
    const resolvedNames: string[] = [];

    for (const rawId of Array.isArray(step.params.documentIds) ? step.params.documentIds : []) {
      const id = String(rawId || "").trim();
      const doc = docsById.get(id);
      if (doc) {
        resolvedIds.push(doc.id);
        resolvedNames.push(doc.name);
      }
    }

    for (const rawName of Array.isArray(step.params.documentNames) ? step.params.documentNames : []) {
      const name = String(rawName || "").trim();
      if (!name) continue;
      const lower = name.toLowerCase();
      const exact = allDocs.find((doc) => doc.name.toLowerCase() === lower);
      const match = exact ?? searchDocuments(name, 1)[0] ?? allDocs.find((doc) => doc.name.toLowerCase().includes(lower));
      if (match && !resolvedIds.includes(match.id)) {
        resolvedIds.push(match.id);
        resolvedNames.push(match.name);
      }
    }

    if (resolvedIds.length === 0) {
      return { ok: false, error: "No matching documents/data sources were found to attach." };
    }

    const mode = step.params.mode === "replace" ? "replace" : "append";
    const nextIds =
      mode === "replace"
        ? resolvedIds
        : Array.from(new Set([...goal.linkedDocumentIds, ...resolvedIds]));

    const { updateHierarchyGoal } = await import("@/lib/hierarchy/goals");
    const updated = updateHierarchyGoal(goal.id, { linkedDocumentIds: nextIds });

    return {
      ok: true,
      output: {
        goalId: updated.id,
        goalName: updated.name,
        mode,
        linkedCount: updated.linkedDocumentIds.length,
        attachedNames: resolvedNames,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleExportOrgPackage(
  step: AppActionStep,
  base: string,
  outputs: StepOutputMap,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const org = await resolveOrganizationRef(step.params, outputs);
    if (!org) return { ok: false, error: "Could not resolve the organization to export." };

    const { ok, status, data } = await fetchJson(`${base}/api/hierarchy/export?orgId=${encodeURIComponent(org.id)}`, {
      method: "GET",
    });
    if (!ok || !data.success) {
      return { ok: false, error: data.error ?? `HTTP ${status}` };
    }

    const pkg = data.data as { organization?: { name?: string; agents?: unknown[] }; goals?: unknown[] } | undefined;
    return {
      ok: true,
      output: {
        organizationId: org.id,
        organizationName: pkg?.organization?.name ?? org.name,
        agentCount: Array.isArray(pkg?.organization?.agents) ? pkg!.organization!.agents!.length : org.memberCount,
        goalCount: Array.isArray(pkg?.goals) ? pkg!.goals!.length : 0,
        downloadHint: `Use Hierarchy > Export, or GET /api/hierarchy/export?orgId=${org.id}, to download the package JSON.`,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Dynamic workflow action handlers
// ---------------------------------------------------------------------------

async function handlePlanDynamicWorkflow(
  step: AppActionStep,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const prompt = typeof step.params.prompt === "string" ? step.params.prompt : "";
    const { generatePlanOutline } = await import("@/lib/dynamic-workflows/planner");
    const result = generatePlanOutline(prompt);
    return { ok: true, output: { plan: result.plan } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleCreateDynamicWorkflowRun(
  step: AppActionStep,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const planJson = typeof step.params.planJson === "string" ? step.params.planJson : null;
    const approve = step.params.approve === true;
    const { validatePlan } = await import("@/lib/dynamic-workflows/planner");
    const { createAndStartRun } = await import("@/lib/dynamic-workflows/runner");

    if (!planJson) {
      return { ok: false, error: "planJson is required to create a dynamic workflow run." };
    }

    let plan: unknown;
    try {
      plan = JSON.parse(planJson);
    } catch {
      return { ok: false, error: "planJson is not valid JSON." };
    }

    const validation = validatePlan(plan);
    if (!validation.success) {
      return { ok: false, error: `Plan validation failed: ${validation.error}` };
    }

    const validPlan = validation.plan;

    const run = await createAndStartRun(validPlan, {
      name: `Planned Run ${new Date().toISOString().slice(0, 16)}`,
      sourceType: "webchat",
    });

    if (!approve) {
      return { ok: true, output: { run, plan: validPlan, pendingApproval: true } };
    }

    return { ok: true, output: { run, plan: validPlan, started: true } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleStartDynamicWorkflowRun(
  step: AppActionStep,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const runId = typeof step.params.runId === "string" ? step.params.runId : null;
    if (!runId) return { ok: false, error: "runId is required." };

    const { executeRun, getRunProgress } = await import("@/lib/dynamic-workflows/runner");
    const { getDynamicWorkflowRun } = await import("@/lib/dynamic-workflows/store");
    const run = getDynamicWorkflowRun(runId);
    if (!run) return { ok: false, error: `Run not found: ${runId}` };

    void executeRun(runId).catch(() => {});
    const progress = getRunProgress(runId);
    return { ok: true, output: { runId, status: run.status, progress } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handlePauseDynamicWorkflowRun(
  step: AppActionStep,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const runId = typeof step.params.runId === "string" ? step.params.runId : null;
    if (!runId) return { ok: false, error: "runId is required." };

    const { pauseRun } = await import("@/lib/dynamic-workflows/runner");
    pauseRun(runId);
    return { ok: true, output: { runId, paused: true } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleResumeDynamicWorkflowRun(
  step: AppActionStep,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const runId = typeof step.params.runId === "string" ? step.params.runId : null;
    if (!runId) return { ok: false, error: "runId is required." };

    const { resumeRun } = await import("@/lib/dynamic-workflows/runner");
    await resumeRun(runId);
    return { ok: true, output: { runId, resumed: true } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleCancelDynamicWorkflowRun(
  step: AppActionStep,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const runId = typeof step.params.runId === "string" ? step.params.runId : null;
    if (!runId) return { ok: false, error: "runId is required." };

    const { cancelRun } = await import("@/lib/dynamic-workflows/runner");
    cancelRun(runId);
    return { ok: true, output: { runId, cancelled: true } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleRestartDynamicWorkflowWorker(
  step: AppActionStep,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const runId = typeof step.params.runId === "string" ? step.params.runId : null;
    const workerId = typeof step.params.workerId === "string" ? step.params.workerId : null;
    if (!runId || !workerId) return { ok: false, error: "runId and workerId are required." };

    const { restartWorker } = await import("@/lib/dynamic-workflows/runner");
    await restartWorker(runId, workerId);
    return { ok: true, output: { runId, workerId, restarted: true } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleSaveDynamicWorkflowCommand(
  step: AppActionStep,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const runId = typeof step.params.runId === "string" ? step.params.runId : null;
    const commandName = typeof step.params.commandName === "string" ? step.params.commandName : null;
    if (!runId || !commandName) return { ok: false, error: "runId and commandName are required." };

    const { saveRunAsCommand } = await import("@/lib/dynamic-workflows/commands");
    const command = saveRunAsCommand(runId, commandName);
    return { ok: true, output: { command } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleRunHarnessTemplate(
  step: AppActionStep,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  try {
    const templateId = typeof step.params.templateId === "string" ? step.params.templateId : null;
    if (!templateId) return { ok: false, error: "templateId is required." };

    const { getHarnessTemplate, applyHarnessTemplate } = await import("@/lib/dynamic-workflows/harness-templates");
    const { createAndStartRun } = await import("@/lib/dynamic-workflows/runner");

    const template = getHarnessTemplate(templateId);
    if (!template) return { ok: false, error: `Harness template not found: ${templateId}` };

    const inputs = (step.params.inputs as Record<string, unknown> | undefined) ?? {};
    const plan = applyHarnessTemplate(template.id, inputs);

    const run = await createAndStartRun(plan, {
      name: `${template.name} ${new Date().toISOString().slice(0, 16)}`,
      description: template.description ?? undefined,
      sourceType: "harness_template",
      sourceRef: template.id,
    });

    return { ok: true, output: { template, plan, run } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeAppActionPlan(
  plan: AppActionPlan,
  ctx: {
    sessionId: string;
    channel: string;
    internalBaseUrl?: string | null;
  },
): Promise<AppActionExecutionReport> {
  const base = resolveBase(ctx.internalBaseUrl);
  const sorted = topoSort(plan.steps);
  const outputs: StepOutputMap = new Map();
  const stepResults: AppActionStepResult[] = [];
  let stepsSucceeded = 0;

  for (const step of sorted) {
    // Check all dependencies succeeded
    const failedDep = (step.dependsOn ?? []).find((depId) => {
      const depResult = stepResults.find((r) => r.id === depId);
      return depResult && !depResult.ok;
    });
    if (failedDep) {
      stepResults.push({
        id: step.id,
        action: step.action,
        ok: false,
        error: `Skipped: dependency step "${failedDep}" failed.`,
      });
      continue;
    }

    log.debug("executeAppActionPlan: running step", { id: step.id, action: step.action });

    let result: { ok: boolean; output?: unknown; error?: string };

    try {
      switch (step.action) {
        case "create_agent":
          result = await handleCreateAgent(step, base);
          break;
        case "create_agents":
          result = await handleCreateAgents(step, base);
          break;
        case "create_organization":
          result = await handleCreateOrganization(step, base, outputs);
          break;
        case "update_organization":
          result = await handleUpdateOrganization(step, outputs);
          break;
        case "switch_organization":
          result = await handleSwitchOrganization(step, outputs);
          break;
        case "apply_org_template":
          result = await handleApplyOrgTemplate(step);
          break;
        case "assign_agents_to_organization":
          result = await handleAssignAgentsToOrganization(step, outputs);
          break;
        case "update_goal":
          result = await handleUpdateGoal(step, outputs);
          break;
        case "update_agent_role":
          result = await handleUpdateAgentRole(step, outputs);
          break;
        case "update_agent_model_profile":
          result = await handleUpdateAgentModelProfile(step, outputs);
          break;
        case "set_hierarchy_budget_policy":
          result = await handleSetHierarchyBudgetPolicy(step, outputs);
          break;
        case "set_hierarchy_approval_policy":
          result = await handleSetHierarchyApprovalPolicy(step, outputs);
          break;
        case "assign_goal_to_org_agents":
          result = await handleAssignGoalToOrgAgents(step, outputs);
          break;
        case "link_goal_sources":
          result = await handleLinkGoalSources(step, outputs);
          break;
        case "export_org_package":
          result = await handleExportOrgPackage(step, base, outputs);
          break;
        case "create_board_task":
          result = await handleCreateBoardTask(step, base, outputs);
          break;
        case "assign_skill_to_agent":
          result = await handleAssignSkillToAgent(step, outputs);
          break;
        case "attach_extension_to_agent":
          result = await handleAttachExtensionToAgent(step, outputs);
          break;
        case "create_goal":
          result = await handleCreateGoal(step, outputs);
          break;
        case "link_board_task_to_organization":
        case "link_board_task_to_agent":
        case "link_board_task_to_goal":
          result = await handleLinkBoardTask(step, base, outputs);
          break;
        case "create_workflow_from_template":
          result = await handleCreateWorkflowFromTemplate(step, base);
          break;
        case "toggle_workflow_active":
          result = await handleToggleWorkflowActive(step, outputs);
          break;
        case "update_workflow_node":
          result = await handleUpdateWorkflowNode(step, outputs);
          break;
        case "set_workflow_node_model":
          result = await handleSetWorkflowNodeModel(step, outputs);
          break;
        case "schedule_workflow":
          result = await handleScheduleWorkflow(step, base, outputs);
          break;
        case "recommend_templates":
          result = handleRecommendTemplates(step);
          break;
        case "summarize_hierarchy_activity":
          result = await handleSummarizeHierarchyActivity(step, outputs);
          break;
        case "run_council":
          result = await handleRunCouncil(step, outputs);
          break;
        case "rerun_council_session":
          result = await handleRerunCouncilSession(step, outputs);
          break;
        case "delete_council_session":
          result = await handleDeleteCouncilSession(step, outputs);
          break;
        case "create_council_verdict_task":
          result = await handleCreateCouncilVerdictTask(step, outputs);
          break;
        case "run_organization_execution":
        case "connect_channel":
        case "summarize_state":
        case "ask_clarifying_question":
          result = handleInformational(step);
          break;
        case "plan_dynamic_workflow":
          result = await handlePlanDynamicWorkflow(step);
          break;
        case "create_dynamic_workflow_run":
          result = await handleCreateDynamicWorkflowRun(step);
          break;
        case "start_dynamic_workflow_run":
          result = await handleStartDynamicWorkflowRun(step);
          break;
        case "pause_dynamic_workflow_run":
          result = await handlePauseDynamicWorkflowRun(step);
          break;
        case "resume_dynamic_workflow_run":
          result = await handleResumeDynamicWorkflowRun(step);
          break;
        case "cancel_dynamic_workflow_run":
          result = await handleCancelDynamicWorkflowRun(step);
          break;
        case "restart_dynamic_workflow_worker":
          result = await handleRestartDynamicWorkflowWorker(step);
          break;
        case "save_dynamic_workflow_command":
          result = await handleSaveDynamicWorkflowCommand(step);
          break;
        case "run_harness_template":
          result = await handleRunHarnessTemplate(step);
          break;
        default: {
          const exhaustiveCheck: never = step.action;
          result = { ok: false, error: `Unknown action: ${String(exhaustiveCheck)}` };
        }
      }
    } catch (err) {
      result = { ok: false, error: String(err) };
    }

    if (result.ok) {
      stepsSucceeded++;
      if (result.output !== undefined) {
        outputs.set(step.id, result.output);
      }
    }

    stepResults.push({
      id: step.id,
      action: step.action,
      ok: result.ok,
      output: result.output,
      error: result.error,
    });

    // Stop at first hard failure in a sequential plan
    if (!result.ok) {
      const remaining = sorted.slice(sorted.indexOf(step) + 1);
      for (const skipped of remaining) {
        const alreadyAdded = stepResults.some((r) => r.id === skipped.id);
        if (!alreadyAdded) {
          stepResults.push({
            id: skipped.id,
            action: skipped.action,
            ok: false,
            error: `Skipped: prior step "${step.id}" failed.`,
          });
        }
      }
      break;
    }
  }

  const summary = buildExecutionSummary(plan, stepResults, stepsSucceeded);

  return {
    stepsAttempted: stepResults.length,
    stepsSucceeded,
    stepResults,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Summary formatter
// ---------------------------------------------------------------------------

function buildExecutionSummary(
  plan: AppActionPlan,
  results: AppActionStepResult[],
  succeeded: number,
): string {
  const total = plan.steps.length;
  if (total === 0) {
    return plan.steps.length === 0 && plan.clarificationQuestion
      ? `Clarification needed: ${plan.clarificationQuestion}`
      : "No steps to execute.";
  }

  const lines: string[] = [];
  lines.push(`Executed ${succeeded} of ${total} planned steps.`);
  lines.push("");

  for (const result of results) {
    const step = plan.steps.find((s) => s.id === result.id);
    const label = step?.label ?? result.action;
    if (result.ok) {
      const outputNote = formatStepOutputNote(result.action, result.output);
      lines.push(`✓ ${label}${outputNote ? ` — ${outputNote}` : ""}`);
    } else {
      lines.push(`✗ ${label} — ${result.error ?? "failed"}`);
    }
  }

  if (succeeded < total) {
    const failedResult = results.find((r) => !r.ok && !r.error?.startsWith("Skipped:"));
    if (failedResult) {
      lines.push("");
      lines.push(`Plan stopped at step "${failedResult.id}": ${failedResult.error ?? "unknown error"}`);
    }
  }

  return lines.join("\n");
}

function formatStepOutputNote(action: AppActionKind, output: unknown): string {
  if (!output || typeof output !== "object") return "";
  const o = output as Record<string, unknown>;

  switch (action) {
    case "create_agent":
      return typeof o.name === "string" ? `Created agent "${o.name}"` : "";
    case "create_agents": {
      const agents = Array.isArray(o.agents) ? o.agents : [];
      return agents.length > 0 ? `Created ${agents.length} agents` : "";
    }
    case "create_organization":
      return typeof o.name === "string" ? `Created org "${o.name}"` : "";
    case "create_board_task":
      return typeof o.title === "string" ? `Task "${o.title}" added` : "";
    case "assign_skill_to_agent": {
      const agentIds = Array.isArray(o.agentIds) ? o.agentIds : [];
      const skillId = typeof o.skillId === "string" ? o.skillId : "skill";
      return agentIds.length > 0 ? `Assigned ${skillId} to ${agentIds.length} agent(s)` : "";
    }
    case "attach_extension_to_agent": {
      const agentIds = Array.isArray(o.agentIds) ? o.agentIds : [];
      const extensionId = typeof o.extensionId === "string" ? o.extensionId : "extension";
      return agentIds.length > 0 ? `Attached ${extensionId} to ${agentIds.length} agent(s)` : "";
    }
    case "create_goal":
      return typeof o.title === "string" ? `Goal "${o.title}" created` : "";
    case "update_organization":
      return typeof o.name === "string" ? `Org "${o.name}" updated${o.isActive ? " (now active)" : ""}` : "";
    case "switch_organization":
      return typeof o.name === "string" ? `Active org is now "${o.name}"` : "";
    case "apply_org_template": {
      const name = typeof o.name === "string" ? o.name : "organization";
      const agentCount = typeof o.agentCount === "number" ? o.agentCount : 0;
      const goalCount = typeof o.goalCount === "number" ? o.goalCount : 0;
      return `Created org "${name}" with ${agentCount} agents and ${goalCount} goals`;
    }
    case "update_goal":
      return typeof o.name === "string"
        ? `Goal "${o.name}" updated${typeof o.status === "string" ? ` (status: ${o.status})` : ""}`
        : "";
    case "update_agent_role": {
      const agentName = typeof o.agentName === "string" ? o.agentName : "agent";
      const roleTitle = typeof o.roleTitle === "string" ? o.roleTitle : "";
      return `${agentName} role updated${roleTitle ? ` to ${roleTitle}` : ""}`;
    }
    case "assign_agents_to_organization": {
      const ids = Array.isArray(o.assignedAgentIds) ? o.assignedAgentIds : [];
      const name = typeof o.name === "string" ? o.name : "org";
      return ids.length > 0 ? `Added ${ids.length} agent(s) to "${name}"` : "";
    }
    case "assign_goal_to_org_agents": {
      const created = typeof o.created === "number" ? o.created : 0;
      const total = typeof o.total === "number" ? o.total : created;
      const goalName = typeof o.goalName === "string" ? o.goalName : "goal";
      return `Assigned "${goalName}" to ${created}/${total} agents`;
    }
    case "link_goal_sources": {
      const count = typeof o.linkedCount === "number" ? o.linkedCount : 0;
      const goalName = typeof o.goalName === "string" ? o.goalName : "goal";
      return `"${goalName}" now has ${count} linked source(s)`;
    }
    case "export_org_package":
      return typeof o.organizationName === "string"
        ? `Exported package for "${o.organizationName}"`
        : "";
    case "create_workflow_from_template":
      return typeof o.name === "string" ? `Workflow "${o.name}" created` : "";
    case "toggle_workflow_active": {
      const name = typeof o.workflowName === "string" ? o.workflowName : "workflow";
      return `Workflow "${name}" ${o.active === true ? "activated" : "deactivated"}`;
    }
    case "recommend_templates": {
      const templates = Array.isArray(o.templates) ? o.templates : [];
      return templates.length > 0 ? `Found ${templates.length} template(s)` : "";
    }
    case "run_council": {
      const conclusion = typeof o.conclusion === "string" ? o.conclusion : "";
      const participants = typeof o.participants === "number" ? ` (${o.participants} participants)` : "";
      return conclusion ? `${conclusion}${participants}` : "";
    }
    case "rerun_council_session": {
      const conclusion = typeof o.conclusion === "string" ? o.conclusion : "";
      return conclusion ? `Reran council: ${conclusion}` : "";
    }
    case "delete_council_session":
      return typeof o.topic === "string" ? `Deleted council session "${o.topic}"` : "";
    case "create_council_verdict_task":
      return typeof o.title === "string" ? `Created verdict task "${o.title}"` : "";
    case "plan_dynamic_workflow": {
      const plan = o.plan as { phases?: unknown[] } | undefined;
      const phaseCount = Array.isArray(plan?.phases) ? plan!.phases!.length : 0;
      return phaseCount > 0 ? `Generated plan with ${phaseCount} phases` : "Plan generated";
    }
    case "create_dynamic_workflow_run": {
      const run = o.run as { name?: string; status?: string } | undefined;
      return run?.name ? `Created run "${run.name}" (${run.status ?? "queued"})` : "";
    }
    case "start_dynamic_workflow_run":
    case "pause_dynamic_workflow_run":
    case "resume_dynamic_workflow_run":
    case "cancel_dynamic_workflow_run":
      return typeof o.runId === "string" ? `Run ${o.runId}` : "";
    case "restart_dynamic_workflow_worker":
      return typeof o.runId === "string" ? `Restarted worker ${o.workerId ?? "?"} in run ${o.runId}` : "";
    case "save_dynamic_workflow_command": {
      const cmd = o.command as { name?: string } | undefined;
      return cmd?.name ? `Saved command "/${cmd.name}"` : "";
    }
    case "run_harness_template": {
      const run = o.run as { name?: string; status?: string } | undefined;
      return run?.name ? `Created harness run "${run.name}"` : "";
    }
    default:
      return typeof o.message === "string" ? o.message : "";
  }
}
