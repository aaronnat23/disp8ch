/**
 * Standing goals and proactive employee behavior.
 *
 * Implementation Phase 8 of the richer-agentic-output plan. Builds on the
 * existing Hierarchy goals and Boards surfaces (instead of inventing a new
 * table) and exposes:
 *
 *  - /goal <description>     create a durable goal + decomposed board tasks
 *  - /goal status            show progress
 *  - /goal pause | resume    pause/resume the goal's worker
 *  - /goal clear             mark the goal done
 *  - /subgoal <description>  add a sub-condition to the active goal
 *
 * Destructive, publishing, send, or credential actions still require
 * explicit user confirmation; we only stage proposals and queue
 * background work, we never auto-execute side effects.
 */

import { logger } from "@/lib/utils/logger";
import { getActiveHierarchyOrganization, listHierarchyOrganizations } from "@/lib/hierarchy/organizations";
import { createHierarchyGoal, getHierarchyGoalById, listHierarchyGoals, updateHierarchyGoal, type HierarchyGoalRecord } from "@/lib/hierarchy/goals";
import {
  createBoardTask,
  listBoards,
  listBoardTasks,
  lockTaskForExecution,
  unlockTaskExecution,
  updateBoardTask,
  type BoardTaskRecord,
  type BoardTaskStatus,
} from "@/lib/boards/manager";
import type { ModelLedLane } from "@/lib/channels/model-led-context";
import {
  appendGoalJudgment,
  createGoalRun,
  listGoalJudgments,
  listGoalRuns,
  updateGoalRun,
} from "@/lib/goals/goal-run-ledger";
import { buildGoalContinuationPlan } from "@/lib/goals/goal-continuation";
import type { GoalJudgeResult } from "@/lib/goals/goal-judge";

const log = logger.child("goals:standing");

export type StandingGoalStatus = "planned" | "active" | "paused" | "done" | "blocked";

export type StandingGoalSnapshot = {
  goal: HierarchyGoalRecord;
  tasks: BoardTaskRecord[];
  readyTaskCount: number;
  blockedTaskCount: number;
  doneTaskCount: number;
  lastActionAt: string | null;
};

export type StandingGoalCommand =
  | { kind: "start"; description: string; deliverables?: string[]; organizationId?: string | null }
  | { kind: "status"; goalRef?: string | null }
  | { kind: "pause"; goalRef: string }
  | { kind: "resume"; goalRef: string }
  | { kind: "clear"; goalRef: string }
  | { kind: "subgoal"; goalRef: string | null; description: string };

export type StandingGoalResult = {
  ok: boolean;
  message: string;
  snapshot?: StandingGoalSnapshot;
  warnings?: string[];
};

export type StandingGoalWorkerStatus = Extract<BoardTaskStatus, "done" | "review" | "blocked" | "in_progress">;

export type StandingGoalTaskExecutorInput = {
  goal: HierarchyGoalRecord;
  task: BoardTaskRecord;
  snapshot: StandingGoalSnapshot;
  runId: string;
  workerId: string;
  workspacePath?: string | null;
};

export type StandingGoalTaskExecutorResult = {
  status: StandingGoalWorkerStatus;
  summary: string;
  deliverables?: string[];
  warnings?: string[];
  toolsUsed?: string[];
  tokensUsed?: number;
};

export type StandingGoalDaemonTickOptions = {
  maxTasks?: number;
  goalId?: string | null;
  workerId?: string;
  workspacePath?: string | null;
  executeTask?: (input: StandingGoalTaskExecutorInput) => Promise<StandingGoalTaskExecutorResult>;
  judge?: "auto" | "always" | "never";
};

export type StandingGoalDaemonTickResult = {
  ok: boolean;
  scannedGoals: number;
  scannedTasks: number;
  processedTasks: number;
  idle: boolean;
  runs: Array<{
    runId: string;
    goalId: string;
    taskId: string;
    status: StandingGoalWorkerStatus;
    summary: string;
    warnings?: string[];
    toolsUsed?: string[];
    tokensUsed?: number;
  }>;
  warnings?: string[];
};

const DEFAULT_DECOMPOSITION = [
  "Outline scope and required deliverables.",
  "Gather current evidence (web/repo/app-state) for the goal.",
  "Draft first concrete artifact or board task.",
  "Verify against acceptance criteria; revise.",
  "Save final deliverable and mark goal done.",
];

const SIDE_EFFECT_PATTERN = /\b(?:send|publish|post|deploy|install|delete|remove|spend|buy|purchase|transfer|email|message|commit|push|merge|run\s+payment|rotate\s+key|change\s+password)\b/i;

function slugify(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function findBoardForOrganization(organizationId: string | null): string {
  const boards = listBoards();
  if (boards.length === 0) {
    // Fall back to creating a default board by name lookup if any board exists.
    return boards[0]?.id ?? "";
  }
  if (organizationId) {
    const orgBoard = boards.find((board) => (board as { organizationId?: string | null }).organizationId === organizationId);
    if (orgBoard) return orgBoard.id;
  }
  return boards[0].id;
}

function resolveActiveGoal(reference?: string | null): HierarchyGoalRecord | null {
  if (!reference) {
    const active = listHierarchyGoals().filter((goal) => goal.isActive && goal.status === "active");
    return active[0] ?? null;
  }
  const byId = getHierarchyGoalById(reference);
  if (byId) return byId;
  return listHierarchyGoals({ includeInactive: true }).find((goal) => goal.id === reference || goal.name === reference) ?? null;
}

function mapStatusToGoal(status: string | undefined): StandingGoalStatus {
  switch (status) {
    case "active":
    case "planned":
    case "blocked":
    case "done":
      return status;
    default:
      return "planned";
  }
}

function snapshotFromGoal(goal: HierarchyGoalRecord): StandingGoalSnapshot {
  const tasks = listBoardTasks(undefined, { goalId: goal.id });
  const readyTaskCount = tasks.filter((task) => task.status === "inbox" || task.status === "in_progress").length;
  const blockedTaskCount = tasks.filter((task) => task.status === "blocked").length;
  const doneTaskCount = tasks.filter((task) => task.status === "done").length;
  const lastTouched = tasks
    .map((task) => task.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .pop();
  return {
    goal,
    tasks,
    readyTaskCount,
    blockedTaskCount,
    doneTaskCount,
    lastActionAt: lastTouched ?? null,
  };
}

function isReadyTask(task: BoardTaskRecord): boolean {
  if (!["inbox", "in_progress"].includes(task.status)) return false;
  if (task.executionRunId || task.executionLockedAt) return false;
  if (task.blockedBy.length > 0) return false;
  return true;
}

function isStandingGoalTask(task: BoardTaskRecord): boolean {
  return String(task.sourceType || "").startsWith("standing-");
}

function taskPriorityScore(task: BoardTaskRecord): number {
  switch (task.priority) {
    case "urgent": return 0;
    case "high": return 1;
    case "medium": return 2;
    case "low": return 3;
    default: return 4;
  }
}

function sortReadyTasks(tasks: BoardTaskRecord[]): BoardTaskRecord[] {
  return [...tasks].sort((a, b) => {
    const statusDelta = (a.status === "in_progress" ? 0 : 1) - (b.status === "in_progress" ? 0 : 1);
    if (statusDelta !== 0) return statusDelta;
    const priorityDelta = taskPriorityScore(a) - taskPriorityScore(b);
    if (priorityDelta !== 0) return priorityDelta;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function composeWorkerPrompt(input: StandingGoalTaskExecutorInput): string {
  const goal = input.goal;
  const task = input.task;
  const siblingTasks = input.snapshot.tasks
    .filter((candidate) => candidate.id !== task.id)
    .slice(0, 8)
    .map((candidate) => `- [${candidate.status}] ${candidate.title}`)
    .join("\n");
  const sideEffectWarning = SIDE_EFFECT_PATTERN.test(`${task.title}\n${task.description ?? ""}\n${goal.description ?? ""}`)
    ? "\nThis task may involve side effects. Do not execute destructive, publishing, spending, credential, external-send, install, or deployment actions without explicit user confirmation. Produce a proposal and state the needed confirmation instead."
    : "";
  return [
    "You are running one bounded standing-goal worker tick for disp8ch AI.",
    "Complete the selected board task as far as safely possible using tools and evidence.",
    "If the task needs current facts, repo/app state, memory, or web evidence, gather it with tools instead of guessing.",
    "For simple planning, checklist, outline, or draft tasks, prefer 3-6 targeted tool calls at most unless new evidence shows the task is broader.",
    "If the safe output is a plan, report, draft, audit, or next-step proposal, produce it now.",
    "If blocked, state the exact blocker and what confirmation, credential, or missing input is needed.",
    "Keep side effects proposal-only unless the user already explicitly confirmed them in this task.",
    sideEffectWarning,
    "",
    `Goal: ${goal.name}`,
    goal.description ? `Goal description: ${goal.description}` : "",
    `Selected task: ${task.title}`,
    task.description ? `Task description: ${task.description}` : "",
    siblingTasks ? `Other goal tasks:\n${siblingTasks}` : "",
    "",
    "Return a useful worker result. Do not say you will do it later; do the safe work now.",
  ].filter(Boolean).join("\n");
}

function inferStandingGoalTaskHints(input: StandingGoalTaskExecutorInput): Record<string, unknown> {
  const text = `${input.goal.name}\n${input.goal.description ?? ""}\n${input.task.title}\n${input.task.description ?? ""}`.toLowerCase();
  const requestedSurfaces = ["boards", "hierarchy", "memory"];
  const likelyNeedsWeb = /\b(?:current|latest|today|online|web|source|sources|pricing|news|competitor|market|public)\b/i.test(text);
  const likelyNeedsRepo = /\b(?:repo|repository|codebase|source code|implementation|file|files|function|class|api route|daemon|server|disp8ch|workflow engine)\b/i.test(text);
  const likelyNeedsAppState = /\b(?:app state|configured|callable|runtime|status|board|goal|task|hierarchy|workflow|daemon|scheduler)\b/i.test(text);
  const likelyNeedsWorkflowCatalog = /\b(?:workflow|node|automation|template|trigger)\b/i.test(text);
  if (likelyNeedsWeb) requestedSurfaces.push("web");
  if (likelyNeedsRepo) requestedSurfaces.push("repo");
  if (likelyNeedsAppState) requestedSurfaces.push("app-state");
  if (likelyNeedsWorkflowCatalog) requestedSurfaces.push("workflow-catalog");
  return {
    standingGoal: true,
    boardTaskId: input.task.id,
    goalId: input.goal.id,
    safetyBoundary: "proposal_only",
    evidenceBudget: /(?:checklist|outline|draft|scope|deliverable)/i.test(input.task.title) ? "light" : "standard",
    likelyNeedsWeb,
    likelyNeedsRepo,
    likelyNeedsAppState,
    likelyNeedsWorkflowCatalog,
    requestedSurfaces: Array.from(new Set(requestedSurfaces)),
  };
}

function standingGoalLaneFromHints(hints: Record<string, unknown>): ModelLedLane {
  if (hints.likelyNeedsWeb) return "broad_research";
  if (hints.likelyNeedsWorkflowCatalog) return "app_design";
  if (hints.likelyNeedsRepo) return "repo_inspection";
  return "read_only_workspace";
}

function standingGoalToolNames(hints: Record<string, unknown>): string[] {
  const names = new Set([
    "channel_status",
    "board_tasks",
    "documents_search",
    "document_get",
    "memory_search",
    "memory_get",
    "session_recall",
  ]);
  if (hints.likelyNeedsRepo || hints.likelyNeedsAppState) {
    names.add("search_files");
    names.add("read_file");
    names.add("list_files");
  }
  if (hints.likelyNeedsWeb) {
    names.add("web_search");
    names.add("web_extract");
    names.add("fetch_url");
  }
  if (hints.likelyNeedsWorkflowCatalog) {
    names.add("workflow_templates");
    names.add("workflow_list");
    names.add("workflow_get");
  }
  return Array.from(names);
}

function standingGoalToolBudget(hints: Record<string, unknown>): number {
  if (hints.evidenceBudget === "light") return 8;
  if (hints.likelyNeedsWeb && hints.likelyNeedsRepo) return 14;
  return 10;
}

function inferWorkerStatus(answer: string): StandingGoalWorkerStatus {
  const text = answer.toLowerCase();
  if (/\b(?:cannot proceed|can't proceed|unable to proceed|no configured api key|missing (?:approval|confirmation|credential|api key|access|permission)|needs? (?:approval|confirmation|credential|api key|access|permission)|requires? (?:approval|confirmation|credential|api key|access|permission))\b/.test(text)) {
    return "blocked";
  }
  if (/\b(?:draft|proposal|review|needs review|ready for review)\b/.test(text)) {
    return "review";
  }
  return "done";
}

function goalRunStatusFromWorkerStatus(status: StandingGoalWorkerStatus): "running" | "done" | "review" | "blocked" {
  return status === "in_progress" ? "running" : status;
}

function truncateDeliverable(value: string): string {
  const normalized = String(value || "").trim();
  return normalized.length > 6000 ? `${normalized.slice(0, 6000)}\n\n[truncated]` : normalized;
}

function summarizeGoalLedger(goalId: string): string {
  try {
    const runs = listGoalRuns(goalId, 5);
    const judgments = listGoalJudgments(goalId, 3);
    const lines: string[] = [];
    if (runs.length > 0) {
      lines.push("Recent runs:");
      for (const run of runs) {
        lines.push(`- [${run.status}] ${run.id} task=${run.taskId ?? "goal"} verdict=${run.lastVerdict ?? "unjudged"} ${run.lastReason ? `- ${run.lastReason.slice(0, 180)}` : ""}`);
      }
    }
    if (judgments.length > 0) {
      lines.push("Recent judgments:");
      for (const judgment of judgments) {
        lines.push(`- [${judgment.verdict}] ${judgment.reason.slice(0, 220)}`);
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

function normalizeBlockerKey(value: string | null | undefined): string | null {
  const key = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 2)
    .slice(0, 10)
    .join(" ");
  return key || null;
}

function countRecentParseFailures(goalId: string, limit = 5): number {
  try {
    let count = 0;
    for (const judgment of listGoalJudgments(goalId, limit)) {
      if (judgment.verdict !== "parse_failure") break;
      count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function countRecentSameBlockers(goalId: string, blockerKey: string | null, limit = 5): number {
  if (!blockerKey) return 0;
  try {
    let count = 0;
    for (const judgment of listGoalJudgments(goalId, limit)) {
      if (judgment.verdict !== "blocked") break;
      if (normalizeBlockerKey(judgment.reason) !== blockerKey) break;
      count++;
    }
    return count;
  } catch {
    return 0;
  }
}

async function judgeWorkerResult(input: {
  goal: HierarchyGoalRecord;
  task: BoardTaskRecord;
  snapshot: StandingGoalSnapshot;
  summary: string;
  deliverables?: string[];
  toolsUsed?: string[];
  workerId: string;
}): Promise<GoalJudgeResult | null> {
  try {
    const [{ getModelConfig }, { providerRequiresApiKey }, { judgeStandingGoalProgress }] = await Promise.all([
      import("@/lib/agents/model-router"),
      import("@/lib/agents/provider-plugins"),
      import("@/lib/goals/goal-judge"),
    ]);
    const sessionId = `standing-goal:${input.goal.id}`;
    const model = getModelConfig({ agentId: input.workerId || "main", sessionId });
    if (providerRequiresApiKey(model.provider) && !model.apiKey) return null;
    return await judgeStandingGoalProgress({
      goal: input.goal,
      task: input.task,
      siblingTasks: input.snapshot.tasks.filter((task) => task.id !== input.task.id),
      workerSummary: input.summary,
      deliverables: input.deliverables,
      toolsUsed: input.toolsUsed,
      provider: model.provider,
      modelId: model.modelId,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
    });
  } catch (err) {
    log.warn("Standing-goal judge failed", { goalId: input.goal.id, taskId: input.task.id, error: String(err) });
    return null;
  }
}

async function defaultStandingGoalTaskExecutor(
  input: StandingGoalTaskExecutorInput,
): Promise<StandingGoalTaskExecutorResult> {
  const [{ getModelConfig }, { providerRequiresApiKey }, { runUniversalAgenticRuntime }, { loadAllTools }] = await Promise.all([
    import("@/lib/agents/model-router"),
    import("@/lib/agents/provider-plugins"),
    import("@/lib/channels/universal-agentic-runtime"),
    import("@/lib/engine/tools"),
  ]);
  const sessionId = `standing-goal:${input.goal.id}`;
  const agentId = input.workerId || "main";
  const model = getModelConfig({ agentId, sessionId });
  if (providerRequiresApiKey(model.provider) && !model.apiKey) {
    return {
      status: "blocked",
      summary: `No configured API key is available for ${model.provider}/${model.modelId}; standing-goal worker cannot run this task.`,
      warnings: ["Configure an active model before running standing-goal daemon ticks."],
    };
  }

  const taskHints = inferStandingGoalTaskHints(input);
  const modelLedLane = standingGoalLaneFromHints(taskHints);
  const tools = await loadAllTools(standingGoalToolNames(taskHints), {
    toolPolicy: { approvalMode: "model", execSecurity: "deny", execAsk: "always" },
  });
  const result = await runUniversalAgenticRuntime({
    message: composeWorkerPrompt(input),
    sessionId,
    agentId,
    provider: model.provider,
    modelId: model.modelId,
    apiKey: model.apiKey,
    baseUrl: model.baseUrl,
    workspacePath: input.workspacePath ?? process.cwd(),
    safety: {
      readOnly: true,
      allowFileWrites: false,
      allowShell: false,
      allowNetwork: Boolean(taskHints.likelyNeedsWeb),
      requiresConfirmationForSideEffects: true,
      workspacePath: input.workspacePath ?? process.cwd(),
    },
    taskHints,
    modeSystemHint: [
      "Standing-goal worker tick: finish the selected safe subtask now, then stop.",
      "Use only targeted tools that materially change the result.",
      "Do not continue gathering evidence after the checklist/draft/proposal is already sufficiently grounded.",
    ].join("\n"),
    tools,
    modelLedLane,
    requireToolUse: Boolean(taskHints.likelyNeedsRepo || taskHints.likelyNeedsWeb || taskHints.likelyNeedsAppState),
    deadlineMs: taskHints.evidenceBudget === "light" ? 90_000 : 120_000,
    maxToolCalls: standingGoalToolBudget(taskHints),
    maxTokens: taskHints.evidenceBudget === "light" ? 3000 : 4200,
  });

  const answer = result.answer.trim();
  if (!answer) {
    return {
      status: "blocked",
      summary: "Standing-goal worker returned an empty answer.",
      warnings: ["Empty agentic result; retry after checking model/tool logs."],
      toolsUsed: result.toolsUsed,
      tokensUsed: result.tokensUsed,
    };
  }

  return {
    status: inferWorkerStatus(answer),
    summary: truncateDeliverable(answer),
    deliverables: [truncateDeliverable(answer)],
    toolsUsed: result.toolsUsed,
    tokensUsed: result.tokensUsed,
  };
}

function createGoalRecord(input: { name: string; description: string; organizationId: string | null; deliverables: string[] }): HierarchyGoalRecord {
  return createHierarchyGoal({
    name: input.name,
    description: input.description,
    organizationId: input.organizationId,
    level: "objective",
    status: "active",
    deliverables: input.deliverables,
  });
}

function decomposeGoalIntoBoardTasks(input: { goal: HierarchyGoalRecord; description: string }): BoardTaskRecord[] {
  const organizationId = input.goal.organizationId ?? null;
  const boardId = findBoardForOrganization(organizationId);
  if (!boardId) {
    log.warn("No board found for goal decomposition; tasks skipped", { goalId: input.goal.id });
    return [];
  }
  const tasks: BoardTaskRecord[] = [];
  for (const step of DEFAULT_DECOMPOSITION) {
    const task = createBoardTask({
      boardId,
      organizationId,
      goalId: input.goal.id,
      title: step,
      description: `Auto-decomposed from standing goal: ${input.description}`,
      sourceType: "standing-goal",
      sourceRef: input.goal.id,
      priority: "medium",
      status: step === DEFAULT_DECOMPOSITION[0] ? "in_progress" : "inbox",
    });
    tasks.push(task);
  }
  return tasks;
}

export function parseStandingGoalCommand(raw: string): StandingGoalCommand | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (lowered.startsWith("/goal")) {
    const rest = text.replace(/^\/goal/i, "").trim();
    if (!rest) return null;
    if (/^status\b/i.test(rest)) return { kind: "status" };
    if (/^pause\b/i.test(rest)) {
      const ref = rest.replace(/^pause\b/i, "").trim();
      if (!ref) return null;
      return { kind: "pause", goalRef: ref };
    }
    if (/^resume\b/i.test(rest)) {
      const ref = rest.replace(/^resume\b/i, "").trim();
      if (!ref) return null;
      return { kind: "resume", goalRef: ref };
    }
    if (/^clear\b/i.test(rest)) {
      const ref = rest.replace(/^clear\b/i, "").trim();
      if (!ref) return null;
      return { kind: "clear", goalRef: ref };
    }
    return { kind: "start", description: rest };
  }
  if (lowered.startsWith("/subgoal")) {
    const rest = text.replace(/^\/subgoal/i, "").trim();
    if (!rest) return null;
    return { kind: "subgoal", goalRef: null, description: rest };
  }
  return null;
}

export function executeStandingGoalCommand(command: StandingGoalCommand): StandingGoalResult {
  try {
    if (command.kind === "start") {
      const organization = getActiveHierarchyOrganization() ?? listHierarchyOrganizations()[0] ?? null;
      const goal = createGoalRecord({
        name: command.description.slice(0, 120),
        description: command.description,
        organizationId: organization?.id ?? null,
        deliverables: command.deliverables ?? [],
      });
      const tasks = decomposeGoalIntoBoardTasks({ goal, description: command.description });
      const warnings: string[] = [];
      if (tasks.length === 0) {
        warnings.push("No board was available to decompose the goal into tasks; create a board first.");
      }
      log.info("Standing goal created", { goalId: goal.id, organizationId: organization?.id ?? null, tasks: tasks.length });
      return {
        ok: true,
        message: `Standing goal "${goal.name}" created. ${tasks.length} board task(s) queued${organization ? ` under org ${organization.name}` : ""}.`,
        snapshot: snapshotFromGoal(goal),
        warnings: warnings.length ? warnings : undefined,
      };
    }

    if (command.kind === "status") {
      const goal = resolveActiveGoal(command.goalRef ?? null);
      if (!goal) {
        return { ok: true, message: "No active standing goal." };
      }
      return {
        ok: true,
        message: `Goal "${goal.name}" is ${mapStatusToGoal(goal.status)}.`,
        snapshot: snapshotFromGoal(goal),
      };
    }

    if (command.kind === "pause") {
      const goal = resolveActiveGoal(command.goalRef) ?? getHierarchyGoalById(command.goalRef);
      if (!goal) return { ok: false, message: `Standing goal not found: ${command.goalRef}` };
      updateHierarchyGoal(goal.id, { status: "blocked" });
      return {
        ok: true,
        message: `Standing goal "${goal.name}" paused (status=blocked).`,
        snapshot: snapshotFromGoal({ ...goal, status: "blocked" }),
      };
    }

    if (command.kind === "resume") {
      const goal = resolveActiveGoal(command.goalRef) ?? getHierarchyGoalById(command.goalRef);
      if (!goal) return { ok: false, message: `Standing goal not found: ${command.goalRef}` };
      updateHierarchyGoal(goal.id, { status: "active" });
      return {
        ok: true,
        message: `Standing goal "${goal.name}" resumed.`,
        snapshot: snapshotFromGoal({ ...goal, status: "active" }),
      };
    }

    if (command.kind === "clear") {
      const goal = resolveActiveGoal(command.goalRef) ?? getHierarchyGoalById(command.goalRef);
      if (!goal) return { ok: false, message: `Standing goal not found: ${command.goalRef}` };
      updateHierarchyGoal(goal.id, { status: "done" });
      const tasks = listBoardTasks(undefined, { goalId: goal.id });
      for (const task of tasks) {
        if (task.status !== "done") updateBoardTask(task.id, { status: "done" });
      }
      return {
        ok: true,
        message: `Standing goal "${goal.name}" marked done.`,
        snapshot: snapshotFromGoal({ ...goal, status: "done" }),
      };
    }

    if (command.kind === "subgoal") {
      const goal = resolveActiveGoal(command.goalRef ?? null);
      if (!goal) return { ok: false, message: "No active standing goal to attach a subgoal to." };
      const boardId = findBoardForOrganization(goal.organizationId ?? null);
      if (!boardId) return { ok: false, message: "No board available for the active goal." };
      createBoardTask({
        boardId,
        organizationId: goal.organizationId ?? null,
        goalId: goal.id,
        title: command.description.slice(0, 120),
        description: `Subgoal appended: ${command.description}`,
        sourceType: "standing-subgoal",
        sourceRef: goal.id,
        priority: "medium",
        status: "inbox",
      });
      return {
        ok: true,
        message: `Subgoal added to "${goal.name}".`,
        snapshot: snapshotFromGoal(goal),
      };
    }

    return { ok: false, message: "Unsupported standing goal command." };
  } catch (err) {
    log.warn("Standing goal command failed", { error: String(err) });
    return { ok: false, message: `Standing goal command failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function formatStandingGoalSnapshot(snapshot: StandingGoalSnapshot | undefined): string {
  if (!snapshot) return "";
  const { goal, tasks, readyTaskCount, blockedTaskCount, doneTaskCount } = snapshot;
  const lines: string[] = [];
  lines.push(`Goal: ${goal.name} (status=${goal.status}, level=${goal.level ?? "objective"})`);
  if (goal.description) lines.push(`Description: ${goal.description.slice(0, 320)}`);
  lines.push(`Tasks: ${tasks.length} total · ${readyTaskCount} ready · ${blockedTaskCount} blocked · ${doneTaskCount} done`);
  if (tasks.length > 0) {
    lines.push("Top tasks:");
    for (const task of tasks.slice(0, 6)) {
      lines.push(`- [${task.status}] ${task.title}`);
    }
  }
  const ledger = summarizeGoalLedger(goal.id);
  if (ledger) lines.push(ledger);
  if (snapshot.lastActionAt) lines.push(`Last activity: ${snapshot.lastActionAt}`);
  return lines.join("\n");
}

export async function runStandingGoalDaemonTick(
  options: StandingGoalDaemonTickOptions = {},
): Promise<StandingGoalDaemonTickResult> {
  const maxTasks = Math.max(0, Math.min(5, Math.floor(options.maxTasks ?? 1)));
  const workerId = String(options.workerId || "standing-goal-worker").trim() || "standing-goal-worker";
  const executeTask = options.executeTask ?? defaultStandingGoalTaskExecutor;
  const shouldJudgeWorkerResult =
    options.judge === "always" || (options.judge !== "never" && !options.executeTask);
  const warnings: string[] = [];
  const runs: StandingGoalDaemonTickResult["runs"] = [];
  if (maxTasks <= 0) {
    return {
      ok: true,
      scannedGoals: 0,
      scannedTasks: 0,
      processedTasks: 0,
      idle: true,
      runs,
      warnings: ["maxTasks was 0; no standing-goal work was attempted."],
    };
  }

  const targetGoalId = String(options.goalId || "").trim();
  const activeGoals = listHierarchyGoals()
    .filter((goal) => goal.isActive && goal.status === "active")
    .filter((goal) => targetGoalId ? goal.id === targetGoalId : true);
  let scannedTasks = 0;

  for (const goal of activeGoals) {
    if (runs.length >= maxTasks) break;
    const snapshot = snapshotFromGoal(goal);
    if (!snapshot.tasks.some(isStandingGoalTask)) {
      continue;
    }
    const readyTasks = sortReadyTasks(snapshot.tasks.filter(isReadyTask));
    scannedTasks += snapshot.tasks.length;
    for (const task of readyTasks) {
      if (runs.length >= maxTasks) break;
      const ledgerRun = createGoalRun({
        goalId: goal.id,
        taskId: task.id,
        sessionId: `standing-goal:${goal.id}`,
        maxTurns: 20,
        workerId,
      });
      const runId = ledgerRun.id;
      try {
        lockTaskForExecution(task.id, runId);
        updateGoalRun(runId, {
          status: "running",
          startedAt: new Date().toISOString(),
          turnIndex: ledgerRun.turnIndex + 1,
        });
      } catch (err) {
        updateGoalRun(runId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          lastReason: err instanceof Error ? err.message : String(err),
        });
        warnings.push(`Skipped locked task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      let nextStatus: StandingGoalWorkerStatus = "blocked";
      let summary = "";
      let resultWarnings: string[] | undefined;
      let toolsUsed: string[] | undefined;
      let tokensUsed: number | undefined;
      let judgeResult: GoalJudgeResult | null = null;
      try {
        updateBoardTask(task.id, {
          status: "in_progress",
          checkedOutByAgentId: workerId,
          checkedOutAt: task.checkedOutAt ?? new Date().toISOString(),
        });
        const latestTask = listBoardTasks(undefined, { goalId: goal.id }).find((candidate) => candidate.id === task.id) ?? task;
        const result = await executeTask({
          goal,
          task: latestTask,
          snapshot: snapshotFromGoal(goal),
          runId,
          workerId,
          workspacePath: options.workspacePath ?? null,
        });
        nextStatus = result.status;
        summary = truncateDeliverable(result.summary || "");
        resultWarnings = result.warnings;
        toolsUsed = result.toolsUsed;
        tokensUsed = result.tokensUsed;
        updateGoalRun(runId, {
          status: "review",
          toolsUsed: toolsUsed ?? [],
          deliverables: result.deliverables?.map(truncateDeliverable) ?? (summary ? [summary] : []),
          evidenceSummary: summary.slice(0, 2400),
        });

        judgeResult = shouldJudgeWorkerResult
          ? await judgeWorkerResult({
              goal,
              task: latestTask,
              snapshot: snapshotFromGoal(goal),
              summary,
              deliverables: result.deliverables,
              toolsUsed,
              workerId,
            })
          : null;

        if (judgeResult) {
          const currentBlocker = normalizeBlockerKey(judgeResult.blocker || judgeResult.reason);
          const parseFailures = judgeResult.verdict === "parse_failure"
            ? countRecentParseFailures(goal.id) + 1
            : 0;
          const sameBlockers =
            judgeResult.verdict === "blocked" && currentBlocker
              ? countRecentSameBlockers(goal.id, currentBlocker) + 1
              : judgeResult.verdict === "blocked"
                ? 1
                : 0;
          appendGoalJudgment({
            runId,
            goalId: goal.id,
            taskId: latestTask.id,
            verdict: judgeResult.verdict,
            reason: judgeResult.reason,
            missingCriteria: judgeResult.missingCriteria,
            satisfiedCriteria: judgeResult.satisfiedCriteria,
            rawResponse: judgeResult.rawResponse ?? null,
          });
          updateGoalRun(runId, {
            lastJudgedAt: new Date().toISOString(),
            lastVerdict: judgeResult.verdict,
            lastReason: judgeResult.reason,
            consecutiveParseFailures: parseFailures,
            consecutiveSameBlockers: sameBlockers,
          });

          if (parseFailures >= 3) {
            nextStatus = "blocked";
            resultWarnings = [...(resultWarnings ?? []), "Goal judge produced repeated parse failures; task paused for operator review."];
          } else if (sameBlockers >= 3) {
            nextStatus = "blocked";
            resultWarnings = [...(resultWarnings ?? []), "Repeated blocker detected; task paused for operator/user input."];
          } else if (judgeResult.verdict === "continue") {
            nextStatus = "review";
            const continuation = buildGoalContinuationPlan({ goal, task: latestTask, judge: judgeResult, workerSummary: summary });
            if (continuation.shouldQueueContinuation) {
              createBoardTask({
                boardId: latestTask.boardId,
                organizationId: goal.organizationId ?? null,
                goalId: goal.id,
                title: continuation.title,
                description: continuation.description,
                sourceType: continuation.sourceType,
                sourceRef: runId,
                priority: continuation.priority,
                status: "inbox",
                parentId: latestTask.id,
              });
            }
          } else if (judgeResult.verdict === "blocked" || judgeResult.verdict === "parse_failure") {
            nextStatus = "blocked";
          } else if (judgeResult.verdict === "done" && nextStatus === "review") {
            nextStatus = "done";
          }
        }

        const existingDeliverables = latestTask.deliverables ?? [];
        updateBoardTask(task.id, {
          status: nextStatus,
          description: [
            latestTask.description,
            "",
            `Standing-goal run ${runId}:`,
            summary || "(no summary)",
            judgeResult ? `Judge: ${judgeResult.verdict} - ${judgeResult.reason}` : "",
            resultWarnings?.length ? `Warnings: ${resultWarnings.join("; ")}` : "",
          ].filter(Boolean).join("\n"),
          deliverables: [
            ...existingDeliverables,
            ...(result.deliverables?.map(truncateDeliverable) ?? (summary ? [summary] : [])),
          ].slice(-8),
          checkedOutByAgentId: null,
          checkedOutAt: null,
        });
        updateGoalRun(runId, {
          status: goalRunStatusFromWorkerStatus(nextStatus),
          completedAt: new Date().toISOString(),
          toolsUsed: toolsUsed ?? [],
          deliverables: result.deliverables?.map(truncateDeliverable) ?? (summary ? [summary] : []),
          evidenceSummary: summary.slice(0, 2400),
        });
        runs.push({
          runId,
          goalId: goal.id,
          taskId: task.id,
          status: nextStatus,
          summary,
          warnings: resultWarnings,
          toolsUsed,
          tokensUsed,
        });
      } catch (err) {
        summary = `Standing-goal worker failed: ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(summary);
        updateGoalRun(runId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          lastReason: summary,
        });
        try {
          updateBoardTask(task.id, {
            status: "blocked",
            description: [task.description, "", `Standing-goal run ${runId} failed:`, summary].filter(Boolean).join("\n"),
            checkedOutByAgentId: null,
            checkedOutAt: null,
          });
        } catch (updateErr) {
          warnings.push(`Could not mark task ${task.id} blocked: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`);
        }
        runs.push({
          runId,
          goalId: goal.id,
          taskId: task.id,
          status: "blocked",
          summary,
          warnings: [summary],
        });
      } finally {
        try {
          unlockTaskExecution(task.id, runId);
        } catch (err) {
          warnings.push(`Could not unlock task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const refreshed = snapshotFromGoal(goal);
      if (refreshed.tasks.length > 0 && refreshed.tasks.every((candidate) => candidate.status === "done")) {
        updateHierarchyGoal(goal.id, { status: "done" });
      }
    }
  }

  return {
    ok: true,
    scannedGoals: activeGoals.length,
    scannedTasks,
    processedTasks: runs.length,
    idle: runs.length === 0,
    runs,
    warnings: warnings.length ? warnings : undefined,
  };
}

export const __standingGoalTestHooks = {
  slugify,
  composeWorkerPrompt,
  inferWorkerStatus,
  inferStandingGoalTaskHints,
  isReadyTask,
  isStandingGoalTask,
};
