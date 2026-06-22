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
import { planAppAction } from "./app-action-planner";
import type { AppSurface, CrossTabIntent } from "./cross-tab-intent";

const log = logger.child("channels:app-plan-bridge");

/** Action kinds that satisfy each surface's coverage requirement. */
const SURFACE_SATISFIERS: Partial<Record<AppSurface, AppActionKind[]>> = {
  agents: ["create_agent", "create_agents", "update_agent_role", "update_agent_model_profile", "assign_agents_to_organization", "assign_skill_to_agent", "attach_extension_to_agent"],
  hierarchy: ["create_organization", "update_organization", "switch_organization", "apply_org_template", "assign_agents_to_organization"],
  goals: ["create_goal", "update_goal", "assign_goal_to_org_agents", "link_goal_sources"],
  council: ["run_council", "rerun_council_session", "create_council_verdict_task"],
  workflows: ["create_workflow_from_template"],
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

/**
 * Append typed steps for any requested surface the model plan missed. Keeps the
 * plan honest: every surface the user clearly asked to mutate gets a covering
 * step, wired to org/agent/workflow steps where natural.
 */
export type UnresolvedSurface = { surface: AppSurface; reason: string; clarificationQuestion: string };

export function enforceIntentCoverage(plan: AppActionPlan, intent: CrossTabIntent, message: string): { plan: AppActionPlan; added: AppSurface[]; unresolved: UnresolvedSurface[] } {
  const steps: AppActionStep[] = [...plan.steps];
  const added: AppSurface[] = [];
  const unresolved: UnresolvedSurface[] = [];
  let counter = steps.length + 1;
  const nextId = (surface: string) => `bridge-${surface}-${counter++}`;

  const orgStepId = () => firstStepId({ ...plan, steps }, ["create_organization", "apply_org_template"]);
  const agentStepId = () => firstStepId({ ...plan, steps }, ["create_agents", "create_agent"]);
  const workflowStepId = () => firstStepId({ ...plan, steps }, ["create_workflow_from_template"]);
  const goalStepId = () => firstStepId({ ...plan, steps }, ["create_goal"]);

  const has = (surface: AppSurface) => planCoversSurface({ ...plan, steps }, surface);

  // Only append for surfaces the intent actually flagged as requested.
  for (const surface of intent.surfaces) {
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
        const dep = orgStepId();
        steps.push({ id: nextId("goal"), action: "create_goal", label: "Create the goal", params: dep ? { organizationStepId: dep } : {} });
        added.push("goals");
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
        steps.push({ id: nextId("workflow"), action: "create_workflow_from_template", label: wfName ? `Create the ${wfName}` : "Create the workflow", params: wfName ? { name: wfName } : {} });
        added.push("workflows");
        break;
      }
      case "scheduler": {
        const dep = workflowStepId();
        // Only schedule if there is (now) a workflow to schedule.
        if (dep || intent.surfaces.includes("workflows")) {
          steps.push({ id: nextId("schedule"), action: "schedule_workflow", label: "Schedule the workflow", params: dep ? { workflowStepId: dep } : {} });
          added.push("scheduler");
        }
        break;
      }
      case "boards": {
        const orgDep = orgStepId();
        const goalDep = goalStepId();
        const params: Record<string, unknown> = { title: "Follow-up from WebChat plan" };
        if (orgDep) params.organizationStepId = orgDep;
        steps.push({ id: nextId("board"), action: "create_board_task", label: "Add the follow-up board task", params });
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

  if (added.length === 0) return { plan, added, unresolved };

  const merged: AppActionPlan = {
    ...plan,
    requiresConfirmation: true,
    steps,
  };
  return { plan: normalizeAppActionPlanStructure(merged), added, unresolved };
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
