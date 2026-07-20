import { getEventsForRun, getPopulatedRun } from "./store";
import { listRepairAttempts, listRunCriteria, listRunEvidence } from "./criteria";
import type { DynamicWorkflowPlan } from "./types";
import { getWorkTrail } from "@/lib/work-trails/work-trails";
import { getLiveSession } from "@/lib/live-sessions/store";
import type { TranscriptAnalysis } from "@/lib/live-sessions/types";

const SECRET_PATTERN = /(sk-[a-z0-9_-]{16,}|(?:api[_-]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;}]+)/gi;

function sanitizeText(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  return value.replace(SECRET_PATTERN, "[REDACTED]");
}

const SECRET_KEY = /(?:api[_-]?key|authorization|token|secret|password|credential|private[_-]?key)/i;
const RAW_HTML = /<(?:!doctype\s+html|html|script)(?:\s|>)/i;

function sanitizeUnknown(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return RAW_HTML.test(value) ? "[UNTRUSTED HTML OMITTED]" : sanitizeText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, sanitizeUnknown(child, childKey)]));
  }
  return value;
}

function safeJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return sanitizeUnknown(JSON.parse(value));
  } catch {
    return sanitizeText(value);
  }
}

const CITATION_PATTERN = /\[\d{2}:\d{2}-\d{2}:\d{2}\]/g;

function citations(value: string): string[] {
  return [...new Set(value.match(CITATION_PATTERN) ?? [])];
}

function persistedAnalysis(value: unknown): TranscriptAnalysis | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.summary !== "string") return null;
  const strings = (item: unknown) => Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : [];
  const actions = Array.isArray(input.actionItems) ? input.actionItems.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const action = item as Record<string, unknown>;
    if (typeof action.action !== "string") return [];
    return [{
      action: action.action,
      owner: typeof action.owner === "string" ? action.owner : null,
      deadline: typeof action.deadline === "string" ? action.deadline : null,
      citations: strings(action.citations),
    }];
  }) : [];
  return {
    summary: input.summary,
    decisions: strings(input.decisions),
    actionItems: actions,
    risks: strings(input.risks),
    openQuestions: strings(input.openQuestions),
    ...(typeof input.answer === "string" ? { answer: input.answer } : {}),
  };
}

function liveSessionSource(plan: DynamicWorkflowPlan, sourceRef: string | null) {
  const ref = (plan.sourceRefs ?? []).find((item) => {
    const type = String(item.type || "").toLowerCase();
    return (type === "live-session" || type === "live_session") && item.id;
  });
  const id = String(ref?.id || (sourceRef?.startsWith("live_") ? sourceRef : "")).trim();
  if (!id) return null;
  const session = getLiveSession(id);
  if (!session) return null;
  const analysis = persistedAnalysis(session.metadata.transcriptAnalysis);
  const sourceRequirements = analysis ? [
    ...analysis.decisions.map((statement, index) => ({
      id: `decision-${index + 1}`,
      kind: "decision" as const,
      statement: sanitizeText(statement),
      owner: null,
      deadline: null,
      citations: citations(statement),
    })),
    ...analysis.actionItems.map((item, index) => ({
      id: `action-${index + 1}`,
      kind: "action" as const,
      statement: sanitizeText(item.action),
      owner: sanitizeText(item.owner),
      deadline: sanitizeText(item.deadline),
      citations: [...new Set([...item.citations, ...citations(item.action)])],
    })),
  ] : [];
  const durationMs = Math.max(
    0,
    ...session.segments.map((segment) => segment.endMs),
    session.endedAt ? new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime() : 0,
  );
  return {
    id: session.id,
    title: sanitizeText(session.title),
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs,
    summary: sanitizeText(analysis?.summary),
    requirements: sourceRequirements,
    risks: analysis?.risks.map((item) => ({ statement: sanitizeText(item), citations: citations(item) })) ?? [],
    openQuestions: analysis?.openQuestions.map((item) => ({ statement: sanitizeText(item), citations: citations(item) })) ?? [],
  };
}

export function buildDynamicWorkflowReceipt(runId: string) {
  const run = getPopulatedRun(runId);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const plan = JSON.parse(run.planJson) as DynamicWorkflowPlan;
  const criteria = listRunCriteria(runId);
  const evidence = listRunEvidence(runId);
  const repairs = listRepairAttempts(runId);
  const events = getEventsForRun(runId, 1000);
  const trail = run.workTrailId ? getWorkTrail(run.workTrailId) : null;
  const parsedResults = run.workers.map((worker) => safeJson(worker.resultJson) as Record<string, unknown> | null);
  const changedFiles = [...new Set(parsedResults.flatMap((result) => Array.isArray(result?.changedFiles) ? result.changedFiles.map(String) : []))];
  const artifacts = parsedResults.flatMap((result) => Array.isArray(result?.artifacts) ? result.artifacts.map((item) => sanitizeUnknown(item)) : []);
  const screenshots = [...new Set(parsedResults.flatMap((result) => Array.isArray(result?.screenshots) ? result.screenshots.map(String) : []))];
  const workerRoleCosts = Object.values(run.workers.reduce<Record<string, { role: string; inputTokens: number; outputTokens: number; costUsd: number }>>((acc, worker) => {
    const role = worker.role || "worker";
    const item = acc[role] || { role, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    item.inputTokens += worker.inputTokens || 0;
    item.outputTokens += worker.outputTokens || 0;
    item.costUsd += worker.costUsd || 0;
    acc[role] = item;
    return acc;
  }, {}));
  const roleCosts = plan.planning ? [{
    role: "contract-planner",
    inputTokens: plan.planning.inputTokens,
    outputTokens: plan.planning.outputTokens,
    costUsd: plan.planning.costUsd,
  }, ...workerRoleCosts] : workerRoleCosts;
  const sourceSession = liveSessionSource(plan, run.sourceRef);
  const contractItems = criteria.map((criterion) => ({
    id: criterion.id,
    statement: sanitizeText(criterion.statement),
    required: criterion.required,
    status: criterion.status,
    methods: criterion.methods,
    evidence: evidence.filter((item) => item.criterionId === criterion.id).map((item) => ({
      id: item.id,
      type: item.evidenceType,
      summary: sanitizeText(item.summary),
    })),
  }));
  const requiredCriteria = contractItems.filter((criterion) => criterion.required);
  const deliveryTeam = run.workers.map((worker) => ({
    role: worker.role,
    agentId: worker.agentId,
    agentKind: worker.agentKind,
    modelRef: worker.modelRef,
    status: worker.status,
  }));
  const deployments = trail?.events.filter((event) => event.surface === "deployments").map((event) => ({ id: event.objectId, eventType: event.eventType, summary: sanitizeText(event.summary) })) ?? [];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    run: {
      id: run.id,
      name: run.name,
      description: sanitizeText(run.description),
      status: run.status,
      sourceType: run.sourceType,
      sourceRef: sanitizeText(run.sourceRef),
      workTrailId: run.workTrailId ?? null,
      objective: sanitizeText(plan.objective),
      sourceRefs: plan.sourceRefs ?? [],
      workspaceRoot: plan.workspaceRoot ? "[confirmed local root]" : null,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      estimatedCostUsd: run.estimatedCostUsd,
      actualCostUsd: run.actualCostUsd,
    },
    supervision: plan.supervision ? {
      mode: plan.supervision.mode,
      planner: sanitizeUnknown(plan.supervision.planner),
      implementer: sanitizeUnknown(plan.supervision.implementer),
      reviewer: sanitizeUnknown(plan.supervision.reviewer),
      maxRepairPasses: plan.supervision.maxRepairPasses,
      requireHumanApprovalBeforePublish: plan.supervision.requireHumanApprovalBeforePublish,
    } : null,
    planning: plan.planning ? sanitizeUnknown(plan.planning) : null,
    approvals: events.filter((event) => event.eventType.includes("approval")).map((event) => ({
      eventType: event.eventType,
      title: sanitizeText(event.title),
      createdAt: event.createdAt,
    })),
    outputs: { changedFiles, artifacts, screenshots },
    usage: {
      inputTokens: roleCosts.reduce((sum, item) => sum + item.inputTokens, 0),
      outputTokens: roleCosts.reduce((sum, item) => sum + item.outputTokens, 0),
      costUsd: roleCosts.reduce((sum, item) => sum + item.costUsd, 0),
      perRole: roleCosts,
    },
    outcome: sourceSession ? {
      schemaVersion: 1,
      kind: "meeting-to-result" as const,
      status: run.status === "completed" && requiredCriteria.every((criterion) => criterion.status === "passed") ? "verified" : run.status,
      sourceSession,
      contract: {
        requiredPassed: requiredCriteria.filter((criterion) => criterion.status === "passed").length,
        requiredTotal: requiredCriteria.length,
        evidenceCount: evidence.length,
        items: contractItems,
      },
      deliveryTeam,
      result: {
        summary: sanitizeText([...run.workers].reverse().find((worker) => worker.resultSummary)?.resultSummary),
        changedFiles,
        artifacts,
        screenshots,
        deployments,
        repairPasses: repairs.length,
      },
    } : null,
    linkedDecisions: trail?.events.filter((event) => event.surface === "council").map((event) => ({ id: event.objectId, summary: sanitizeText(event.summary) })) ?? [],
    deployments,
    workers: run.workers.map((worker) => ({
      id: worker.id,
      phaseId: worker.phaseId,
      role: worker.role,
      status: worker.status,
      agentKind: worker.agentKind,
      agentId: worker.agentId,
      modelRef: worker.modelRef,
      summary: sanitizeText(worker.resultSummary),
      result: safeJson(worker.resultJson),
      inputTokens: worker.inputTokens,
      outputTokens: worker.outputTokens,
      costUsd: worker.costUsd,
    })),
    criteria,
    evidence: evidence.map((item) => ({
      ...item,
      summary: sanitizeText(item.summary),
      payload: safeJson(item.payloadJson),
      payloadJson: undefined,
    })),
    repairs,
    events: events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      phaseId: event.phaseId,
      workerId: event.workerId,
      title: sanitizeText(event.title),
      detail: sanitizeText(event.detail),
      createdAt: event.createdAt,
    })),
  };
}

export function receiptToMarkdown(receipt: ReturnType<typeof buildDynamicWorkflowReceipt>): string {
  const lines = [
    `# Result Receipt: ${receipt.run.name}`,
    "",
    `- Run: \`${receipt.run.id}\``,
    `- Status: **${receipt.run.status}**`,
    `- Started: ${receipt.run.startedAt || "not started"}`,
    `- Completed: ${receipt.run.completedAt || "not completed"}`,
    `- Actual cost: $${(receipt.run.actualCostUsd || 0).toFixed(6)}`,
    "",
    "## Objective",
    "",
    receipt.run.objective || "No objective recorded.",
    "",
    ...(receipt.outcome ? [
      "## Source Brief",
      "",
      `- Live session: ${receipt.outcome.sourceSession.title} (\`${receipt.outcome.sourceSession.id}\`)`,
      `- Source duration: ${Math.round(receipt.outcome.sourceSession.durationMs / 1000)} seconds`,
      `- Verified requirements: ${receipt.outcome.contract.requiredPassed}/${receipt.outcome.contract.requiredTotal}`,
      "",
      receipt.outcome.sourceSession.summary || "No persisted source summary.",
      "",
      ...receipt.outcome.sourceSession.requirements.map((item) => `- ${item.kind}: ${item.statement}${item.owner ? ` Owner: ${item.owner}.` : ""} ${item.citations.join(" ")}`),
      "",
    ] : []),
    "## Acceptance",
    "",
    ...receipt.criteria.map((criterion) => `- [${criterion.status === "passed" ? "x" : " "}] ${criterion.id}: ${criterion.statement} (${criterion.status})`),
    "",
    "## Workers",
    "",
    ...receipt.workers.map((worker) => `- ${worker.role}: ${worker.status} via ${worker.agentKind}/${worker.modelRef || "default model"}; ${worker.summary || "no summary"}`),
    "",
    "## Evidence",
    "",
    ...receipt.evidence.map((item) => `- ${item.criterionId || "run"} / ${item.evidenceType}: ${item.summary}`),
    "",
    "## Repair History",
    "",
    ...(receipt.repairs.length > 0
      ? receipt.repairs.map((repair) => `- Pass ${repair.attemptNumber}: ${repair.status}; criteria ${repair.failedCriterionIds.join(", ")}`)
      : ["No repairs were recorded."]),
    "",
    ...(receipt.outcome?.result.deployments.length ? [
      "## Public Result",
      "",
      ...receipt.outcome.result.deployments.map((deployment) => `- ${deployment.eventType}: ${deployment.summary || deployment.id}`),
      "",
    ] : []),
  ];
  return lines.join("\n");
}
