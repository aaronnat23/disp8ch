/**
 * Deterministic effect → decision policy. Pure and side-effect free so it can
 * be unit-tested exhaustively. The executor guard combines this with the
 * hardline floor and the durable approval store.
 */
import type { ApprovalPolicy, NodeApprovalChoice, WorkflowApprovalMode } from "@/types/execution";
import type { EffectDescriptor, EffectKind } from "./effects";

export type EffectDecision = "allow" | "approve" | "deny";

export interface EffectPolicyInput {
  effect: EffectDescriptor;
  policy: ApprovalPolicy;
  nodeId: string;
  /** An interactive operator surface is available to answer an approval. */
  attended: boolean;
  /** A saved, bound pre-authorization already matches this exact effect. */
  preAuthorized?: boolean;
}

export interface EffectPolicyResult {
  decision: EffectDecision;
  /** Human-readable reason shown in Activity / Approvals. */
  reason: string;
  /** True when the decision required a human (not eligible for model downgrade). */
  requiresHuman: boolean;
}

const IRREVERSIBLE_KINDS: EffectKind[] = ["external_send", "credential_change", "financial", "destructive", "unknown"];

function isIrreversible(effect: EffectDescriptor): boolean {
  return IRREVERSIBLE_KINDS.includes(effect.kind) || effect.reversible === false;
}

/** Balanced mode: reads auto, low local writes auto, external/irreversible approve, unknown deny. */
function decideBalanced(effect: EffectDescriptor): EffectPolicyResult {
  switch (effect.kind) {
    case "none":
    case "read":
      return { decision: "allow", reason: "Read-only step runs automatically.", requiresHuman: false };
    case "local_write":
      if (effect.risk === "low" || effect.risk === "medium") {
        return { decision: "allow", reason: "Low-risk reversible local write runs automatically.", requiresHuman: false };
      }
      return { decision: "approve", reason: "High-risk local write needs approval.", requiresHuman: true };
    case "external_write":
    case "external_send":
      return { decision: "approve", reason: "External action needs approval before it runs.", requiresHuman: true };
    case "credential_change":
    case "financial":
    case "destructive":
      return { decision: "approve", reason: "Irreversible action needs just-in-time human approval.", requiresHuman: true };
    case "unknown":
    default:
      return { decision: "deny", reason: "Unknown side effect is blocked (fails closed).", requiresHuman: true };
  }
}

/** Strict mode: every write or send requires human approval; unknown denied. */
function decideStrict(effect: EffectDescriptor): EffectPolicyResult {
  if (effect.kind === "none" || effect.kind === "read") {
    return { decision: "allow", reason: "Read-only step runs automatically.", requiresHuman: false };
  }
  if (effect.kind === "unknown") {
    return { decision: "deny", reason: "Unknown side effect is blocked (fails closed).", requiresHuman: true };
  }
  return { decision: "approve", reason: "Strict mode requires human approval for every write or send.", requiresHuman: true };
}

function decideCustom(effect: EffectDescriptor, choice: NodeApprovalChoice | undefined): EffectPolicyResult {
  // Unknown always fails closed regardless of an explicit choice.
  if (effect.kind === "unknown") {
    return { decision: "deny", reason: "Unknown side effect is blocked (fails closed).", requiresHuman: true };
  }
  if (!choice) return decideBalanced(effect);
  if (choice === "deny") {
    return { decision: "deny", reason: "Node is configured to deny this action.", requiresHuman: true };
  }
  if (choice === "auto") {
    if (effect.kind === "none" || effect.kind === "read") {
      return { decision: "allow", reason: "Read-only step runs automatically.", requiresHuman: false };
    }
    return { decision: "allow", reason: "Node is explicitly configured to run automatically.", requiresHuman: false };
  }
  return { decision: "approve", reason: "Node is configured to require human approval.", requiresHuman: true };
}

function baseDecision(input: EffectPolicyInput): EffectPolicyResult {
  const mode: WorkflowApprovalMode = input.policy.mode;
  if (mode === "strict") return decideStrict(input.effect);
  if (mode === "custom") return decideCustom(input.effect, input.policy.nodes?.[input.nodeId]);
  return decideBalanced(input.effect);
}

/**
 * Apply the policy. Unattended runs (cron/webhook/background) downgrade
 * approval to deny for high-risk and irreversible effects unless a bound
 * pre-authorization matches.
 */
export function decideEffectPolicy(input: EffectPolicyInput): EffectPolicyResult {
  const base = baseDecision(input);
  if (base.decision !== "approve") return base;

  if (input.preAuthorized) {
    return { decision: "allow", reason: "A bound pre-authorization matches this exact action.", requiresHuman: false };
  }

  if (!input.attended) {
    const e = input.effect;
    const highRisk = e.risk === "high" || e.risk === "critical";
    if (highRisk || isIrreversible(e)) {
      return {
        decision: "deny",
        reason: "Unattended run cannot perform a high-risk or irreversible action without a bound pre-authorization.",
        requiresHuman: true,
      };
    }
    // Lower-risk: pause for an operator (awaiting_approval) and expire cleanly.
    return { decision: "approve", reason: "Paused for approval; will expire if no operator responds.", requiresHuman: base.requiresHuman };
  }

  return base;
}

/**
 * Whether a model guardian could downgrade an approval to "allow". A model may
 * only soften a *low/medium reversible local write* false positive. It must
 * never authorize high/critical, unknown, external send/write, credential,
 * financial, or destructive effects.
 */
export function modelMayDowngrade(effect: EffectDescriptor): boolean {
  return (
    effect.kind === "local_write" &&
    (effect.risk === "low" || effect.risk === "medium") &&
    effect.reversible !== false
  );
}
