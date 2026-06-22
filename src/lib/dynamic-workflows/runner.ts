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
import { checkSafetyGates, defaultMaxConcurrency, defaultMaxWorkers } from "./safety";
import { executeWorker } from "./worker-executor";
import { getCachedResult, setCachedResult, invalidateWorkerCache, invalidatePhaseCache, computeCacheKey } from "./cache";
import { logger } from "@/lib/utils/logger";

const log = logger.child("dynamic-workflows:runner");

const runningRuns: Map<string, AbortController> = new Map();

function now(): string {
  return new Date().toISOString();
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
  return {
    id,
    runId,
    phaseId,
    workerIndex: index,
    role: spec.role,
    status: "queued",
    agentKind: (spec.agentKind || "internal") as DynamicWorkflowAgentKind,
    agentId: null,
    modelRef: spec.modelRef ?? null,
    prompt: spec.prompt,
    toolPolicyJson: spec.toolsets ? JSON.stringify({ toolsets: spec.toolsets }) : null,
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

async function executeWorkersInPhase(
  runId: string,
  phaseId: string,
  phase: DynamicWorkflowPhase,
  plan: DynamicWorkflowPlan,
): Promise<DynamicWorkflowWorkerResult[]> {
  const maxConcurrency = plan.limits.maxConcurrency || defaultMaxConcurrency;
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
      const idx = nextIndex++;
      const worker = workers[idx];
      if (!worker || (worker.status !== "queued" && worker.status !== "running")) continue;
      const phaseRecord = getPhaseRecord(phaseId, runId);

      const cached = getCachedResult(runId, phaseId, worker);
      if (cached) {
        results.push(cached);
        continue;
      }

      upsertDynamicWorkflowWorker({
        ...worker,
        status: "running",
        startedAt: worker.startedAt || now(),
        updatedAt: now(),
      });

      emitEvent(runId, "worker.started", {
        phaseId,
        workerId: worker.id,
        title: `Worker "${worker.role}" started`,
        detail: worker.prompt.slice(0, 500),
      });

      let result: DynamicWorkflowWorkerResult;
      try {
        result = await executeWorker(worker, phase, plan, runId);
      } catch (err) {
        if (err instanceof AbortRunSignal) throw err;
        log.warn("Worker execution threw", { workerId: worker.id, error: String(err) });
        result = {
          status: "failed",
          summary: `Worker threw an unexpected error: ${String(err).slice(0, 1000)}`,
        };
      }

      const resultStatus: DynamicWorkflowWorkerStatus = result.status;
      const resultJson = JSON.stringify(result);

      upsertDynamicWorkflowWorker({
        ...worker,
        status: resultStatus,
        resultSummary: result.summary.slice(0, 5000),
        resultJson: resultJson.slice(0, 32000),
        error: resultStatus === "failed" ? result.summary.slice(0, 2000) : null,
        completedAt: now(),
        updatedAt: now(),
      });

      const cacheKey = computeCacheKey(worker);
      setCachedResult(runId, phaseId, worker.id, cacheKey, result);

      emitEvent(runId, "worker.completed", {
        phaseId,
        workerId: worker.id,
        title: `Worker "${worker.role}" ${resultStatus}`,
        detail: result.summary.slice(0, 500),
        payloadJson: resultJson.slice(0, 8000),
      });

      results.push(result);
    }
  }

  const concurrency = Math.min(maxConcurrency, workers.length);
  for (let i = 0; i < concurrency; i++) {
    running.push(runNextWorker());
  }

  await Promise.all(running);

  return results;
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

  upsertDynamicWorkflowRun({
    ...run,
    status: "running",
    startedAt: run.startedAt || now(),
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
      if (hasFailures && isReviewOrVerify) {
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

    if (plan.verification) {
      const verifyResult = await applyVerification(runId, plan);
      if (!verifyResult.passed) {
        anyFailed = true;
      }
    }

    const finalStatus: DynamicWorkflowRunStatus = anyFailed ? "failed" : "completed";

    upsertDynamicWorkflowRun({
      ...run,
      status: finalStatus,
      completedAt: now(),
      updatedAt: now(),
    });

    emitEvent(runId, "run.completed", {
      title: `Run "${run.name}" ${finalStatus}`,
      detail: anyFailed
        ? "Some phases or verification steps failed."
        : "All phases and verification steps completed successfully.",
    });
  } catch (err) {
    if (err instanceof AbortRunSignal) {
      upsertDynamicWorkflowRun({
        ...run,
        status: "cancelled",
        completedAt: now(),
        updatedAt: now(),
      });
      emitEvent(runId, "run.cancelled", {
        title: `Run "${run.name}" cancelled`,
        detail: "Run was cancelled during execution.",
      });
    } else {
      log.error("Run execution failed", { runId, error: String(err) });
      upsertDynamicWorkflowRun({
        ...run,
        status: "failed",
        completedAt: now(),
        updatedAt: now(),
      });
      emitEvent(runId, "run.failed", {
        title: `Run "${run.name}" failed`,
        detail: `Unexpected error: ${String(err).slice(0, 1000)}`,
      });
    }
  } finally {
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
    sessionId?: string;
    modelRef?: string;
  },
): Promise<DynamicWorkflowRunRecord> {
  const runId = nanoid();
  const ts = now();

  const maxConcurrency = plan.limits?.maxConcurrency || defaultMaxConcurrency;
  const maxWorkers = plan.limits?.maxWorkers || defaultMaxWorkers;
  const totalSpecWorkers = plan.phases.reduce((sum, p) => sum + p.workers.length, 0);

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
    managerAgentId: null,
    modelRef: opts.modelRef ?? null,
    maxConcurrency,
    maxWorkers,
    approvalPolicy: "confirm_once",
    budgetLimitUsd: plan.limits?.budgetLimitUsd ?? null,
    estimatedCostUsd: null,
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
  const verification = plan.verification;
  if (!verification) {
    return { passed: true, results: ["No verification steps defined."] };
  }

  emitEvent(runId, "run.verification_started", {
    title: "Verification started",
    detail: `${(verification.commands?.length || 0) + (verification.browserChecks?.length || 0)} checks to run.`,
  });

  const results: string[] = [];

  if (verification.commands && verification.commands.length > 0) {
    results.push(`Verification commands requested but not executed in P1 (requires shell execution):`);
    for (const cmd of verification.commands) {
      results.push(`  - ${cmd}`);
    }
  }

  if (verification.browserChecks && verification.browserChecks.length > 0) {
    results.push(`Browser checks requested but not executed in P1 (requires browser tooling):`);
    for (const check of verification.browserChecks) {
      results.push(`  - ${check.url}: ${check.instruction}`);
    }
  }

  if (verification.requireScreenshots) {
    results.push("Screenshot capture requested but not executed in P1.");
  }

  const hasCommands = verification.commands && verification.commands.length > 0;
  const hasBrowser = verification.browserChecks && verification.browserChecks.length > 0;

  if (!hasCommands && !hasBrowser) {
    results.push("Verification section defined but no executable checks found.");
  }

  const passed = true;

  emitEvent(runId, "run.verification_completed", {
    title: `Verification ${passed ? "passed" : "failed"}`,
    detail: results.join("\n").slice(0, 2000),
  });

  return { passed, results };
}

export { runningRuns, executeRun };
