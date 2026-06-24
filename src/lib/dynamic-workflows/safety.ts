import type {
  DynamicWorkflowPlan,
  DynamicWorkflowRunRecord,
  DynamicWorkflowWorkerRecord,
} from "./types";
import { matchesHardlinePattern } from "@/lib/engine/effects";

export const DEFAULT_SAFETY_LIMITS = {
  maxConcurrency: 4,
  maxWorkers: 25,
  maxDepth: 2,
  maxRuntimeSeconds: 900,
  budgetLimitUsd: 5.0,
} as const;

export const defaultMaxConcurrency = DEFAULT_SAFETY_LIMITS.maxConcurrency;
export const defaultMaxWorkers = DEFAULT_SAFETY_LIMITS.maxWorkers;

const GLOBAL_MAX_CONCURRENT_RUNS = 8;

let activeRunCount = 0;

export function registerRunStart(): void {
  activeRunCount++;
}

export function registerRunEnd(): void {
  if (activeRunCount > 0) activeRunCount--;
}

export function getActiveRunCount(): number {
  return activeRunCount;
}

export function resetRunCounter(): void {
  activeRunCount = 0;
}

// ---- DANGEROUS ACTION DETECTION ----

const DANGEROUS_SHELL_PATTERNS: RegExp[] = [
  /\brm\s+(?:-r[f]?\s+|--recursive\s+)?[~/.]/i,
  /\brm\s+-rf\b/i,
  /\brm\s+--no-preserve-root\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\./i,
  /\bformat\s+(?:c:|d:|e:|f:|g:|h:)/i,
  /\b(?:>|>>)\s*\/dev\/(?:sda|hda|nvme|mmcblk)/i,
  /\bchmod\s+(?:-R\s+)?777\b/i,
  /\bchown\s+-R?\s+(?:root|0):/i,
  /\beval\s+["']?\s*(?:\$|`|\$\(|\(\))/i,
  /\bcurl\b.+\|\s*(?:ba)?sh\b/i,
  /\bwget\b.+\|\s*(?:ba)?sh\b/i,
  /\bfork\s+bomb\b/i,
  /:\(\)\s*\{/i,
  /\bmv\s+.*\/etc\/(?:passwd|shadow|sudoers)/i,
  /\b(?:nc|netcat|ncat)\s+-[lL]/i,
];

const DANGEROUS_DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bdelete\s+all\b/i,
  /\bdrop\s+table\b/i,
  /\bdrop\s+database\b/i,
  /\btruncate\s+table\b/i,
  /\bpurge\s+(?:all|everything|the\s+database)\b/i,
  /\bwipe\s+(?:all|everything|the\s+(?:disk|drive|database))\b/i,
  /\bdestroy\s+(?:all|everything)\b/i,
  /\bremove\s+all\s+(?:files?|records?|entries?|data)\b/i,
  /\bdelete\s+every(?:thing|one)\b/i,
];

const DANGEROUS_DEPLOYMENT_PATTERNS: RegExp[] = [
  /\bdeploy\s+(?:to|in)\s+production\b/i,
  /\bdeploy\s+production\b/i,
  /\bpush\s+(?:to|in)\s+production\b/i,
  /\bpush\s+production\b/i,
  /\bforce\s+push\s+(?:to|in)\s+(?:main|master|production)\b/i,
  /\bgit\s+push\s+(?:--force|-f)\b/i,
  /\brelease\s+to\s+production\b/i,
  /\bship\s+to\s+production\b/i,
  /\bmerge\s+(?:into|to)\s+(?:main|master)\s+without\s+review\b/i,
];

const DANGEROUS_PRIVILEGE_PATTERNS: RegExp[] = [
  /\bsudo\b/i,
  /\bsu\s+(?:-|root)\b/i,
  /\bdoas\b/i,
  /\brunas\s+\/user:administrator\b/i,
  /\b(root|admin|administrator)\s+privileges?\b/i,
  /\bescalate\s+(?:to|privileges?)\b/i,
  /\bgrant\s+(?:all|admin|root)\s+(?:privileges?|access|permissions?)\b/i,
  /\bunrestrict(?:ed)?\s+access\b/i,
];

const ALL_DANGEROUS_PATTERNS: Array<{
  patterns: RegExp[];
  category: string;
}> = [
  { patterns: DANGEROUS_SHELL_PATTERNS, category: "dangerous_shell_command" },
  {
    patterns: DANGEROUS_DESTRUCTIVE_PATTERNS,
    category: "destructive_data_operation",
  },
  {
    patterns: DANGEROUS_DEPLOYMENT_PATTERNS,
    category: "unilateral_production_deployment",
  },
  {
    patterns: DANGEROUS_PRIVILEGE_PATTERNS,
    category: "privilege_escalation",
  },
];

export function detectDangerousAction(
  workerPrompt: string
): { dangerous: boolean; reason?: string } {
  const text = String(workerPrompt || "");

  for (const group of ALL_DANGEROUS_PATTERNS) {
    for (const pattern of group.patterns) {
      if (pattern.test(text)) {
        return {
          dangerous: true,
          reason: `Matches ${group.category} pattern: "${sourceOf(pattern, text)}"`,
        };
      }
    }
  }

  return { dangerous: false };
}

function sourceOf(pattern: RegExp, text: string): string {
  const match = pattern.exec(text);
  if (match && match[0]) return match[0].slice(0, 80);
  return pattern.source.slice(0, 80);
}

// ---- BUDGET GATES ----

export function checkBudgetGate(
  plan: DynamicWorkflowPlan,
  estimatedCost: number
): { passed: boolean; reason?: string } {
  if (!Number.isFinite(estimatedCost) || estimatedCost < 0) {
    return {
      passed: false,
      reason: "Estimated cost is not a valid positive number.",
    };
  }

  const budgetLimit =
    plan.limits.budgetLimitUsd ?? DEFAULT_SAFETY_LIMITS.budgetLimitUsd;

  if (estimatedCost > budgetLimit) {
    return {
      passed: false,
      reason: `Estimated cost $${estimatedCost.toFixed(4)} exceeds budget limit $${budgetLimit.toFixed(2)}.`,
    };
  }

  const totalWorkers = plan.phases.reduce(
    (sum, phase) => sum + phase.workers.length,
    0
  );

  if (totalWorkers > DEFAULT_SAFETY_LIMITS.maxWorkers) {
    return {
      passed: false,
      reason: `Plan has ${totalWorkers} workers, exceeding maxWorkers limit of ${DEFAULT_SAFETY_LIMITS.maxWorkers}.`,
    };
  }

  if (plan.limits.maxConcurrency > DEFAULT_SAFETY_LIMITS.maxConcurrency) {
    return {
      passed: false,
      reason: `Plan maxConcurrency ${plan.limits.maxConcurrency} exceeds limit of ${DEFAULT_SAFETY_LIMITS.maxConcurrency}.`,
    };
  }

  const depth = computePhaseDepth(plan);
  if (depth > DEFAULT_SAFETY_LIMITS.maxDepth) {
    return {
      passed: false,
      reason: `Plan phase dependency depth ${depth} exceeds maxDepth limit of ${DEFAULT_SAFETY_LIMITS.maxDepth}.`,
    };
  }

  if (plan.limits.maxRuntimeSeconds > DEFAULT_SAFETY_LIMITS.maxRuntimeSeconds) {
    return {
      passed: false,
      reason: `Plan maxRuntimeSeconds ${plan.limits.maxRuntimeSeconds} exceeds limit of ${DEFAULT_SAFETY_LIMITS.maxRuntimeSeconds}.`,
    };
  }

  return { passed: true };
}

function computePhaseDepth(plan: DynamicWorkflowPlan): number {
  const phaseMap = new Map<string, number>();

  function getDepth(phaseId: string, visited: Set<string>): number {
    if (phaseMap.has(phaseId)) return phaseMap.get(phaseId)!;
    if (visited.has(phaseId)) return 0;

    const phase = plan.phases.find((p) => p.id === phaseId);
    if (!phase) return 0;

    if (!phase.dependsOn || phase.dependsOn.length === 0) {
      phaseMap.set(phaseId, 1);
      return 1;
    }

    visited.add(phaseId);
    let maxDep = 0;
    for (const depId of phase.dependsOn) {
      const depDepth = getDepth(depId, new Set(visited));
      if (depDepth > maxDep) maxDep = depDepth;
    }

    const depth = maxDep + 1;
    phaseMap.set(phaseId, depth);
    return depth;
  }

  let maxDepth = 0;
  for (const phase of plan.phases) {
    const d = getDepth(phase.id, new Set());
    if (d > maxDepth) maxDepth = d;
  }

  return maxDepth;
}

// ---- CONCURRENCY GATE ----

export function checkConcurrencyGate(
  _runRecord: DynamicWorkflowRunRecord
): { passed: boolean; reason?: string } {
  if (activeRunCount >= GLOBAL_MAX_CONCURRENT_RUNS) {
    return {
      passed: false,
      reason: `Active run count (${activeRunCount}) already at global cap of ${GLOBAL_MAX_CONCURRENT_RUNS}.`,
    };
  }

  return { passed: true };
}

// ---- WORKER BUDGET ----

export function checkWorkerBudget(
  worker: DynamicWorkflowWorkerRecord,
  estimatedCost: number
): { passed: boolean; reason?: string } {
  if (!Number.isFinite(estimatedCost) || estimatedCost < 0) {
    return {
      passed: false,
      reason: "Estimated worker cost is not a valid positive number.",
    };
  }

  const MAX_WORKER_COST = 1.0;

  if (estimatedCost > MAX_WORKER_COST) {
    return {
      passed: false,
      reason: `Worker "${worker.id}" estimated cost $${estimatedCost.toFixed(4)} exceeds per-worker limit $${MAX_WORKER_COST.toFixed(2)}.`,
    };
  }

  if ((worker.prompt?.length ?? 0) > 50_000) {
    return {
      passed: false,
      reason: `Worker "${worker.id}" prompt length (${worker.prompt.length} chars) exceeds safety limit of 50000.`,
    };
  }

  return { passed: true };
}

// ---- APPROVAL POLICY ----

export function resolveApprovalPolicy(
  runRecord: DynamicWorkflowRunRecord
): "auto_run" | "confirm_once" | "confirm_per_phase" | "confirm_per_worker" {
  if (
    runRecord.approvalPolicy &&
    runRecord.approvalPolicy !== "auto" &&
    runRecord.approvalPolicy !== "auto_run"
  ) {
    return runRecord.approvalPolicy as
      | "confirm_once"
      | "confirm_per_phase"
      | "confirm_per_worker";
  }

  let plan: DynamicWorkflowPlan | null = null;
  try {
    plan = JSON.parse(runRecord.planJson) as DynamicWorkflowPlan;
  } catch {
    // Can't parse plan; default to confirm_once for safety
    return "confirm_once";
  }

  let hasDangerous = false;
  for (const phase of plan.phases) {
    for (const worker of phase.workers) {
      const result = detectDangerousAction(worker.prompt);
      if (result.dangerous) {
        hasDangerous = true;
        break;
      }
    }
    if (hasDangerous) break;
  }

  if (hasDangerous) {
    return "confirm_per_worker";
  }

  if (plan.phases.length > 1) {
    return "confirm_per_phase";
  }

  const totalWorkers = plan.phases.reduce(
    (sum, phase) => sum + phase.workers.length,
    0
  );

  if (totalWorkers > 3) {
    return "confirm_once";
  }

  return "auto_run";
}

// ---- COMBINED SAFETY CHECK (used by runner.ts) ----

export function checkSafetyGates(
  run: DynamicWorkflowRunRecord,
  plan: DynamicWorkflowPlan
): { passed: boolean; reason?: string } {
  const concurrencyCheck = checkConcurrencyGate(run);
  if (!concurrencyCheck.passed) return concurrencyCheck;

  // Shared hardline floor: a worker prompt that requests a catastrophic host
  // operation is blocked unconditionally, matching the workflow effect guard.
  for (const phase of plan.phases) {
    for (const worker of phase.workers) {
      const reason = matchesHardlinePattern(worker.prompt);
      if (reason) {
        return { passed: false, reason: `Blocked by the safety floor: ${reason}. This cannot be approved.` };
      }
    }
  }

  const totalWorkers = plan.phases.reduce(
    (sum, phase) => sum + phase.workers.length,
    0
  );

  if (totalWorkers > DEFAULT_SAFETY_LIMITS.maxWorkers) {
    return {
      passed: false,
      reason: `Plan has ${totalWorkers} workers, exceeding maxWorkers limit of ${DEFAULT_SAFETY_LIMITS.maxWorkers}.`,
    };
  }

  if (plan.limits.maxConcurrency > DEFAULT_SAFETY_LIMITS.maxConcurrency) {
    return {
      passed: false,
      reason: `Plan maxConcurrency ${plan.limits.maxConcurrency} exceeds limit of ${DEFAULT_SAFETY_LIMITS.maxConcurrency}.`,
    };
  }

  const depth = computePhaseDepth(plan);
  if (depth > DEFAULT_SAFETY_LIMITS.maxDepth) {
    return {
      passed: false,
      reason: `Plan phase dependency depth ${depth} exceeds maxDepth limit of ${DEFAULT_SAFETY_LIMITS.maxDepth}.`,
    };
  }

  if (plan.limits.maxRuntimeSeconds > DEFAULT_SAFETY_LIMITS.maxRuntimeSeconds) {
    return {
      passed: false,
      reason: `Plan maxRuntimeSeconds ${plan.limits.maxRuntimeSeconds} exceeds limit of ${DEFAULT_SAFETY_LIMITS.maxRuntimeSeconds}.`,
    };
  }

  const budgetLimit =
    plan.limits.budgetLimitUsd ?? DEFAULT_SAFETY_LIMITS.budgetLimitUsd;
  if (run.estimatedCostUsd != null && run.estimatedCostUsd > budgetLimit) {
    return {
      passed: false,
      reason: `Estimated cost $${run.estimatedCostUsd.toFixed(4)} exceeds budget limit $${budgetLimit.toFixed(2)}.`,
    };
  }

  for (const phase of plan.phases) {
    for (const worker of phase.workers) {
      const dangerCheck = detectDangerousAction(worker.prompt);
      if (dangerCheck.dangerous) {
        return {
          passed: false,
          reason: `Worker "${worker.id}" in phase "${phase.id}" contains dangerous action: ${dangerCheck.reason}`,
        };
      }
    }
  }

  return { passed: true };
}
