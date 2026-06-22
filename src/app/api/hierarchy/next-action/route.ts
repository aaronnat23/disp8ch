import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { listBoardTasks } from "@/lib/boards/manager";
import { listAgents } from "@/lib/agents/registry";
import { getModelConfig } from "@/lib/agents/model-router";
import { callModel } from "@/lib/agents/multi-provider";
import { listAgentRoles } from "@/lib/agents/roles";
import { listTaskApprovals } from "@/lib/governance/task-approvals";
import { requireOperatorAccess } from "@/lib/security/admin";
import { listHierarchyActivityEvents } from "@/lib/hierarchy/activity";
import { listHierarchyGoals } from "@/lib/hierarchy/goals";
import {
  getActiveHierarchyOrganization,
  listHierarchyOrganizationMembers,
  resolveHierarchyOrganization,
} from "@/lib/hierarchy/organizations";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  organizationId: z.string().min(1).max(120).optional(),
  goalId: z.string().min(1).max(120).optional(),
});

const MODEL_RECOMMENDATION_TIMEOUT_MS = 6000;

type NextActionEvidence = {
  organization: { id: string; name: string } | null;
  counts: {
    agents: number;
    activeAgents: number;
    goals: number;
    activeWork: number;
    blockedTasks: number;
    pendingApprovals: number;
    workflows: number;
    failedWorkflowsLast20: number;
    goalsWithoutScopedWork: number;
    agentsWithoutModel: number;
    agentsWithoutManager: number;
    staleActivityDays: number | null;
  };
  highlights: string[];
};

type NextActionRecommendation = {
  title: string;
  reason: string;
  impact: string;
  confidence: number;
  prompt: string;
  requiresConfirmation: boolean;
  evidence: string[];
  source: "model" | "fallback";
};

function clampConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.6;
  return Math.max(0, Math.min(1, parsed));
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

function normalizeRecommendation(raw: Record<string, unknown>, fallback: NextActionRecommendation): NextActionRecommendation {
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 5)
    : fallback.evidence;
  return {
    title: String(raw.title || fallback.title).trim().slice(0, 160),
    reason: String(raw.reason || fallback.reason).trim().slice(0, 600),
    impact: String(raw.impact || fallback.impact).trim().slice(0, 600),
    confidence: clampConfidence(raw.confidence ?? fallback.confidence),
    prompt: String(raw.prompt || fallback.prompt).trim().slice(0, 1600),
    requiresConfirmation: raw.requiresConfirmation === undefined ? true : Boolean(raw.requiresConfirmation),
    evidence: evidence.length > 0 ? evidence : fallback.evidence,
    source: "model",
  };
}

function buildFallbackRecommendation(evidence: NextActionEvidence): NextActionRecommendation {
  const org = evidence.organization?.name || "the active organization";
  const c = evidence.counts;
  if (!evidence.organization) {
    return {
      title: "Create the first organization",
      reason: "There is no active organization to coordinate agents, goals, budgets, or approvals.",
      impact: "Creates the structure needed for delegated work.",
      confidence: 0.78,
      prompt: "Create a practical starter organization for my current work. Recommend useful roles, goals, and workflows, then wait for confirmation before creating anything.",
      requiresConfirmation: true,
      evidence: ["No active organization"],
      source: "fallback",
    };
  }
  if (c.agentsWithoutModel > 0) {
    return {
      title: "Configure missing agent models",
      reason: `${c.agentsWithoutModel} active agent(s) do not have a model configured, so execution quality may be inconsistent.`,
      impact: "Makes the org more reliable before assigning more work.",
      confidence: 0.74,
      prompt: `Review ${org} and configure missing agent model/profile settings. Organization ID: ${evidence.organization.id}. Show the plan first and wait for confirmation before changing agents.`,
      requiresConfirmation: true,
      evidence: [`${c.agentsWithoutModel} active agent(s) without model`, `${c.agents} agents total`],
      source: "fallback",
    };
  }
  if (c.goalsWithoutScopedWork > 0) {
    return {
      title: "Turn idle goals into owned work",
      reason: `${c.goalsWithoutScopedWork} goal(s) have no scoped tasks or workflows.`,
      impact: "Creates clear ownership and starts execution tracking.",
      confidence: 0.8,
      prompt: `Review ${org}'s goals and assign the highest-leverage idle goal to the right agents. Organization ID: ${evidence.organization.id}. Split work by role and create board tasks only after confirmation.`,
      requiresConfirmation: true,
      evidence: [`${c.goalsWithoutScopedWork} goal(s) without scoped work`, `${c.activeWork} active work item(s)`],
      source: "fallback",
    };
  }
  if (c.blockedTasks > 0 || c.pendingApprovals > 0) {
    return {
      title: "Clear the current blockers",
      reason: `${c.blockedTasks} blocked task(s) and ${c.pendingApprovals} pending approval(s) are slowing execution.`,
      impact: "Unblocks existing work before adding more commitments.",
      confidence: 0.82,
      prompt: `Audit blockers and pending approvals for ${org}. Organization ID: ${evidence.organization.id}. Recommend the smallest set of actions to unblock work and wait for confirmation before changing anything.`,
      requiresConfirmation: true,
      evidence: [`${c.blockedTasks} blocked task(s)`, `${c.pendingApprovals} pending approval(s)`],
      source: "fallback",
    };
  }
  return {
    title: "Simulate the next org execution",
    reason: "The org has no urgent structural blocker, so the best next step is to test execution against the most important goal.",
    impact: "Shows owner assignments, likely blockers, cost, and approval needs before committing changes.",
    confidence: 0.7,
    prompt: `Simulate the next useful execution for ${org}. Organization ID: ${evidence.organization.id}. Show who would own what, estimated cost, approval needs, likely blockers, and expected outputs. Do not create tasks or workflows until I confirm.`,
    requiresConfirmation: true,
    evidence: [`${c.agents} agents`, `${c.goals} goals`, `${c.activeWork} active work item(s)`],
    source: "fallback",
  };
}

async function buildEvidence(input: { organizationId?: string | null; goalId?: string | null }): Promise<NextActionEvidence> {
  initializeDatabase();
  const organization =
    (input.organizationId ? resolveHierarchyOrganization(input.organizationId) : null) ??
    getActiveHierarchyOrganization();
  const agents = listAgents();
  const organizationMembers = organization ? listHierarchyOrganizationMembers(organization.id) : [];
  const fallbackRoles = organization ? [] : listAgentRoles();
  const roles = organization ? organizationMembers.map((member) => member.role) : fallbackRoles;
  const roleAgentIds = new Set(organization ? organizationMembers.map((member) => member.agent.id) : fallbackRoles.map((role) => role.agentId));
  const scopedAgents = agents.filter((agent) => roleAgentIds.has(agent.id));
  const goals = listHierarchyGoals({ organizationId: organization?.id ?? null });
  const tasks = organization ? listBoardTasks(undefined, { organizationId: organization.id }) : [];
  const scopedGoalIds = new Set(goals.map((goal) => goal.id));
  const workflows = (() => {
    if (!organization) return [] as Array<{ id: string; goal_id: string | null }>;
    const db = getSqlite();
    return db.prepare("SELECT id, goal_id FROM workflows WHERE organization_id = ?").all(organization.id) as Array<{ id: string; goal_id: string | null }>;
  })();
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const failedWorkflowsLast20 = (() => {
    if (workflowIds.size === 0) return 0;
    const db = getSqlite();
    const rows = db.prepare("SELECT workflow_id, status FROM executions ORDER BY started_at DESC LIMIT 20").all() as Array<{ workflow_id: string; status: string }>;
    return rows.filter((row) => workflowIds.has(row.workflow_id) && /fail|error|cancel/i.test(row.status)).length;
  })();
  const pendingApprovals = organization
    ? listTaskApprovals({ status: "pending", limit: 100 }).filter((approval) => tasks.some((task) => task.id === approval.taskId)).length
    : 0;
  const goalsWithoutScopedWork = goals.filter((goal) => {
    const hasTask = tasks.some((task) => task.goalId === goal.id);
    const hasWorkflow = workflows.some((workflow) => workflow.goal_id && scopedGoalIds.has(workflow.goal_id) && workflow.goal_id === goal.id);
    return !hasTask && !hasWorkflow;
  }).length;
  const latestActivity = organization ? listHierarchyActivityEvents({ organizationId: organization.id, limit: 1 })[0] ?? null : null;
  const staleActivityDays = latestActivity
    ? Math.max(0, Math.floor((Date.now() - new Date(latestActivity.createdAt).getTime()) / 86_400_000))
    : null;
  const counts = {
    agents: scopedAgents.length,
    activeAgents: scopedAgents.filter((agent) => agent.isActive).length,
    goals: goals.length,
    activeWork: tasks.filter((task) => task.status === "in_progress").length,
    blockedTasks: tasks.filter((task) => task.status === "blocked").length,
    pendingApprovals,
    workflows: workflows.length,
    failedWorkflowsLast20,
    goalsWithoutScopedWork,
    agentsWithoutModel: scopedAgents.filter((agent) => agent.isActive && !agent.modelRef).length,
    agentsWithoutManager: roles.filter((role) => role.roleType !== "orchestrator" && !role.reportsTo).length,
    staleActivityDays,
  };
  const highlights = [
    `${counts.activeAgents}/${counts.agents} active agents`,
    `${counts.goals} goals`,
    `${counts.activeWork} active work item(s)`,
    `${counts.blockedTasks} blocked task(s)`,
    `${counts.pendingApprovals} pending approval(s)`,
    `${counts.goalsWithoutScopedWork} goal(s) without scoped work`,
    `${counts.agentsWithoutModel} active agent(s) without model`,
    `${counts.workflows} org workflow(s)`,
    `${counts.failedWorkflowsLast20} failed workflow execution(s) in last 20`,
  ];
  return {
    organization: organization ? { id: organization.id, name: organization.name } : null,
    counts,
    highlights,
  };
}

async function recommendWithModel(evidence: NextActionEvidence, fallback: NextActionRecommendation): Promise<NextActionRecommendation> {
  const model = getModelConfig();
  const result = await callModel({
    provider: model.provider,
    modelId: model.modelId,
    apiKey: model.apiKey,
    baseUrl: model.baseUrl,
    maxTokens: 900,
    temperature: 0.2,
    systemPrompt: [
      "You recommend exactly one next best action for a local-first AI organization dashboard.",
      "You must ground the recommendation in the supplied evidence. Do not invent facts.",
      "Do not perform mutations. Recommend a prompt that opens a confirmation-gated WebChat plan.",
      "Return only JSON with keys: title, reason, impact, confidence, prompt, requiresConfirmation, evidence.",
    ].join("\n"),
    userMessage: JSON.stringify({ evidence }, null, 2),
  });
  const parsed = parseJsonObject(result.response);
  return parsed ? normalizeRecommendation(parsed, fallback) : fallback;
}

async function recommendWithTimeout(evidence: NextActionEvidence, fallback: NextActionRecommendation): Promise<NextActionRecommendation> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      recommendWithModel(evidence, fallback),
      new Promise<NextActionRecommendation>((resolve) => {
        timer = setTimeout(() => resolve(fallback), MODEL_RECOMMENDATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const parsed = QuerySchema.parse({
      organizationId: searchParams.get("organizationId") ?? undefined,
      goalId: searchParams.get("goalId") ?? undefined,
    });
    const evidence = await buildEvidence(parsed);
    const fallback = buildFallbackRecommendation(evidence);
    let recommendation = fallback;
    try {
      recommendation = await recommendWithTimeout(evidence, fallback);
    } catch {
      recommendation = fallback;
    }
    return NextResponse.json({ success: true, data: { evidence, recommendation } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
