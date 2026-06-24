/**
 * The single executor-level guard. Every side-effect-capable node passes
 * through `checkNodeEffectPolicy` immediately before its handler runs — normal
 * nodes, loop bodies, retries, partial runs, sub-workflows, and dynamic
 * workers. No raw `handler.execute(...)` may remain on a path that can cause a
 * side effect.
 */
import type { ApprovalPolicy } from "@/types/execution";
import { logger } from "@/lib/utils/logger";
import { redactSecretsDeep } from "@/lib/workflows/secret-redaction";
import {
  criticalNeverAllow,
  isMaterialEffect,
  resolveNodeEffect,
  type EffectDescriptor,
} from "./effects";
import { decideEffectPolicy, type EffectDecision } from "./effect-policy";
import {
  awaitApprovalDecision,
  claimApprovedGrant,
  computeApprovalDigest,
  computeInputHash,
  createApprovalRequest,
  findApprovedGrantByDigest,
  findPendingByDigest,
  markApprovalExecuted,
  markApprovalIndeterminate,
  type ApprovalRecord,
} from "./workflow-approvals";

const log = logger.child("workflow:guard");

export class NodeEffectBlockedError extends Error {
  readonly effect: EffectDescriptor;
  readonly blockKind: GuardBlockKind;
  constructor(message: string, effect: EffectDescriptor, blockKind: GuardBlockKind) {
    super(message);
    this.name = "NodeEffectBlockedError";
    this.effect = effect;
    this.blockKind = blockKind;
  }
}

export class NodeEffectExecutionIndeterminateError extends Error {
  readonly effect: EffectDescriptor;
  constructor(message: string, effect: EffectDescriptor, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NodeEffectExecutionIndeterminateError";
    this.effect = effect;
  }
}

export type GuardBlockKind = "hardline" | "denied" | "awaiting" | "expired" | "cancelled";

export interface GuardContext {
  workflowId: string;
  workflowVersionHash: string;
  executionId: string;
  /** An interactive operator surface is available (manual runs). */
  attended: boolean;
  /** Resolved approval policy, or null for legacy workflows (compat floor only). */
  approvalPolicy: ApprovalPolicy | null;
  /** Max time an attended run waits for an approval decision. */
  approvalWaitMs: number;
  approvalTtlMs?: number;
  abortSignal?: AbortSignal;
  onEmit?: (event: string, data: unknown) => void;
}

export interface NodeEffectTrace {
  nodeId: string;
  nodeType: string;
  effect: EffectDescriptor;
  decision: EffectDecision | "hardline";
  approvalId?: string;
  reason: string;
}

export interface GuardOutcome {
  allowed: boolean;
  effect: EffectDescriptor;
  decision: EffectDecision | "hardline";
  reason: string;
  /** Set when an approval grant authorized this run; mark executed after the handler completes. */
  approvalId?: string;
  blockKind?: GuardBlockKind;
}

/** Normalize the effect-relevant config so logically equal payloads share a hash. */
function normalizeEffectConfig(config: Record<string, unknown>): Record<string, unknown> {
  const nested = config.config && typeof config.config === "object" && !Array.isArray(config.config)
    ? (config.config as Record<string, unknown>)
    : {};
  const merged: Record<string, unknown> = { ...nested, ...config };
  delete merged.config;
  delete merged.label;
  delete merged.retryCount;
  delete merged.retryDelayMs;
  delete merged.continueOnFail;
  delete merged.disabled;
  return merged;
}

/**
 * Bind approval grants to both persisted node configuration and the runtime
 * payload produced by upstream nodes. The payload is hashed only; it is never
 * persisted in the approval record.
 */
export function computeNodeEffectInputHash(
  effect: EffectDescriptor,
  config: Record<string, unknown>,
  input?: Record<string, unknown>,
): string {
  return computeInputHash(effect, {
    config: normalizeEffectConfig(config),
    input: input ?? {},
  });
}

function buildApprovalPreview(
  config: Record<string, unknown>,
  input?: Record<string, unknown>,
): string {
  const redacted = redactSecretsDeep({
    configuration: normalizeEffectConfig(config),
    runtimeInput: input ?? {},
  });
  const text = JSON.stringify(redacted, null, 2);
  return text.length <= 4000 ? text : `${text.slice(0, 4000)}\n... preview truncated`;
}

/**
 * Compat decision for legacy workflows (no approval policy set). Preserves
 * existing behaviour but still enforces the new floors: hardline always blocks,
 * unknown fails closed, and unattended destructive/critical actions are denied.
 */
function decideCompat(effect: EffectDescriptor, attended: boolean): { decision: EffectDecision; reason: string; requiresHuman: boolean } {
  if (effect.kind === "none" || effect.kind === "read") {
    return { decision: "allow", reason: "Read-only step runs automatically.", requiresHuman: false };
  }
  if (effect.kind === "unknown") {
    return { decision: "deny", reason: "Unknown side effect is blocked (fails closed).", requiresHuman: true };
  }
  if (!attended && (effect.kind === "destructive" || effect.kind === "credential_change" || effect.kind === "financial" || effect.risk === "critical")) {
    return { decision: "deny", reason: "Legacy workflow cannot run an unattended destructive or critical action.", requiresHuman: true };
  }
  return { decision: "allow", reason: "Legacy workflow without an approval policy runs this action automatically.", requiresHuman: false };
}

export async function checkNodeEffectPolicy(params: {
  nodeId: string;
  nodeType: string;
  config: Record<string, unknown>;
  input?: Record<string, unknown>;
  attempt: number;
  ctx: GuardContext;
}): Promise<GuardOutcome> {
  const { nodeId, nodeType, config, input, attempt, ctx } = params;
  const resolvedEffect = resolveNodeEffect(nodeType, config, input);
  const effect = isMaterialEffect(resolvedEffect)
    ? {
        ...resolvedEffect,
        details: {
          ...resolvedEffect.details,
          approvalPreview: buildApprovalPreview(config, input),
        },
      }
    : resolvedEffect;

  const emit = (decision: GuardOutcome["decision"], outcome: GuardOutcome) => {
    ctx.onEmit?.("workflow:node:effect", {
      workflowId: ctx.workflowId,
      executionId: ctx.executionId,
      nodeId,
      nodeType,
      effect,
      decision,
      allowed: outcome.allowed,
      reason: outcome.reason,
      approvalId: outcome.approvalId ?? null,
    });
  };

  // 1. Hardline floor — cannot be bypassed by any approval mode.
  const hardline = criticalNeverAllow(nodeType, config, effect);
  if (hardline.blocked) {
    const outcome: GuardOutcome = {
      allowed: false,
      effect,
      decision: "hardline",
      reason: `Blocked by the safety floor: ${hardline.reason}. This cannot be approved.`,
      blockKind: "hardline",
    };
    emit("hardline", outcome);
    log.warn("guard.hardline", { nodeId, nodeType, reason: hardline.reason });
    return outcome;
  }

  // Non-material effects never need approval.
  if (!isMaterialEffect(effect)) {
    const outcome: GuardOutcome = { allowed: true, effect, decision: "allow", reason: effect.summary || "Read-only step." };
    return outcome;
  }

  // 2. Policy decision (or compat floor for legacy workflows).
  const inputHash = computeNodeEffectInputHash(effect, config, input);
  const runDigest = computeApprovalDigest({
    workflowId: ctx.workflowId,
    workflowVersionHash: ctx.workflowVersionHash,
    scope: ctx.executionId,
    nodeId,
    effect,
    inputHash,
  });
  const preauthDigest = computeApprovalDigest({
    workflowId: ctx.workflowId,
    workflowVersionHash: ctx.workflowVersionHash,
    scope: "preauth",
    nodeId,
    effect,
    inputHash,
  });
  const preAuthorized = Boolean(findApprovedGrantByDigest(preauthDigest));

  const decisionResult = ctx.approvalPolicy
    ? decideEffectPolicy({ effect, policy: ctx.approvalPolicy, nodeId, attended: ctx.attended, preAuthorized })
    : { ...decideCompat(effect, ctx.attended), ...(preAuthorized ? { decision: "allow" as EffectDecision, reason: "A bound pre-authorization matches this exact action." } : {}) };

  if (decisionResult.decision === "allow") {
    const outcome: GuardOutcome = { allowed: true, effect, decision: "allow", reason: decisionResult.reason };
    emit("allow", outcome);
    return outcome;
  }

  if (decisionResult.decision === "deny") {
    const outcome: GuardOutcome = { allowed: false, effect, decision: "deny", reason: decisionResult.reason, blockKind: "denied" };
    emit("deny", outcome);
    return outcome;
  }

  // 3. decision === "approve": find or create a hash-bound grant.
  // Already-approved grant for this exact run digest? Claim it atomically.
  const existingApproved = findApprovedGrantByDigest(runDigest);
  if (existingApproved) {
    const claimed = claimApprovedGrant(existingApproved.id, runDigest);
    if (claimed) {
      const outcome: GuardOutcome = { allowed: true, effect, decision: "approve", reason: "Approved.", approvalId: claimed.id };
      emit("approve", outcome);
      return outcome;
    }
    // Lost the race — another worker already claimed this exact effect.
    const outcome: GuardOutcome = { allowed: false, effect, decision: "approve", reason: "This action was already claimed by another run.", blockKind: "denied" };
    emit("approve", outcome);
    return outcome;
  }

  // Create (or reuse) a pending request.
  const pending: ApprovalRecord =
    findPendingByDigest(runDigest) ??
    createApprovalRequest({
      workflowId: ctx.workflowId,
      workflowVersionHash: ctx.workflowVersionHash,
      executionId: ctx.executionId,
      nodeId,
      attempt,
      effect,
      inputHash,
      digest: runDigest,
      requiresHuman: decisionResult.requiresHuman,
      ttlMs: ctx.approvalTtlMs,
    });

  // Unattended: do not block-wait. The request is recorded for an operator and
  // expires cleanly; the node cannot proceed now.
  if (!ctx.attended) {
    const outcome: GuardOutcome = {
      allowed: false,
      effect,
      decision: "approve",
      reason: "Paused for approval. No operator is attached to an unattended run; the request will expire.",
      approvalId: pending.id,
      blockKind: "awaiting",
    };
    emit("approve", outcome);
    return outcome;
  }

  // Attended: wait for a decision.
  emit("approve", { allowed: false, effect, decision: "approve", reason: "Awaiting approval.", approvalId: pending.id, blockKind: "awaiting" });
  const decided = await awaitApprovalDecision(pending.id, {
    timeoutMs: ctx.approvalWaitMs,
    signal: ctx.abortSignal,
  });

  if (decided.status === "approved") {
    const claimed = claimApprovedGrant(decided.id, runDigest);
    if (claimed) {
      return { allowed: true, effect, decision: "approve", reason: "Approved.", approvalId: claimed.id };
    }
    return { allowed: false, effect, decision: "approve", reason: "Approval could not be claimed (digest changed or already used).", blockKind: "denied" };
  }
  if (decided.status === "expired") {
    return { allowed: false, effect, decision: "approve", reason: "Approval request expired before a decision.", approvalId: decided.id, blockKind: "expired" };
  }
  return { allowed: false, effect, decision: "approve", reason: decided.decisionNote || "Approval denied.", approvalId: decided.id, blockKind: "denied" };
}

/** Mark a grant executed after the handler completes successfully. */
export function completeGuardedExecution(approvalId: string | undefined, resultRef?: string | null): void {
  if (!approvalId) return;
  try {
    markApprovalExecuted(approvalId, resultRef);
  } catch (error) {
    log.warn("guard.markExecuted.failed", { approvalId, error: String(error) });
  }
}

export function failGuardedExecution(approvalId: string | undefined, reason: string): void {
  if (!approvalId) return;
  try {
    markApprovalIndeterminate(approvalId, reason);
  } catch (error) {
    log.warn("guard.markIndeterminate.failed", { approvalId, error: String(error) });
  }
}

export function effectBadgeFor(effect: EffectDescriptor): { label: string; tone: "read" | "local" | "external" | "destructive" | "approval" } {
  switch (effect.kind) {
    case "none":
    case "read":
      return { label: "Read only", tone: "read" };
    case "local_write":
      return { label: "Writes locally", tone: "local" };
    case "external_write":
    case "external_send":
      return { label: "Sends externally", tone: "external" };
    case "destructive":
    case "credential_change":
    case "financial":
      return { label: "Destructive", tone: "destructive" };
    case "unknown":
    default:
      return { label: "Needs approval", tone: "approval" };
  }
}
