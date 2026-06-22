import type {
  DynamicWorkflowWorkerRecord,
  DynamicWorkflowPhase,
  DynamicWorkflowPlan,
  DynamicWorkflowAgentKind,
  DynamicWorkflowWorkerResult,
  DynamicWorkflowWorkerStatus,
} from "./types";
import { logger } from "@/lib/utils/logger";

const log = logger.child("dynamic-workflows:worker-executor");

export interface WorkerExecutionOptions {
  kind: DynamicWorkflowAgentKind;
  modelRef?: string;
  toolsets?: string[];
  timeoutMs?: number;
}

const DEFAULT_WORKER_TIMEOUT_MS = 120_000;

export function availableWorkerTypes(): DynamicWorkflowAgentKind[] {
  return ["internal"];
}

export function normalizeWorkerOutput(raw: unknown): DynamicWorkflowWorkerResult {
  if (!raw || typeof raw !== "object") {
    return {
      status: "failed",
      summary: typeof raw === "string" ? raw.slice(0, 2000) : "Worker produced no structured output.",
    };
  }

  const obj = raw as Record<string, unknown>;

  const status: DynamicWorkflowWorkerStatus = (() => {
    const s = String(obj.status || "").toLowerCase();
    if (["completed", "failed", "timed_out", "cancelled"].includes(s)) {
      return s as DynamicWorkflowWorkerStatus;
    }
    if (typeof obj.summary === "string" && obj.summary.length > 0) return "completed";
    if (typeof obj.error === "string" && obj.error.length > 0) return "failed";
    return "completed";
  })();

  const summary = typeof obj.summary === "string" ? obj.summary : String(obj.summary || "").slice(0, 5000);

  const findings = Array.isArray(obj.findings)
    ? obj.findings
        .filter(Boolean)
        .map((f: unknown) => {
          const item = f as Record<string, unknown>;
          return {
            claim: String(item.claim || ""),
            evidence: typeof item.evidence === "string" ? item.evidence : undefined,
            confidence: typeof item.confidence === "number" ? item.confidence : undefined,
          };
        })
    : undefined;

  const changedFiles: string[] | undefined = Array.isArray(obj.changedFiles)
    ? obj.changedFiles.map(String)
    : undefined;

  const artifacts = Array.isArray(obj.artifacts)
    ? obj.artifacts
        .filter(Boolean)
        .map((a: unknown) => {
          const item = a as Record<string, unknown>;
          return {
            type: String(item.type || "unknown"),
            path: typeof item.path === "string" ? item.path : undefined,
            url: typeof item.url === "string" ? item.url : undefined,
            label: typeof item.label === "string" ? item.label : undefined,
          };
        })
    : undefined;

  const screenshots: string[] | undefined = Array.isArray(obj.screenshots)
    ? obj.screenshots.map(String)
    : undefined;

  const nextActions: string[] | undefined = Array.isArray(obj.nextActions)
    ? obj.nextActions.map(String)
    : undefined;

  return {
    status,
    summary,
    findings: findings && findings.length > 0 ? findings : undefined,
    changedFiles: changedFiles && changedFiles.length > 0 ? changedFiles : undefined,
    artifacts: artifacts && artifacts.length > 0 ? artifacts : undefined,
    screenshots: screenshots && screenshots.length > 0 ? screenshots : undefined,
    nextActions: nextActions && nextActions.length > 0 ? nextActions : undefined,
    raw,
  };
}

async function executeInternalWorker(
  worker: DynamicWorkflowWorkerRecord,
  phase: DynamicWorkflowPhase,
  _plan: DynamicWorkflowPlan,
  _runId: string,
): Promise<DynamicWorkflowWorkerResult> {
  const prompt = worker.prompt;
  const role = worker.role || "worker";

  const summary = [
    `Internal worker "${role}" executed phase "${phase.name}".`,
    "",
    `Instruction: ${phase.instructions.slice(0, 500)}`,
    "",
    `Worker prompt: ${prompt.slice(0, 1000)}`,
    "",
    `Placeholder response: The worker would execute the above prompt using the app model tool loop.`,
    `Connect to the full model execution path during WebChat integration (P2).`,
    `For now, this placeholder simulates a completed worker run with the given prompt context.`,
  ].join("\n");

  log.info("Placeholder internal worker executed", {
    workerId: worker.id,
    phaseId: phase.id,
    role,
    promptLength: prompt.length,
  });

  return {
    status: "completed",
    summary,
    findings: [
      {
        claim: `Worker "${role}" processed the prompt for phase "${phase.name}".`,
        evidence: "Placeholder execution — model loop not yet wired.",
        confidence: 0.5,
      },
    ],
    nextActions: ["Connect model tool loop during P2 WebChat integration."],
  };
}

export async function executeWorker(
  worker: DynamicWorkflowWorkerRecord,
  phase: DynamicWorkflowPhase,
  plan: DynamicWorkflowPlan,
  runId: string,
): Promise<DynamicWorkflowWorkerResult> {
  const kind = worker.agentKind || "internal";
  const timeoutMs = DEFAULT_WORKER_TIMEOUT_MS;

  log.info("Executing worker", {
    workerId: worker.id,
    phaseId: phase.id,
    runId,
    kind,
    role: worker.role,
  });

  if (kind === "internal") {
    return executeInternalWorker(worker, phase, plan, runId);
  }

  return {
    status: "failed",
    summary: `Worker kind "${kind}" is not yet available. Supported kinds: internal. Configure the required backend (Claude CLI, Codex CLI, or Gemini) to enable this worker type.`,
    findings: [
      {
        claim: `Backend "${kind}" is not configured or not available in P1.`,
        evidence: "Only internal workers are supported in this phase.",
        confidence: 1,
      },
    ],
    nextActions: [
      `To use ${kind} workers, configure the ${kind === "claude" ? "Claude Code" : kind === "codex" ? "OpenAI Codex" : "Gemini"} CLI and enable it in Settings.`,
    ],
  };
}
