/**
 * Durable, hash-bound, one-time workflow node approval grants.
 *
 * A grant authorizes the exact tuple it was created for: workflow version,
 * execution, node, attempt, effect, and normalized effect-relevant inputs. The
 * digest is recomputed immediately before execution; any mismatch invalidates
 * the approval. Approved grants are claimed atomically so only one worker can
 * execute, and a completed side effect cannot be repeated.
 */
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import type { WorkflowNode, WorkflowEdge } from "@/types/workflow";
import type { EffectDescriptor } from "./effects";

const log = logger.child("workflow:approvals");

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "claimed" | "executed" | "indeterminate";

export interface ApprovalRecord {
  id: string;
  workflowId: string;
  workflowVersionHash: string;
  executionId: string;
  nodeId: string;
  attempt: number;
  effectKind: string;
  effectRisk: string;
  effect: EffectDescriptor;
  target: string | null;
  inputHash: string;
  digest: string;
  status: ApprovalStatus;
  requiresHuman: boolean;
  requestedAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  claimedAt: string | null;
  executedAt: string | null;
  resultRef: string | null;
}

type Row = {
  id: string;
  workflow_id: string;
  workflow_version_hash: string;
  execution_id: string;
  node_id: string;
  attempt: number;
  effect_kind: string;
  effect_risk: string;
  effect_json: string;
  target: string | null;
  input_hash: string;
  digest: string;
  status: ApprovalStatus;
  requires_human: number;
  requested_at: string;
  expires_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  claimed_at: string | null;
  executed_at: string | null;
  result_ref: string | null;
};

function rowToRecord(row: Row): ApprovalRecord {
  let effect: EffectDescriptor;
  try {
    effect = JSON.parse(row.effect_json) as EffectDescriptor;
  } catch {
    effect = { kind: "unknown", risk: "high", reversible: false, target: row.target, summary: "", details: {} };
  }
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionHash: row.workflow_version_hash,
    executionId: row.execution_id,
    nodeId: row.node_id,
    attempt: row.attempt,
    effectKind: row.effect_kind,
    effectRisk: row.effect_risk,
    effect,
    target: row.target,
    inputHash: row.input_hash,
    digest: row.digest,
    status: row.status,
    requiresHuman: row.requires_human === 1,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    claimedAt: row.claimed_at,
    executedAt: row.executed_at,
    resultRef: row.result_ref,
  };
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** Canonical, key-sorted JSON so logically equal payloads hash identically. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet();
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(normalize);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = normalize(obj[key]);
    return out;
  };
  return JSON.stringify(normalize(value));
}

/** Stable hash of the immutable graph (node ids/types/data + edges). */
export function computeWorkflowVersionHash(nodes: WorkflowNode[], edges: WorkflowEdge[]): string {
  const graph = {
    nodes: [...nodes]
      .map((n) => ({ id: n.id, type: n.type, data: n.data ?? {} }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges]
      .map((e) => ({ source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null }))
      .sort((a, b) => `${a.source}>${a.target}`.localeCompare(`${b.source}>${b.target}`)),
  };
  return sha256(canonicalJson(graph)).slice(0, 32);
}

/** Hash of effect-relevant, normalized inputs (target + payload + effect identity). */
export function computeInputHash(effect: EffectDescriptor, normalizedInputs: Record<string, unknown>): string {
  return sha256(canonicalJson({ kind: effect.kind, risk: effect.risk, target: effect.target ?? null, inputs: normalizedInputs }));
}

export interface DigestParts {
  workflowId: string;
  workflowVersionHash: string;
  /** execution id for run-bound grants, or a pre-authorization scope key */
  scope: string;
  nodeId: string;
  effect: EffectDescriptor;
  inputHash: string;
}

export function computeApprovalDigest(parts: DigestParts): string {
  return sha256(
    canonicalJson({
      workflowId: parts.workflowId,
      workflowVersionHash: parts.workflowVersionHash,
      scope: parts.scope,
      nodeId: parts.nodeId,
      effectKind: parts.effect.kind,
      effectRisk: parts.effect.risk,
      target: parts.effect.target ?? null,
      inputHash: parts.inputHash,
    }),
  );
}

export interface CreateApprovalInput {
  workflowId: string;
  workflowVersionHash: string;
  executionId: string;
  nodeId: string;
  attempt: number;
  effect: EffectDescriptor;
  inputHash: string;
  digest: string;
  requiresHuman: boolean;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function createApprovalRequest(input: CreateApprovalInput): ApprovalRecord {
  initializeDatabase();
  const db = getSqlite();
  const now = new Date();
  const id = `wfa_${nanoid(12)}`;
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
  db.prepare(
    `INSERT INTO workflow_node_approvals
      (id, workflow_id, workflow_version_hash, execution_id, node_id, attempt,
       effect_kind, effect_risk, effect_json, target, input_hash, digest, status,
       requires_human, requested_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id,
    input.workflowId,
    input.workflowVersionHash,
    input.executionId,
    input.nodeId,
    input.attempt,
    input.effect.kind,
    input.effect.risk,
    JSON.stringify(input.effect),
    input.effect.target ?? null,
    input.inputHash,
    input.digest,
    input.requiresHuman ? 1 : 0,
    now.toISOString(),
    expiresAt,
  );
  return getApproval(id)!;
}

export function getApproval(id: string): ApprovalRecord | null {
  initializeDatabase();
  const db = getSqlite();
  const row = db.prepare("SELECT * FROM workflow_node_approvals WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

/** Expire any pending approvals whose TTL has passed; returns expired ids. */
export function expireStaleApprovals(now = new Date()): string[] {
  initializeDatabase();
  const db = getSqlite();
  const rows = db
    .prepare("SELECT id FROM workflow_node_approvals WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?")
    .all(now.toISOString()) as Array<{ id: string }>;
  if (rows.length === 0) return [];
  db.prepare("UPDATE workflow_node_approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?")
    .run(now.toISOString(), now.toISOString());
  return rows.map((r) => r.id);
}

export function decideApproval(input: {
  id: string;
  decision: "approved" | "denied";
  decidedBy: string;
  note?: string | null;
}): ApprovalRecord | null {
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();
  expireStaleApprovals(new Date(now));
  // Only a pending, unexpired request may be decided.
  const updated = db
    .prepare(
      `UPDATE workflow_node_approvals
       SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?
       WHERE id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at >= ?)`,
    )
    .run(input.decision, now, input.decidedBy, input.note ?? null, input.id, now);
  if (updated.changes === 0) return getApproval(input.id);
  log.info("approval.decided", { id: input.id, decision: input.decision, by: input.decidedBy });
  return getApproval(input.id);
}

/**
 * Atomically claim an approved grant for execution. Only the winning claim
 * (approved → claimed) returns the record; everyone else gets null. Recomputes
 * nothing here — the caller must verify the digest still matches before calling.
 */
export function claimApprovedGrant(id: string, expectedDigest: string): ApprovalRecord | null {
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();
  const res = db
    .prepare("UPDATE workflow_node_approvals SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'approved' AND digest = ? AND (expires_at IS NULL OR expires_at >= ?)")
    .run(now, id, expectedDigest, now);
  if (res.changes === 0) return null;
  return getApproval(id);
}

export function markApprovalExecuted(id: string, resultRef?: string | null): void {
  initializeDatabase();
  const db = getSqlite();
  db.prepare("UPDATE workflow_node_approvals SET status = 'executed', executed_at = ?, result_ref = ? WHERE id = ? AND status = 'claimed'")
    .run(new Date().toISOString(), resultRef ?? null, id);
}

export function markApprovalIndeterminate(id: string, reason: string): void {
  initializeDatabase();
  const db = getSqlite();
  db.prepare("UPDATE workflow_node_approvals SET status = 'indeterminate', decision_note = ? WHERE id = ? AND status = 'claimed'")
    .run(reason.slice(0, 1000), id);
}

/** Release a claimed-but-unexecuted grant (e.g., cancellation) back to denied. */
export function releaseClaim(id: string, reason: string): void {
  initializeDatabase();
  const db = getSqlite();
  db.prepare("UPDATE workflow_node_approvals SET status = 'denied', decision_note = ? WHERE id = ? AND status IN ('claimed','approved','pending')")
    .run(reason, id);
}

/** Find an existing reusable approved grant for this exact digest in the execution. */
export function findApprovedGrantByDigest(digest: string): ApprovalRecord | null {
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();
  const row = db
    .prepare("SELECT * FROM workflow_node_approvals WHERE digest = ? AND status = 'approved' AND (expires_at IS NULL OR expires_at >= ?) ORDER BY requested_at DESC LIMIT 1")
    .get(digest, now) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

/** Find a pending request already open for this exact digest (avoid duplicates). */
export function findPendingByDigest(digest: string): ApprovalRecord | null {
  initializeDatabase();
  const db = getSqlite();
  expireStaleApprovals();
  const row = db
    .prepare("SELECT * FROM workflow_node_approvals WHERE digest = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1")
    .get(digest) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

export function listPendingApprovals(limit = 50): ApprovalRecord[] {
  initializeDatabase();
  const db = getSqlite();
  expireStaleApprovals();
  const rows = db
    .prepare("SELECT * FROM workflow_node_approvals WHERE status = 'pending' ORDER BY requested_at DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map(rowToRecord);
}

export function listApprovalsForExecution(executionId: string): ApprovalRecord[] {
  initializeDatabase();
  const db = getSqlite();
  const rows = db
    .prepare("SELECT * FROM workflow_node_approvals WHERE execution_id = ? ORDER BY requested_at ASC")
    .all(executionId) as Row[];
  return rows.map(rowToRecord);
}

/**
 * Wait (poll) for a pending approval to be decided. Returns the terminal record.
 * Used by attended runs so the handler is never called before a decision.
 */
export async function awaitApprovalDecision(
  id: string,
  opts: { timeoutMs: number; pollMs?: number; signal?: AbortSignal },
): Promise<ApprovalRecord> {
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    expireStaleApprovals();
    const rec = getApproval(id);
    if (!rec) throw new Error(`Approval ${id} not found`);
    if (rec.status !== "pending") return rec;
    if (opts.signal?.aborted) {
      decideApproval({ id, decision: "denied", decidedBy: "system", note: "Execution cancelled while awaiting approval." });
      return getApproval(id)!;
    }
    if (Date.now() >= deadline) {
      // Force-expire and return.
      const db = getSqlite();
      db.prepare("UPDATE workflow_node_approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'")
        .run(new Date().toISOString(), id);
      return getApproval(id)!;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
