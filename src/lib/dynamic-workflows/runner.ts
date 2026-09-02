import { nanoid } from "nanoid";
import type {
  DynamicWorkflowPlan,
  DynamicWorkflowPhase,
  DynamicWorkflowWorkerSpec,
  DynamicWorkflowRunRecord,
  DynamicWorkflowPhaseRecord,
  DynamicWorkflowWorkerRecord,
  DynamicWorkflowEventRecord,
  DynamicWorkflowRunStatus,
  DynamicWorkflowPhaseStatus,
  DynamicWorkflowWorkerStatus,
  DynamicWorkflowSourceType,
  DynamicWorkflowWorkerResult,
  DynamicWorkflowAgentKind,
} from "./types";
import {
  upsertDynamicWorkflowRun,
  upsertDynamicWorkflowPhase,
  upsertDynamicWorkflowWorker,
  getDynamicWorkflowRun,
  getDynamicWorkflowPhases,
  getDynamicWorkflowWorkers,
  getDynamicWorkflowWorker,
  createDynamicWorkflowEvent,
} from "./store";
import { DEFAULT_SAFETY_LIMITS, checkSafetyGates, defaultMaxConcurrency, defaultMaxWorkers, registerRunEnd, registerRunStart } from "./safety";
import { executeWorker } from "./worker-executor";
import {
  auditAcceptance,
  completeRepairAttempt,
  createRepairAttempt,
  evaluateCriterion,
  initializeRunCriteria,
  listRunCriteria,
  recordEvidence,
} from "./criteria";
import { executeVerification } from "./verification";
import { preflightDynamicWorkflowPlan } from "./preflight";
import { appendWorkTrailEvent, updateWorkTrailStatus } from "@/lib/work-trails/work-trails";
import { getCachedResult, setCachedResult, invalidateWorkerCache, invalidatePhaseCache, computeCacheKey } from "./cache";
import { logger } from "@/lib/utils/logger";
import { estimatePlanCost } from "./planner";
import { resolveDynamicWorkflowSourceContext } from "./source-context";

const log = logger.child("dynamic-workflows:runner");

const runningRuns: Map<string, AbortController> = new Map();

function now(): string {
  return new Date().toISOString();
}

function persistedWorkerOutput(worker: DynamicWorkflowWorkerRecord): string {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = worker.resultJson ? JSON.parse(worker.resultJson) as Record<string, unknown> : null;
  } catch { /* a truncated legacy result still has its persisted summary */ }
  const evidence = parsed ? {
    status: parsed.status,
    summary: parsed.summary,
    findings: parsed.findings,
    criterionEvaluations: parsed.criterionEvaluations,
    changedFiles: parsed.changedFiles,
    artifacts: parsed.artifacts,
    screenshots: parsed.screenshots,
    nextActions: parsed.nextActions,
  } : null;
  return JSON.stringify({
    role: worker.role,
    phaseId: worker.phaseId,
    persistedSummary: worker.resultSummary,
    output: evidence,
  }).slice(0, 6_000);
}

function emitEvent(
  runId: string,
  eventType: string,
  opts: {
    phaseId?: string;
    workerId?: string;
    title?: string;
    detail?: string;
    payloadJson?: string;
  },
): void {
  const record: DynamicWorkflowEventRecord = {
    id: nanoid(),
    runId,
    phaseId: opts.phaseId ?? null,
    workerId: opts.workerId ?? null,
    eventType,
    title: opts.title ?? null,
    detail: opts.detail ?? null,
    payloadJson: opts.payloadJson ?? null,
    createdAt: now(),
  };
  try {
    createDynamicWorkflowEvent(record);
    const run = getDynamicWorkflowRun(runId);
    if (run?.workTrailId) {
      const mirror: Record<string, Parameters<typeof appendWorkTrailEvent>[0]["eventType"]> = {
        "run.created": "supervised_run_created",
        "run.started": "supervised_run_started",
        "run.completed": "supervised_run_completed",
        "run.failed": "supervised_run_failed",
        "run.needs_human": "supervised_run_failed",
        "criterion.evaluated": "criterion_evaluated",
        "evidence.recorded": "evidence_recorded",
        "run.verification_started": "validation_started",
        "run.verification_completed": "validation_completed",
      };
      const mirroredType = mirror[eventType];
      if (mirroredType) {
        appendWorkTrailEvent({
          trailId: run.workTrailId,
          eventType: mirroredType,
          surface: "workflows",
          objectType: eventType.startsWith("criterion") ? "criterion" : eventType.startsWith("evidence") ? "evidence" : "dynamic-run",
          objectId: runId,
          objectName: run.name,
          summary: opts.title || opts.detail || eventType,
          metadata: { phaseId: opts.phaseId, workerId: opts.workerId },
        });
        if (eventType === "run.started") updateWorkTrailStatus(run.workTrailId, "executing");
        if (eventType === "run.completed") updateWorkTrailStatus(run.workTrailId, "completed");
        if (eventType === "run.failed" || eventType === "run.needs_human") updateWorkTrailStatus(run.workTrailId, "failed");
      }
    }
  } catch (err) {
    log.warn("Failed to persist event", { eventType, runId, error: String(err) });
  }
}

function buildWorkerRecord(
  spec: DynamicWorkflowWorkerSpec,
  runId: string,
  phaseId: string,
  index: number,
  plan: DynamicWorkflowPlan,
): DynamicWorkflowWorkerRecord {
  const id = nanoid();
  const role = spec.role.toLowerCase();
  const binding = plan.supervision?.mode === "supervised"
    ? (role.includes("plan") || role.includes("supervisor")
        ? plan.supervision.planner
        : role.includes("review") || role.includes("verify")
          ? plan.supervision.reviewer
          : plan.supervision.implementer)
    : undefined;
  const toolsets = spec.toolsets ?? binding?.toolsets;
  return {
    id,
    runId,
    phaseId,
    workerIndex: index,
    role: spec.role,
    status: "queued",
    agentKind: (spec.agentKind || binding?.agentKind || "internal") as DynamicWorkflowAgentKind,
    agentId: spec.agentId ?? binding?.agentId ?? null,
    modelRef: spec.modelRef ?? binding?.modelRef ?? null,
    prompt: spec.prompt,
    toolPolicyJson: toolsets ? JSON.stringify({ toolsets }) : null,
    resultSummary: null,
    resultJson: null,
    error: null,
    cachedResultKey: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    startedAt: null,
    completedAt: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

function buildPhaseRecord(
  phase: DynamicWorkflowPhase,
  runId: string,
  index: number,
): DynamicWorkflowPhaseRecord {
  return {
    id: phase.id,
    runId,
    phaseIndex: index,
    name: phase.name,
    status: "pending",
    instructions: phase.instructions,
    dependsOnPhaseIds: phase.dependsOn ? JSON.stringify(phase.dependsOn) : null,
    startedAt: null,
    completedAt: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

function resolvePhaseOrder(phases: DynamicWorkflowPhase[]): string[] {
  const visited = new Set<string>();
  const resolved = new Set<string>();
  const order: string[] = [];
  const phaseMap = new Map(phases.map((p) => [p.id, p]));

  function visit(id: string): void {
    if (resolved.has(id)) return;
    if (visited.has(id)) return;
    visited.add(id);
    const phase = phaseMap.get(id);
    if (phase?.dependsOn) {
      for (const dep of phase.dependsOn) {
        if (phaseMap.has(dep)) {
          visit(dep);
        }
      }
    }
    resolved.add(id);
    order.push(id);
  }

  for (const phase of phases) {
    if (!resolved.has(phase.id)) {
      visit(phase.id);
    }
  }

  return order;
}

function isAborted(runId: string): boolean {
  const controller = runningRuns.get(runId);
  return controller ? controller.signal.aborted : false;
}

function checkAborted(runId: string): void {
  const controller = runningRuns.get(runId);
  if (controller?.signal.aborted) {
    throw new AbortRunSignal(runId);
  }
}

class AbortRunSignal extends Error {
  runId: string;
  constructor(runId: string) {
    super(`Run ${runId} was aborted`);
    this.name = "AbortRunSignal";
    this.runId = runId;
  }
}

class BudgetExceededSignal extends Error {
  constructor(readonly runId: string, readonly spent: number, readonly limit: number) {
    super(`Run ${runId} spent $${spent.toFixed(6)}, exceeding its $${limit.toFixed(6)} budget.`);
    this.name = "BudgetExceededSignal";
  }
}

function currentRunCost(runId: string): number {
  return getDynamicWorkflowWorkers(runId).reduce((sum, worker) => sum + Math.max(0, worker.costUsd || 0), 0);
}

function checkRunBudget(runId: string, plan: DynamicWorkflowPlan): void {
  const limit = plan.limits.budgetLimitUsd ?? DEFAULT_SAFETY_LIMITS.budgetLimitUsd;
  const spent = currentRunCost(runId);
  if (spent >= limit) throw new BudgetExceededSignal(runId, spent, limit);
}

function persistCriterionEvaluations(
  runId: string,
  workerId: string,
  result: DynamicWorkflowWorkerResult,
): void {
  if (!result.criterionEvaluations?.length) return;
  const criterionIds = new Set(listRunCriteria(runId).map((criterion) => criterion.id));
  for (const evaluation of result.criterionEvaluations) {
    if (!criterionIds.has(evaluation.criterionId)) continue;
    if (evaluation.status === "passed") {
      const evidence = recordEvidence({
        runId,
        criterionId: evaluation.criterionId,
        evidenceType: "review",
        sourceType: "dynamic-worker",
        sourceId: workerId,
        summary: evaluation.evidence || evaluation.summary,
        payload: { reviewerSummary: evaluation.summary },
      });
      emitEvent(runId, "evidence.recorded", {
        workerId,
        title: `Evidence recorded for ${evaluation.criterionId}`,
        detail: evidence.summary.slice(0, 500),
        payloadJson: JSON.stringify({ criterionId: evaluation.criterionId, evidenceId: evidence.id }),
      });
    }
    evaluateCriterion({
      runId,
      criterionId: evaluation.criterionId,
      status: evaluation.status,
      evaluatorWorkerId: workerId,
    });
    emitEvent(runId, "criterion.evaluated", {
      workerId,
      title: `${evaluation.criterionId}: ${evaluation.status}`,
      detail: evaluation.summary.slice(0, 1000),
      payloadJson: JSON.stringify({ criterionId: evaluation.criterionId, status: evaluation.status }),
    });
  }
}

async function executeWorkersInPhase(
  runId: string,
  phaseId: string,
  phase: DynamicWorkflowPhase,
  plan: DynamicWorkflowPlan,
): Promise<DynamicWorkflowWorkerResult[]> {
  const maxConcurrency = plan.limits.maxConcurrency || defaultMaxConcurrency;
  const sourceContext = resolveDynamicWorkflowSourceContext(plan);
  const workers = getDynamicWorkflowWorkers(runId, phaseId).filter(
    (w) => w.status === "queued" || w.status === "running",
  );

  if (workers.length === 0) return [];

  const results: DynamicWorkflowWorkerResult[] = [];
  const running: Promise<void>[] = [];
  let nextIndex = 0;

  async function runNextWorker(): Promise<void> {
    while (nextIndex < workers.length) {
      checkAborted(runId);
      checkRunBudget(runId, plan);
      const idx = nextIndex++;
      const worker = workers[idx];
      if (!worker || (worker.status !== "queued" && worker.status !== "running")) continue;
      const phaseRecord = getPhaseRecord(phaseId, runId);

      const cached = getCachedResult(runId, phaseId, worker);
      if (cached) {
        const resultStatus: DynamicWorkflowWorkerStatus = cached.status;
        upsertDynamicWorkflowWorker({
          ...worker,
          status: resultStatus,
          resultSummary: cached.summary.slice(0, 5000),
          resultJson: JSON.stringify(cached).slice(0, 32000),
          error: resultStatus === "failed" || resultStatus === "timed_out" ? cached.summary.slice(0, 2000) : null,
          cachedResultKey: computeCacheKey(worker),
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          completedAt: now(),
          updatedAt: now(),
        });
        emitEvent(runId, resultStatus === "completed" ? "worker.completed" : `worker.${resultStatus}`, {
          phaseId,
          workerId: worker.id,
          title: `Worker "${worker.role}" ${resultStatus} from cache`,
          detail: cached.summary.slice(0, 500),
        });
        if (phase.strategy === "review" || phase.strategy === "verify" || worker.role.toLowerCase().includes("review")) {
          persistCriterionEvaluations(runId, worker.id, cached);
        }
        results.push(cached);
        continue;
      }

      upsertDynamicWorkflowWorker({
        ...worker,
        status: "running",
        startedAt: worker.startedAt || now(),
        updatedAt: now(),
      });

      const cumulativeCostUsd = currentRunCost(runId);
      const budgetLimitUsd = plan.limits.budgetLimitUsd ?? DEFAULT_SAFETY_LIMITS.budgetLimitUsd;
      const currentRun = getDynamicWorkflowRun(runId);
      if (currentRun) {
        upsertDynamicWorkflowRun({ ...currentRun, actualCostUsd: cumulativeCostUsd, updatedAt: now() });
      }
      if (cumulativeCostUsd > budgetLimitUsd) {
        emitEvent(runId, "run.failed", {
          phaseId,
          workerId: worker.id,
          title: "Approved budget exhausted",
          detail: `Spent $${cumulativeCostUsd.toFixed(6)} against the $${budgetLimitUsd.toFixed(6)} cap. No later worker or repair pass will start.`,
          payloadJson: JSON.stringify({ cumulativeCostUsd, budgetLimitUsd }),
        });
        throw new BudgetExceededSignal(runId, cumulativeCostUsd, budgetLimitUsd);
      }

      emitEvent(runId, "worker.started", {
        phaseId,
        workerId: worker.id,
        title: `Worker "${worker.role}" started`,
        detail: worker.prompt.slice(0, 500),
      });

      let result: DynamicWorkflowWorkerResult;
      try {
        const priorSummaries = getDynamicWorkflowWorkers(runId)
          .filter((candidate) => candidate.id !== worker.id && candidate.status === "completed" && candidate.resultSummary)
          .slice(-8)
          .map(persistedWorkerOutput);
        result = await executeWorker(worker, phase, plan, runId, {
          runModelRef: getDynamicWorkflowRun(runId)?.modelRef,
          signal: runningRuns.get(runId)?.signal,
          timeoutMs: Math.min(600_000, Math.max(5_000, (plan.limits.maxRuntimeSeconds || 120) * 1000)),
          priorSummaries,
          sourceContext,
          onToolEvent: (event) => emitEvent(runId, "worker.tool", {
            phaseId,
            workerId: worker.id,
            title: `${event.name} ${event.stage}`,
            detail: event.stage === "completed"
              ? (event.success ? "Tool completed." : "Tool failed.")
              : "Tool started.",
            payloadJson: JSON.stringify({ name: event.name, stage: event.stage, success: event.success }),
          }),
        });
      } catch (err) {
        if (err instanceof AbortRunSignal) throw err;
        log.warn("Worker execution threw", { workerId: worker.id, error: String(err) });
        const message = String(err);
        result = {
          status: /timed out/i.test(message) ? "timed_out" : /cancelled|aborted/i.test(message) ? "cancelled" : "failed",
          summary: `Worker execution failed: ${message.slice(0, 1000)}`,
        };
      }

      const resultStatus: DynamicWorkflowWorkerStatus = result.status;
      const resultJson = JSON.stringify(result);

      upsertDynamicWorkflowWorker({
        ...worker,
        status: resultStatus,
        resultSummary: result.summary.slice(0, 5000),
        resultJson: resultJson.slice(0, 32000),
        error: resultStatus === "failed" || resultStatus === "timed_out" ? result.summary.slice(0, 2000) : null,
        modelRef: result.resolvedProvider && result.resolvedModelId
          ? `${result.resolvedProvider}:${result.resolvedModelId}`
          : worker.modelRef,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        costUsd: result.usage?.costUsd ?? null,
        completedAt: now(),
        updatedAt: now(),
      });

      const cacheKey = computeCacheKey(worker);
      setCachedResult(runId, phaseId, worker.id, cacheKey, result);

      emitEvent(runId, resultStatus === "completed" ? "worker.completed" : `worker.${resultStatus}`, {
        phaseId,
        workerId: worker.id,
        title: `Worker "${worker.role}" ${resultStatus}`,
        detail: result.summary.slice(0, 500),
        payloadJson: resultJson.slice(0, 8000),
      });

      results.push(result);

      if (phase.strategy === "review" || phase.strategy === "verify" || worker.role.toLowerCase().includes("review")) {
        persistCriterionEvaluations(runId, worker.id, result);
      }
    }
  }

  const concurrency = Math.min(maxConcurrency, workers.length);
  for (let i = 0; i < concurrency; i++) {
    running.push(runNextWorker());
  }

  await Promise.all(running);

  return results;
}

async function executeSyntheticSupervisionPhase(input: {
  runId: string;
  plan: DynamicWorkflowPlan;
  name: string;
  role: "implementer" | "reviewer";
  strategy: "single" | "review";
  prompt: string;
  attempt: number;
}): Promise<DynamicWorkflowWorkerResult[]> {
  const phase: DynamicWorkflowPhase = {
    id: `supervision-${input.role}-${input.attempt}-${nanoid(6)}`,
    name: input.name,
    instructions: input.prompt,
    strategy: input.strategy,
    workers: [{
      id: `supervision-${input.role}-${input.attempt}`,
      role: input.role,
      prompt: input.prompt,
    }],
  };
  upsertDynamicWorkflowPhase({
    ...buildPhaseRecord(phase, input.runId, getDynamicWorkflowPhases(input.runId).length),
    status: "running",
    startedAt: now(),
  });
  const worker = buildWorkerRecord(phase.workers[0], input.runId, phase.id, 0, input.plan);
  upsertDynamicWorkflowWorker(worker);
  emitEvent(input.runId, "phase.started", {
    phaseId: phase.id,
    title: `${phase.name} started`,
    detail: input.prompt.slice(0, 500),
  });
  const results = await executeWorkersInPhase(input.runId, phase.id, phase, input.plan);
  const failed = results.some((result) => result.status !== "completed");
  const phaseRecord = getDynamicWorkflowPhases(input.runId).find((candidate) => candidate.id === phase.id);
  if (phaseRecord) {
    upsertDynamicWorkflowPhase({
      ...phaseRecord,
      status: failed ? "failed" : "completed",
      completedAt: now(),
      updatedAt: now(),
    });
  }
  emitEvent(input.runId, failed ? "phase.failed" : "phase.completed", {
    phaseId: phase.id,
    title: `${phase.name} ${failed ? "failed" : "completed"}`,
  });
  return results;
}

async function runSupervisionLoop(runId: string, plan: DynamicWorkflowPlan): Promise<"completed" | "failed" | "needs_human"> {
  if (plan.supervision?.mode !== "supervised") return "completed";
  const maxRepairPasses = Math.max(0, Math.min(2, plan.supervision.maxRepairPasses ?? 1));
  let criteria = listRunCriteria(runId);
  const hasReviewEvaluation = criteria.some((criterion) => criterion.evaluatorWorkerId);

  if (!hasReviewEvaluation) {
    checkRunBudget(runId, plan);
    emitEvent(runId, "supervision.review.completed", {
      title: "Initial structured review requested",
      detail: "No criterion evaluation was produced by the planned phases; running the bound reviewer.",
    });
    await executeSyntheticSupervisionPhase({
      runId,
      plan,
      name: "Acceptance review",
      role: "reviewer",
      strategy: "review",
      attempt: 0,
      prompt: [
        "Evaluate every acceptance criterion independently from the implementer.",
        "Return criterionEvaluations for every criterion ID. Do not pass a criterion without concrete evidence.",
        `Criteria: ${JSON.stringify(criteria.map(({ id, statement, required, methods }) => ({ id, statement, required, methods })))}`,
      ].join("\n\n"),
    });
  }

  for (let attempt = 1; attempt <= maxRepairPasses; attempt++) {
    checkAborted(runId);
    checkRunBudget(runId, plan);
    criteria = listRunCriteria(runId);
    const failed = criteria.filter((criterion) => criterion.required && criterion.status === "failed");
    if (failed.length === 0) break;
    const repair = createRepairAttempt({
      runId,
      attemptNumber: attempt,
      failedCriterionIds: failed.map((criterion) => criterion.id),
    });
    emitEvent(runId, "supervision.repair.started", {
      title: `Repair pass ${attempt} started`,
      detail: failed.map((criterion) => `${criterion.id}: ${criterion.statement}`).join("\n").slice(0, 4000),
      payloadJson: JSON.stringify({ repairAttemptId: repair.id, criterionIds: repair.failedCriterionIds }),
    });
    const repairResults = await executeSyntheticSupervisionPhase({
      runId,
      plan,
      name: `Targeted repair ${attempt}`,
      role: "implementer",
      strategy: "single",
      attempt,
      prompt: [
        "Repair only the failed criteria below. Preserve the approved scope and do not regress passed criteria.",
        JSON.stringify(failed.map(({ id, statement }) => ({ id, statement }))),
      ].join("\n\n"),
    });
    if (repairResults.some((result) => result.status !== "completed")) {
      completeRepairAttempt(repair.id, "failed");
      return "failed";
    }
    await executeSyntheticSupervisionPhase({
      runId,
      plan,
      name: `Repair review ${attempt}`,
      role: "reviewer",
      strategy: "review",
      attempt,
      prompt: [
        "Re-evaluate the repaired criteria and any regression-sensitive passed criteria.",
        "Return criterionEvaluations with concrete evidence. Actual verification failures cannot be overridden.",
        JSON.stringify(criteria.map(({ id, statement, status, methods }) => ({ id, statement, status, methods }))),
      ].join("\n\n"),
    });
    completeRepairAttempt(repair.id, "completed");
    emitEvent(runId, "supervision.repair.completed", {
      title: `Repair pass ${attempt} completed`,
      payloadJson: JSON.stringify({ repairAttemptId: repair.id }),
    });
  }

  const audit = auditAcceptance(runId);
  if (audit.passed) return "completed";
  const hasUnverified = audit.requiredFailures.some(
    (criterion) => criterion.status === "pending" || criterion.status === "unverified",
  );
  return hasUnverified ? "needs_human" : "failed";
}

function getPhaseRecord(phaseId: string, runId: string): DynamicWorkflowPhase {
  const record = getDynamicWorkflowPhases(runId).find((p) => p.id === phaseId);
  if (!record) throw new Error(`Phase ${phaseId} not found in run ${runId}`);
  return {
    id: record.id,
    name: record.name,
    instructions: record.instructions || "",
    strategy: "fanout",
    workers: [],
    dependsOn: record.dependsOnPhaseIds ? JSON.parse(record.dependsOnPhaseIds) : undefined,
  };
}

async function executeRun(runId: string): Promise<void> {
  const run = getDynamicWorkflowRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const aborted = new AbortController();
  const existing = runningRuns.get(runId);
  if (existing) {
    try { existing.abort(); } catch { /* best-effort */ }
  }
  runningRuns.set(runId, aborted);

  let plan: DynamicWorkflowPlan;
  try {
    plan = JSON.parse(run.planJson) as DynamicWorkflowPlan;
  } catch {
    upsertDynamicWorkflowRun({ ...run, status: "failed", completedAt: now(), updatedAt: now() });
    emitEvent(runId, "run.failed", {
      title: "Failed to parse plan",
      detail: "plan_json is not valid JSON.",
    });
    runningRuns.delete(runId);
    return;
  }

  const safetyCheck = checkSafetyGates(run, plan);
  if (!safetyCheck.passed) {
    upsertDynamicWorkflowRun({ ...run, status: "failed", completedAt: now(), updatedAt: now() });
    emitEvent(runId, "run.failed", {
      title: "Safety gate failed",
      detail: safetyCheck.reason || "Run rejected by safety check.",
    });
    runningRuns.delete(runId);
    return;
  }
  const runStartedAt = run.startedAt || now();
  upsertDynamicWorkflowRun({
    ...run,
    status: "running",
    startedAt: runStartedAt,
    updatedAt: now(),
  });

  emitEvent(runId, "run.started", {
    title: `Run "${run.name}" started`,
    detail: `Objective: ${plan.objective.slice(0, 500)}`,
    payloadJson: run.planJson.slice(0, 8000),
  });

  const phaseOrder = resolvePhaseOrder(plan.phases);
  const phaseMap = new Map(plan.phases.map((p) => [p.id, p]));
  const completedPhaseIds = new Set<string>();
  let anyFailed = false;
  registerRunStart();

  try {
    for (const phaseId of phaseOrder) {
      checkAborted(runId);

      const planPhase = phaseMap.get(phaseId);
      if (!planPhase) continue;

      const phaseWorkers = getDynamicWorkflowWorkers(runId, phaseId);
      const phaseRecord = phaseWorkers.length > 0
        ? getDynamicWorkflowPhases(runId).find((p) => p.id === phaseId)
        : null;

      if (planPhase.dependsOn && planPhase.dependsOn.length > 0) {
        const depsOk = planPhase.dependsOn.every((depId) => {
          const depPhase = getDynamicWorkflowPhases(runId).find((p) => p.id === depId);
          return depPhase && depPhase.status === "completed";
        });
        const depsFailed = planPhase.dependsOn.some((depId) => {
          const depPhase = getDynamicWorkflowPhases(runId).find((p) => p.id === depId);
          return depPhase && depPhase.status === "failed";
        });

        if (!depsOk) {
          const skipStatus = depsFailed ? "failed" : "skipped";
          if (phaseRecord) {
            upsertDynamicWorkflowPhase({
              ...phaseRecord,
              status: skipStatus,
              updatedAt: now(),
            });
          }
          emitEvent(runId, `phase.${skipStatus}`, {
            phaseId,
            title: `Phase "${planPhase.name}" ${skipStatus}`,
            detail: depsFailed
              ? `Dependency phase(s) failed.`
              : `Dependencies not satisfied: ${planPhase.dependsOn.filter((d) => !completedPhaseIds.has(d)).join(", ")}`,
          });
          if (depsFailed) anyFailed = true;
          continue;
        }
      }

      upsertDynamicWorkflowPhase({
        ...buildPhaseRecord(planPhase, runId, phaseOrder.indexOf(phaseId)),
        status: "running",
        startedAt: now(),
        updatedAt: now(),
      });

      emitEvent(runId, "phase.started", {
        phaseId,
        title: `Phase "${planPhase.name}" started`,
        detail: planPhase.instructions.slice(0, 500),
      });

      const results = await executeWorkersInPhase(runId, phaseId, planPhase, plan);

      checkAborted(runId);

      const hasFailures = results.some((r) => r.status === "failed" || r.status === "timed_out");
      const isReviewOrVerify = planPhase.strategy === "review" || planPhase.strategy === "verify";

      let phaseStatus: DynamicWorkflowPhaseStatus = "completed";
      if (hasFailures && (isReviewOrVerify || plan.supervision?.mode === "supervised")) {
        phaseStatus = "failed";
        anyFailed = true;
      } else if (hasFailures) {
        phaseStatus = "completed";
      }

      const currentPhase = getDynamicWorkflowPhases(runId).find((p) => p.id === phaseId);
      if (currentPhase) {
        upsertDynamicWorkflowPhase({
          ...currentPhase,
          status: phaseStatus,
          completedAt: now(),
          updatedAt: now(),
        });
      }

      completedPhaseIds.add(phaseId);

      emitEvent(runId, "phase.completed", {
        phaseId,
        title: `Phase "${planPhase.name}" ${phaseStatus}`,
        detail: `${results.length} workers completed. ${results.filter((r) => r.status === "failed").length} failed.`,
      });
    }

    checkAborted(runId);

    let supervisionStatus = await runSupervisionLoop(runId, plan);
    if (supervisionStatus === "failed") anyFailed = true;

    const criteriaNeedExecutableVerification = listRunCriteria(runId).some(
      (criterion) => criterion.methods.includes("command") || criterion.methods.includes("browser"),
    );
    if (plan.verification || criteriaNeedExecutableVerification) {
      const verifyResult = await applyVerification(runId, plan);
      if (!verifyResult.passed) {
        anyFailed = true;
      }
    }

    if (plan.supervision?.mode === "supervised" || plan.acceptanceContract?.length) {
      const acceptance = auditAcceptance(runId);
      if (!acceptance.passed) {
        const hasUnverified = acceptance.requiredFailures.some(
          (criterion) => criterion.status === "pending" || criterion.status === "unverified",
        );
        supervisionStatus = hasUnverified ? "needs_human" : "failed";
        if (!hasUnverified) anyFailed = true;
      }
    }

    const finalStatus: DynamicWorkflowRunStatus = supervisionStatus === "needs_human"
      ? "needs_human"
      : anyFailed || supervisionStatus === "failed"
        ? "failed"
        : "completed";
    const actualCostUsd = getDynamicWorkflowWorkers(runId)
      .reduce((sum, worker) => sum + (worker.costUsd || 0), 0);

    upsertDynamicWorkflowRun({
      ...run,
      status: finalStatus,
      startedAt: runStartedAt,
      actualCostUsd,
      completedAt: now(),
      updatedAt: now(),
    });

    emitEvent(runId, finalStatus === "needs_human" ? "run.needs_human" : finalStatus === "failed" ? "run.failed" : "run.completed", {
      title: `Run "${run.name}" ${finalStatus}`,
      detail: finalStatus === "needs_human"
        ? "Required criteria remain unverified and need human review."
        : finalStatus === "failed"
          ? "Some phases, criteria, or verification steps failed."
          : "All required criteria and verification steps completed successfully.",
    });
    if (finalStatus === "completed" && run.workTrailId) {
      await import("@/lib/publishing/service")
        .then(({ processAutoPublishForCompletedRun }) => processAutoPublishForCompletedRun(runId, run.workTrailId!))
        .catch((error) => log.warn("Auto-publish lifecycle check failed", { runId, error: String(error) }));
    }
  } catch (err) {
    if (err instanceof AbortRunSignal) {
      upsertDynamicWorkflowRun({
        ...run,
        status: "cancelled",
        startedAt: runStartedAt,
        completedAt: now(),
        updatedAt: now(),
      });
      emitEvent(runId, "run.cancelled", {
        title: `Run "${run.name}" cancelled`,
        detail: "Run was cancelled during execution.",
      });
    } else if (err instanceof BudgetExceededSignal) {
      upsertDynamicWorkflowRun({
        ...run,
        status: "failed",
        startedAt: runStartedAt,
        actualCostUsd: err.spent,
        error: err.message,
        completedAt: now(),
        updatedAt: now(),
      });
      emitEvent(runId, "run.failed", {
        title: `Run "${run.name}" stopped at its budget cap`,
        detail: err.message,
        payloadJson: JSON.stringify({ actualCostUsd: err.spent, budgetLimitUsd: err.limit }),
      });
    } else {
      log.error("Run execution failed", { runId, error: String(err) });
      upsertDynamicWorkflowRun({
        ...run,
        status: "failed",
        startedAt: runStartedAt,
        completedAt: now(),
        updatedAt: now(),
      });
      emitEvent(runId, "run.failed", {
        title: `Run "${run.name}" failed`,
        detail: `Unexpected error: ${String(err).slice(0, 1000)}`,
      });
    }
  } finally {
    registerRunEnd();
    runningRuns.delete(runId);
  }
}

export async function createAndStartRun(
  plan: DynamicWorkflowPlan,
  opts: {
    name: string;
    description?: string;
    sourceType?: DynamicWorkflowSourceType;
    sourceRef?: string;
    organizationId?: string;
    goalId?: string;
    boardTaskId?: string;
    workTrailId?: string;
    sessionId?: string;
    modelRef?: string;
    managerAgentId?: string;
  },
): Promise<DynamicWorkflowRunRecord> {
  const preflight = preflightDynamicWorkflowPlan(plan, opts.modelRef);
  if (!preflight.ok) {
    throw new Error(preflight.issues.map((issue) => `${issue.field}: ${issue.message}`).join(" "));
  }
  const runId = nanoid();
  const ts = now();

  const maxConcurrency = plan.limits?.maxConcurrency || defaultMaxConcurrency;
  const maxWorkers = plan.limits?.maxWorkers || defaultMaxWorkers;
  const totalSpecWorkers = plan.phases.reduce((sum, p) => sum + p.workers.length, 0);
  const estimatedCostUsd = estimatePlanCost(plan);

  if (totalSpecWorkers > maxWorkers) {
    throw new Error(
      `Plan specifies ${totalSpecWorkers} workers but run max is ${maxWorkers}. Reduce workers or increase the limit.`,
    );
  }

  const runRecord: DynamicWorkflowRunRecord = {
    id: runId,
    name: opts.name,
    description: opts.description ?? null,
    status: "queued",
    sourceType: opts.sourceType ?? null,
    sourceRef: opts.sourceRef ?? null,
    organizationId: opts.organizationId ?? null,
    goalId: opts.goalId ?? null,
    boardTaskId: opts.boardTaskId ?? null,
    workTrailId: opts.workTrailId ?? null,
    managerAgentId: opts.managerAgentId ?? plan.supervision?.planner.agentId ?? null,
    modelRef: opts.modelRef ?? null,
    maxConcurrency,
    maxWorkers,
    approvalPolicy: "confirm_once",
    budgetLimitUsd: plan.limits?.budgetLimitUsd ?? null,
    estimatedCostUsd,
    actualCostUsd: null,
    error: null,
    planJson: JSON.stringify(plan),
    savedCommandName: null,
    createdBySessionId: opts.sessionId ?? null,
    createdAt: ts,
    updatedAt: ts,
    startedAt: null,
    completedAt: null,
  };

  upsertDynamicWorkflowRun(runRecord);
  initializeRunCriteria(runId, plan);

  emitEvent(runId, "run.created", {
    title: `Run "${opts.name}" created`,
    detail: opts.description?.slice(0, 500) ?? `${plan.phases.length} phases, ${totalSpecWorkers} workers`,
    payloadJson: runRecord.planJson.slice(0, 8000),
  });

  for (let i = 0; i < plan.phases.length; i++) {
    const phase = plan.phases[i];
    const phaseRecord = buildPhaseRecord(phase, runId, i);
    upsertDynamicWorkflowPhase(phaseRecord);

    for (let j = 0; j < phase.workers.length; j++) {
      const workerSpec = phase.workers[j];
      const workerRecord = buildWorkerRecord(workerSpec, runId, phase.id, j, plan);
      upsertDynamicWorkflowWorker(workerRecord);
    }
  }

  void executeRun(runId).catch((err) => {
    log.error("Background run execution failed", { runId, error: String(err) });
  });

  return runRecord;
}

export async function resumeRun(runId: string): Promise<void> {
  const run = getDynamicWorkflowRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  if (run.status !== "paused") {
    throw new Error(`Cannot resume run with status "${run.status}". Only paused runs can be resumed.`);
  }

  upsertDynamicWorkflowRun({
    ...run,
    status: "running",
    updatedAt: now(),
  });

  emitEvent(runId, "run.resumed", {
    title: `Run "${run.name}" resumed`,
  });

  void executeRun(runId).catch((err) => {
    log.error("Background resume execution failed", { runId, error: String(err) });
  });
}

export function pauseRun(runId: string): void {
  const run = getDynamicWorkflowRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  if (run.status !== "running") {
    throw new Error(`Cannot pause run with status "${run.status}".`);
  }

  const controller = runningRuns.get(runId);
  if (controller) {
    controller.abort();
    runningRuns.delete(runId);
  }

  upsertDynamicWorkflowRun({
    ...run,
    status: "paused",
    updatedAt: now(),
  });

  const runningPhases = getDynamicWorkflowPhases(runId).filter((p) => p.status === "running");
  for (const phase of runningPhases) {
    upsertDynamicWorkflowPhase({
      ...phase,
      status: "paused",
      updatedAt: now(),
    });
  }

  const runningWorkers = getDynamicWorkflowWorkers(runId).filter((w) => w.status === "running");
  for (const worker of runningWorkers) {
    upsertDynamicWorkflowWorker({
      ...worker,
      status: "cancelled",
      completedAt: now(),
      updatedAt: now(),
    });
  }

  const queuedWorkers = getDynamicWorkflowWorkers(runId).filter((w) => w.status === "queued");
  for (const worker of queuedWorkers) {
    upsertDynamicWorkflowWorker({
      ...worker,
      status: "cancelled",
      completedAt: now(),
      updatedAt: now(),
    });
  }

  emitEvent(runId, "run.paused", {
    title: `Run "${run.name}" paused`,
    detail: `${runningWorkers.length + queuedWorkers.length} workers stopped.`,
  });
}

export function cancelRun(runId: string): void {
  const run = getDynamicWorkflowRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    throw new Error(`Cannot cancel run with terminal status "${run.status}".`);
  }

  const controller = runningRuns.get(runId);
  if (controller) {
    controller.abort();
    runningRuns.delete(runId);
  }

  upsertDynamicWorkflowRun({
    ...run,
    status: "cancelled",
    completedAt: now(),
    updatedAt: now(),
  });

  const pendingPhases = getDynamicWorkflowPhases(runId).filter(
    (p) => p.status === "pending" || p.status === "running" || p.status === "paused",
  );
  for (const phase of pendingPhases) {
    upsertDynamicWorkflowPhase({
      ...phase,
      status: phase.status === "running" ? "failed" : "skipped",
      completedAt: now(),
      updatedAt: now(),
    });
  }

  const pendingWorkers = getDynamicWorkflowWorkers(runId).filter(
    (w) => w.status === "queued" || w.status === "running",
  );
  for (const worker of pendingWorkers) {
    upsertDynamicWorkflowWorker({
      ...worker,
      status: "cancelled",
      completedAt: now(),
      updatedAt: now(),
    });
  }

  emitEvent(runId, "run.cancelled", {
    title: `Run "${run.name}" cancelled`,
    detail: `${pendingWorkers.length} workers cancelled.`,
  });
}

export async function restartWorker(runId: string, workerId: string): Promise<void> {
  const run = getDynamicWorkflowRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const worker = getDynamicWorkflowWorker(workerId);
  if (!worker) throw new Error(`Worker ${workerId} not found`);

  invalidateWorkerCache(runId, workerId);

  upsertDynamicWorkflowWorker({
    ...worker,
    status: "queued",
    resultSummary: null,
    resultJson: null,
    error: null,
    startedAt: null,
    completedAt: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    updatedAt: now(),
  });

  emitEvent(runId, "worker.restarted", {
    phaseId: worker.phaseId,
    workerId,
    title: `Worker "${worker.role}" restarted`,
  });

  void executeRun(runId).catch((err) => {
    log.error("Background restart-worker execution failed", { runId, workerId, error: String(err) });
  });
}

export async function restartPhase(runId: string, phaseId: string): Promise<void> {
  const run = getDynamicWorkflowRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  invalidatePhaseCache(runId, phaseId);

  const workers = getDynamicWorkflowWorkers(runId, phaseId);
  for (const worker of workers) {
    invalidateWorkerCache(runId, worker.id);
    upsertDynamicWorkflowWorker({
      ...worker,
      status: "queued",
      resultSummary: null,
      resultJson: null,
      error: null,
      startedAt: null,
      completedAt: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      updatedAt: now(),
    });
  }

  const phase = getDynamicWorkflowPhases(runId).find((p) => p.id === phaseId);
  if (phase) {
    upsertDynamicWorkflowPhase({
      ...phase,
      status: "pending",
      startedAt: null,
      completedAt: null,
      updatedAt: now(),
    });
  }

  emitEvent(runId, "phase.restarted", {
    phaseId,
    title: `Phase "${phase?.name || phaseId}" restarted`,
    detail: `${workers.length} workers reset.`,
  });

  void executeRun(runId).catch((err) => {
    log.error("Background restart-phase execution failed", { runId, phaseId, error: String(err) });
  });
}

export function getRunProgress(runId: string): {
  totalPhases: number;
  completedPhases: number;
  totalWorkers: number;
  completedWorkers: number;
  failedWorkers: number;
  estimatedProgress: number;
  elapsedMs: number;
} {
  const run = getDynamicWorkflowRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const phases = getDynamicWorkflowPhases(runId);
  const workers = getDynamicWorkflowWorkers(runId);

  const totalPhases = phases.length;
  const completedPhases = phases.filter((p) => p.status === "completed" || p.status === "failed").length;
  const totalWorkers = workers.length;
  const completedWorkers = workers.filter(
    (w) => w.status === "completed" || w.status === "failed" || w.status === "timed_out" || w.status === "cancelled",
  ).length;
  const failedWorkers = workers.filter(
    (w) => w.status === "failed" || w.status === "timed_out",
  ).length;

  const phaseWeight = totalPhases > 0 ? completedPhases / totalPhases : 0;
  const workerWeight = totalWorkers > 0 ? completedWorkers / totalWorkers : 0;
  const estimatedProgress = Math.round((phaseWeight * 0.4 + workerWeight * 0.6) * 100);

  const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : new Date(run.createdAt).getTime();
  const elapsedMs = Date.now() - startedAt;

  return {
    totalPhases,
    completedPhases,
    totalWorkers,
    completedWorkers,
    failedWorkers,
    estimatedProgress,
    elapsedMs,
  };
}

export async function applyVerification(
  runId: string,
  plan: DynamicWorkflowPlan,
): Promise<{ passed: boolean; results: string[] }> {
  const run = getDynamicWorkflowRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const verification = plan.verification;

  emitEvent(runId, "run.verification_started", {
    title: "Verification started",
    detail: `${(verification?.commands?.length || 0) + (verification?.browserChecks?.length || 0)} checks to run.`,
  });
  const verificationResult = await executeVerification({
    run,
    plan,
    signal: runningRuns.get(runId)?.signal,
  });
  const results = verificationResult.results.map(
    (result) => `${result.passed ? "PASS" : result.unavailable ? "UNVERIFIED" : "FAIL"} ${result.label} (${result.durationMs}ms): ${result.detail}`,
  );
  if (results.length === 0) results.push("No executable verification checks were configured.");
  const passed = verificationResult.passed;

  emitEvent(runId, "run.verification_completed", {
    title: `Verification ${passed ? "passed" : "failed"}`,
    detail: results.join("\n").slice(0, 2000),
  });

  return { passed, results };
}

export { runningRuns, executeRun };
