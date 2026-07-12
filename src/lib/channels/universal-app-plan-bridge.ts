/**
 * Universal app-plan bridge.
 *
 * For a `mutation_proposal` cross-tab intent, the universal runtime must not
 * freeform-answer as if it completed the work. Instead it must synthesize a
 * typed `AppActionPlan` (or ask a clarification). This module is that bridge.
 *
 * It deliberately reuses the existing model-led `planAppAction` pipeline
 * (compact context load → JSON-only model call → schema validation → repair →
 * coverage critic) rather than duplicating it, then adds an extra
 * **intent-surface coverage net**: it cross-checks the produced plan against the
 * surfaces the centralized cross-tab intent layer detected and appends typed
 * steps for any requested surface the model missed. The bridge never executes
 * tools — execution stays in `app-action-executor.ts` after confirmation.
 */

import { logger } from "@/lib/utils/logger";
import type { AppActionKind, AppActionPlan, AppActionStep } from "./app-action-schema";
import { validateAppActionPlan, normalizeAppActionPlanStructure } from "./app-action-schema";
import {
  detectRequestedCoverage,
  hasExplicitGoalCreationRequest,
  hasConcreteBudgetThreshold,
  inferBudgetPolicyRequest,
  isGoalSourceLinkMutationIntent,
  planAppAction,
  wireCrossSurfaceStepReferences,
} from "./app-action-planner";
import type { AppSurface, CrossTabIntent } from "./cross-tab-intent";

const log = logger.child("channels:app-plan-bridge");

/** Action kinds that satisfy each surface's coverage requirement. */
const SURFACE_SATISFIERS: Partial<Record<AppSurface, AppActionKind[]>> = {
  agents: ["create_agent", "create_agents", "update_agent_role", "update_agent_model_profile", "assign_agents_to_organization", "assign_skill_to_agent", "attach_extension_to_agent"],
  hierarchy: ["create_organization", "update_organization", "switch_organization", "apply_org_template", "assign_agents_to_organization"],
  goals: ["create_goal", "update_goal", "assign_goal_to_org_agents", "link_goal_sources"],
  budgets: ["set_hierarchy_budget_policy"],
  council: ["run_council", "rerun_council_session", "create_council_verdict_task"],
  workflows: [
    "create_workflow_from_template",
    "schedule_workflow",
    "toggle_workflow_active",
    "update_workflow_node",
    "set_workflow_node_model",
  ],
  scheduler: ["schedule_workflow"],
  boards: ["create_board_task", "link_board_task_to_agent", "link_board_task_to_organization", "link_board_task_to_goal"],
  channels: ["connect_channel"],
};

function planCoversSurface(plan: AppActionPlan, surface: AppSurface): boolean {
  const satisfiers = SURFACE_SATISFIERS[surface];
  if (!satisfiers) return true; // surfaces with no write action (memory/models/docs/documents) need no step
  const kinds = new Set(plan.steps.map((s) => s.action));
  return satisfiers.some((k) => kinds.has(k));
}

function firstStepId(plan: AppActionPlan, actions: AppActionKind[]): string | undefined {
  return plan.steps.find((s) => actions.includes(s.action))?.id;
}

/** Returns an explicitly-named channel, or null — never a Slack default. */
function detectChannelName(message: string): string | null {
  const m = message.toLowerCase();
  for (const name of ["slack", "telegram", "discord", "whatsapp", "teams", "bluebubbles"]) {
    if (m.includes(name)) return name;
  }
  return null;
}

/** Derive a workflow name from the message (avoid empty/template-less workflows). */
function deriveWorkflowName(message: string): string | null {
  const m = message.match(/\b([\w][\w\s-]{2,40}?)\s+workflow\b/i);
  if (m?.[1]) {
    const name = m[1].trim().replace(/^(a|an|the|my|our|daily|weekly|monthly)\s+/i, "").trim();
    if (name) return `${name[0].toUpperCase()}${name.slice(1)} Workflow`;
  }
  if (/\bdaily\b/i.test(message)) return "Daily Workflow";
  if (/\bweekly\b/i.test(message)) return "Weekly Workflow";
  return null;
}

function deriveWorkflowTemplateKey(message: string): string {
  if (/\b(?:api|endpoint|service)\b/i.test(message)) return "api-monitor";
  if (/\b(?:document|pdf|extract|notes?)\b/i.test(message)) return "document-intelligence";
  if (/\b(?:research|news|latest|current|web|internet|digest|briefing)\b/i.test(message)) {
    return "live-research-assistant";
  }
  return "scheduled-health-check";
}

function deriveWorkflowSchedule(message: string): string | null {
  const cron = message.match(/(?:\bcron\s*:?\s*)?([\d*/?,\-]+(?:\s+[\d*/?,\-]+){4})(?:\s|$)/i)?.[1]?.trim();
  if (cron) return cron;
  const interval = message.match(/\bevery\s+(\d{1,2})\s+(minutes?|hours?)\b/i);
  if (interval?.[1] && interval[2]) return `every ${interval[1]} ${interval[2].toLowerCase()}`;
  const cadence = message.match(/\b(weekdays?|daily|weekly|monthly|hourly|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i)?.[1];
  if (!cadence) return null;
  const clock = message.match(/\b(?:at|around|by)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?)\b/i)?.[1];
  return clock ? `${cadence.toLowerCase()} at ${clock.replace(/\./g, "").replace(/\s+/g, "")}` : cadence.toLowerCase();
}

function deriveGoalSourceLinkParams(message: string): Record<string, unknown> {
  const relation = message.match(
    /\b(?:attach|link|add|associate)\s+(?:the\s+)?(.+?)\s+(?:to|with|for)\s+(?:the\s+)?(.+?\b(?:goal|objective|milestone|okr))\b/i,
  );
  const sourcePhrase = String(relation?.[1] || "").trim();
  const goalName = String(relation?.[2] || "").trim();
  const compactSourceName = sourcePhrase
    .replace(/\b(?:docs?|documents?|sources?|files?|data\s+sources?|source\s+packs?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const documentNames = Array.from(new Set([sourcePhrase, compactSourceName].filter(Boolean)));
  return {
    ...(goalName ? { goalName } : {}),
    ...(documentNames.length > 0 ? { documentNames } : {}),
    mode: "append",
  };
}

/**
 * Append typed steps for any requested surface the model plan missed. Keeps the
 * plan honest: every surface the user clearly asked to mutate gets a covering
 * step, wired to org/agent/workflow steps where natural.
 */
export type UnresolvedSurface = { surface: AppSurface; reason: string; clarificationQuestion: string };

const COVERAGE_ID_BY_SURFACE: Partial<Record<AppSurface, string>> = {
  agents: "agents",
  hierarchy: "organization",
  goals: "goal",
  budgets: "budget",
  council: "council",
  workflows: "workflow",
  scheduler: "schedule",
  boards: "board",
  channels: "channel",
};

function sortPlanStepsByDependencies(plan: AppActionPlan): AppActionPlan {
  const pending = [...plan.steps];
  const emitted = new Set<string>();
  const sorted: AppActionStep[] = [];

  while (pending.length > 0) {
    const index = pending.findIndex((step) => (step.dependsOn ?? []).every((dependency) => emitted.has(dependency)));
    if (index < 0) {
      sorted.push(...pending);
      break;
    }
    const [step] = pending.splice(index, 1);
    sorted.push(step);
    emitted.add(step.id);
  }

  return { ...plan, steps: sorted };
}

function wireIntentSequence(plan: AppActionPlan, message: string): AppActionPlan {
  const goalSourceStep = plan.steps.find((step) => step.action === "link_goal_sources");
  const councilStep = plan.steps.find((step) => step.action === "run_council");
  const workflowStep = plan.steps.find((step) => step.action === "create_workflow_from_template");
  const workflowFromVerdict = /\b(?:turn|convert|transform)\b[\s\S]{0,80}\b(?:verdict|decision|outcome|result)\b[\s\S]{0,80}\binto\s+(?:an?\s+)?(?:workflow|automation|pipeline|flow)\b/i.test(message);

  return {
    ...plan,
    steps: plan.steps.map((step) => {
      const dependsOn = new Set(step.dependsOn ?? []);
      if (step.id === councilStep?.id && goalSourceStep) dependsOn.add(goalSourceStep.id);
      if (step.id === workflowStep?.id && councilStep && workflowFromVerdict) dependsOn.add(councilStep.id);
      return { ...step, dependsOn: dependsOn.size > 0 ? Array.from(dependsOn) : undefined };
    }),
  };
}

export function enforceIntentCoverage(plan: AppActionPlan, intent: CrossTabIntent, message: string): { plan: AppActionPlan; added: AppSurface[]; unresolved: UnresolvedSurface[] } {
  let steps: AppActionStep[] = [...plan.steps];
  let sanitizedExistingSteps = false;
  const added: AppSurface[] = [];
  const unresolved: UnresolvedSurface[] = [];
  let counter = steps.length + 1;
  const nextId = (surface: string) => `bridge-${surface}-${counter++}`;

  const orgStepId = () => firstStepId({ ...plan, steps }, ["create_organization", "apply_org_template"]);
  const agentStepId = () => firstStepId({ ...plan, steps }, ["create_agents", "create_agent"]);
  const workflowStepId = () => firstStepId({ ...plan, steps }, ["create_workflow_from_template"]);
  const goalStepId = () => firstStepId({ ...plan, steps }, ["create_goal"]);

  const requestedCoverage = new Set(
    detectRequestedCoverage(message)
      .filter((surface) => surface.requested)
      .map((surface) => surface.id),
  );
  const explicitlyCreatesAgents = requestedCoverage.has("agents");
  const explicitlyCreatesOrganization = requestedCoverage.has("organization");
  const explicitlyCreatesGoal = hasExplicitGoalCreationRequest(message);
  const explicitlyLinksGoalSources = isGoalSourceLinkMutationIntent(message);
  if (
    explicitlyCreatesAgents &&
    explicitlyCreatesOrganization &&
    !steps.some((step) => step.action === "create_organization" || step.action === "apply_org_template")
  ) {
    steps = steps.filter((step) => step.action !== "assign_agents_to_organization");
  }
  if (explicitlyCreatesGoal && !steps.some((step) => step.action === "create_goal")) {
    steps = steps.filter((step) => step.action !== "update_goal");
  }
  if (explicitlyLinksGoalSources && !explicitlyCreatesGoal && steps.some((step) => step.action === "create_goal")) {
    steps = steps.filter((step) => step.action !== "create_goal");
    sanitizedExistingSteps = true;
  }

  const has = (surface: AppSurface) => {
    if (surface === "agents" && explicitlyCreatesAgents) {
      return steps.some((step) => step.action === "create_agent" || step.action === "create_agents");
    }
    if (surface === "hierarchy" && explicitlyCreatesOrganization) {
      return steps.some((step) => step.action === "create_organization" || step.action === "apply_org_template");
    }
    if (surface === "goals" && explicitlyCreatesGoal) {
      return steps.some((step) => step.action === "create_goal");
    }
    if (surface === "goals" && explicitlyLinksGoalSources) {
      return steps.some((step) => step.action === "link_goal_sources");
    }
    if (surface === "boards" && requestedCoverage.has("board")) {
      return steps.some((step) => step.action === "create_board_task");
    }
    return planCoversSurface({ ...plan, steps }, surface);
  };

  // `intent.surfaces` also contains referenced scopes and task subject matter
  // (for example, "in organization X" or "about an AI assistant"). Only add
  // mutation steps for surfaces whose own write intent was explicitly detected.
  for (const surface of intent.surfaces) {
    const coverageId = COVERAGE_ID_BY_SURFACE[surface];
    if (!coverageId || !requestedCoverage.has(coverageId)) continue;
    if (has(surface)) continue;
    switch (surface) {
      case "agents": {
        steps.push({ id: nextId("agents"), action: "create_agents", label: "Create the requested agents", params: { count: 3, purpose: "cross-tab plan team" } });
        added.push("agents");
        break;
      }
      case "hierarchy": {
        const dep = agentStepId();
        steps.push({ id: nextId("org"), action: "create_organization", label: "Organize the agents into an organization", params: dep ? { memberStepId: dep, activate: true } : { activate: true } });
        added.push("hierarchy");
        break;
      }
      case "goals": {
        if (explicitlyLinksGoalSources && !explicitlyCreatesGoal) {
          steps.push({
            id: nextId("goal-sources"),
            action: "link_goal_sources",
            label: "Link the requested sources to the goal",
            params: deriveGoalSourceLinkParams(message),
          });
          added.push("goals");
          break;
        }
        const dep = orgStepId();
        steps.push({ id: nextId("goal"), action: "create_goal", label: "Create the goal", params: dep ? { organizationStepId: dep } : {} });
        added.push("goals");
        break;
      }
      case "budgets": {
        const budget = inferBudgetPolicyRequest(message);
        if (!hasConcreteBudgetThreshold(budget)) {
          unresolved.push({
            surface: "budgets",
            reason: "No concrete USD threshold",
            clarificationQuestion: `What ${budget.period} USD limit should I use, and should it be hard, soft, or approval-gated?`,
          });
          break;
        }
        const dep = budget.scope === "goal" ? goalStepId() : budget.scope === "agent" ? agentStepId() : orgStepId();
        const params: Record<string, unknown> = {
          scope: budget.scope,
          period: budget.period,
          ...(budget.softLimitUsd !== undefined ? { softLimitUsd: budget.softLimitUsd } : {}),
          ...(budget.hardLimitUsd !== undefined ? { hardLimitUsd: budget.hardLimitUsd } : {}),
          ...(budget.requireApprovalAboveUsd !== undefined ? { requireApprovalAboveUsd: budget.requireApprovalAboveUsd } : {}),
        };
        if (dep) {
          if (budget.scope === "goal") params.goalStepId = dep;
          else if (budget.scope === "agent") params.agentStepId = dep;
          else params.organizationStepId = dep;
        }
        steps.push({
          id: nextId("budget"),
          action: "set_hierarchy_budget_policy",
          label: `Set the ${budget.period} ${budget.scope} budget policy`,
          params,
          dependsOn: dep ? [dep] : undefined,
        });
        added.push("budgets");
        break;
      }
      case "council": {
        const dep = orgStepId();
        steps.push({ id: nextId("council"), action: "run_council", label: "Run a council debate", params: dep ? { organizationStepId: dep } : {} });
        added.push("council");
        break;
      }
      case "workflows": {
        const wfName = deriveWorkflowName(message);
        const orgDep = orgStepId();
        const goalDep = goalStepId();
        steps.push({
          id: nextId("workflow"),
          action: "create_workflow_from_template",
          label: wfName ? `Create the ${wfName}` : "Create the workflow",
          params: {
            templateKey: deriveWorkflowTemplateKey(message),
            ...(wfName ? { name: wfName } : {}),
            ...(orgDep ? { organizationStepId: orgDep } : {}),
            ...(goalDep ? { goalStepId: goalDep } : {}),
          },
          dependsOn: [orgDep, goalDep].filter((id): id is string => Boolean(id)),
        });
        added.push("workflows");
        break;
      }
      case "scheduler": {
        const dep = workflowStepId();
        const schedule = deriveWorkflowSchedule(message);
        // Only schedule if there is (now) a workflow to schedule.
        if ((dep || intent.surfaces.includes("workflows")) && schedule) {
          steps.push({ id: nextId("schedule"), action: "schedule_workflow", label: "Schedule the workflow", params: { ...(dep ? { workflowStepId: dep } : {}), schedule } });
          added.push("scheduler");
        } else if (!schedule) {
          unresolved.push({ surface: "scheduler", reason: "No concrete cadence", clarificationQuestion: "What cadence should I use for the workflow schedule?" });
        }
        break;
      }
      case "boards": {
        const orgDep = orgStepId();
        const goalDep = goalStepId();
        const agentDep = agentStepId();
        const workflowDep = workflowStepId();
        const params: Record<string, unknown> = { title: "Follow-up from WebChat plan" };
        if (orgDep) params.organizationStepId = orgDep;
        if (goalDep) params.goalStepId = goalDep;
        if (agentDep) params.agentStepId = agentDep;
        if (workflowDep) params.workflowStepId = workflowDep;
        steps.push({
          id: nextId("board"),
          action: "create_board_task",
          label: "Add the follow-up board task",
          params,
          dependsOn: [orgDep, goalDep, agentDep, workflowDep].filter((id): id is string => Boolean(id)),
        });
        if (goalDep) {
          // link the new board task to the goal where possible
          const boardId = steps[steps.length - 1].id;
          steps.push({ id: nextId("boardlink"), action: "link_board_task_to_goal", label: "Link the board task to the goal", params: { taskStepId: boardId, goalStepId: goalDep } });
        }
        added.push("boards");
        break;
      }
      case "channels": {
        const channel = detectChannelName(message);
        if (channel) {
          steps.push({ id: nextId("channel"), action: "connect_channel", label: `Prepare ${channel} connection (setup)`, params: { channel } });
          added.push("channels");
        } else {
          // Do NOT default to Slack — ask which channel instead.
          unresolved.push({ surface: "channels", reason: "No channel named", clarificationQuestion: "Which channel should I set up (Slack, Telegram, Discord, WhatsApp, Teams)?" });
        }
        break;
      }
      default:
        break;
    }
  }

  if (added.length === 0 && !sanitizedExistingSteps) return { plan, added, unresolved };

  const merged: AppActionPlan = {
    ...plan,
    requiresConfirmation: true,
    steps,
  };
  const wired = wireIntentSequence(
    wireCrossSurfaceStepReferences(normalizeAppActionPlanStructure(merged)),
    message,
  );
  return { plan: normalizeAppActionPlanStructure(sortPlanStepsByDependencies(wired)), added, unresolved };
}

export async function proposeUniversalAppActionPlan(args: {
  message: string;
  sessionId: string;
  agentId?: string;
  intent: CrossTabIntent;
  internalBaseUrl?: string | null;
  clientTurnId?: string;
  onStatus?: (phase: string, label: string, detail?: string) => void;
}): Promise<AppActionPlan | null> {
  const { message, sessionId, intent, internalBaseUrl, clientTurnId, onStatus } = args;

  onStatus?.("routing", "Drafting a cross-tab plan...", `${intent.surfaces.length} surfaces detected`);

  const basePlan = await planAppAction(message, {
    sessionId,
    channel: "webchat",
    internalBaseUrl,
    clientTurnId,
    onStatus,
  });

  if (!basePlan) {
    log.debug("proposeUniversalAppActionPlan: planner returned null");
    return null;
  }

  // A pure clarification (no steps) is a valid, non-prose response.
  if (basePlan.clarificationQuestion && basePlan.steps.length === 0) {
    return basePlan;
  }

  const { plan: covered, added, unresolved } = enforceIntentCoverage(basePlan, intent, message);
  if (added.length > 0) {
    log.info("proposeUniversalAppActionPlan: intent-coverage net added steps", {
      added,
      surfaces: intent.surfaces,
      finalStepCount: covered.steps.length,
    });
    onStatus?.("reviewing-plan", "Covering all requested surfaces...", `Added ${added.join(", ")}`);
  }

  // A requested surface that cannot be safely inferred (e.g. a channel with no
  // name) is surfaced as a one-line clarification appended to the plan's
  // assumptions, rather than inventing a default (no Slack-by-default). The
  // resolvable steps are kept so the user still gets the rest of the plan.
  if (unresolved.length > 0) {
    log.info("proposeUniversalAppActionPlan: unresolved surfaces", { unresolved: unresolved.map((u) => u.surface) });
    covered.assumptions = [...(covered.assumptions ?? []), ...unresolved.map((u) => u.clarificationQuestion)];
  }

  const validation = validateAppActionPlan(covered);
  if (validation.success) {
    return validation.plan;
  }

  // If our coverage net somehow produced an invalid plan, fall back to the
  // validated base plan rather than dropping to prose.
  log.warn("proposeUniversalAppActionPlan: coverage net invalid — using base plan", { error: validation.error });
  return basePlan;
}
