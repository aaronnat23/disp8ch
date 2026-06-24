/**
 * Typed cross-surface memory candidates.
 *
 * A candidate is an evidence-linked, reviewable proposal to write durable
 * memory from chat, a workflow result, a Board task, a Council verdict, or a
 * notebook finding. Candidates are NOT memory: nothing is retrievable until a
 * candidate is explicitly applied, and promotion uses the SAME
 * `applyMemoryOperations` + `buildWriteVisibility` path as direct workflow
 * memory — so workflow-private scope stays private and is enforced before
 * ranking. State transitions are audited through `recordMemoryPromotionEvent`.
 *
 * Safety invariants:
 *  - scope, workflow id, execution id, and node id come from the producer's
 *    authoritative runtime context, never from model tool arguments;
 *  - candidate writes are idempotent by origin + normalized content hash;
 *  - a conflict is only classified and flagged here — never auto-resolved.
 */
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import type { MemoryType } from "@/types/memory";
import {
  applyMemoryOperations,
  MemoryBatchValidationError,
  normalizeMemoryTags,
  validateMemoryContentInput,
} from "./atomic-operations";
import { buildWriteVisibility, type MemoryAccessMode } from "./workflow-scope";
import { recordMemoryPromotionEvent } from "./promotion-events";
import { resolveMemoryScope } from "./scope-resolver";
import { SimpleMemoryProvider } from "./simple";

const log = logger.child("memory:candidates");

export type CandidateStatus = "pending" | "approved" | "rejected" | "applied" | "superseded";
export type CandidateOrigin = "webchat" | "workflow" | "board" | "council" | "notebook";
export type CandidateScopeKind = "workflow" | "agent";
export type CandidateConflictState = "none" | "possible_duplicate" | "possible_conflict";
export type CandidateResolution = "keep_both" | "replace_existing" | "mark_superseded" | "reject" | "reinforce_existing";

export interface MemoryCandidate {
  id: string;
  status: CandidateStatus;
  agentId: string;
  content: string;
  type: MemoryType;
  tags: string[];
  confidence: number;
  whenToUse: string | null;
  happenedAt: string | null;
  scopeKind: CandidateScopeKind;
  scopeId: string | null;
  originType: CandidateOrigin;
  originId: string | null;
  executionId: string | null;
  nodeId: string | null;
  sessionId: string | null;
  documentId: string | null;
  evidence: string[];
  sourceSummary: string | null;
  candidateHash: string;
  conflictState: CandidateConflictState;
  relatedIds: string[];
  appliedEntryId: string | null;
  reviewAfter: string | null;
  expiresAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

function rowToCandidate(row: Row): MemoryCandidate {
  const parseArr = (v: unknown): string[] => {
    try { const p = JSON.parse(String(v ?? "[]")); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
  };
  return {
    id: String(row.id),
    status: String(row.status) as CandidateStatus,
    agentId: String(row.agent_id),
    content: String(row.content),
    type: String(row.type) as MemoryType,
    tags: parseArr(row.tags),
    confidence: Number(row.confidence),
    whenToUse: row.when_to_use ? String(row.when_to_use) : null,
    happenedAt: row.happened_at ? String(row.happened_at) : null,
    scopeKind: String(row.scope_kind) as CandidateScopeKind,
    scopeId: row.scope_id ? String(row.scope_id) : null,
    originType: String(row.origin_type) as CandidateOrigin,
    originId: row.origin_id ? String(row.origin_id) : null,
    executionId: row.execution_id ? String(row.execution_id) : null,
    nodeId: row.node_id ? String(row.node_id) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    documentId: row.document_id ? String(row.document_id) : null,
    evidence: parseArr(row.evidence_json),
    sourceSummary: row.source_summary ? String(row.source_summary) : null,
    candidateHash: String(row.candidate_hash),
    conflictState: String(row.conflict_state) as CandidateConflictState,
    relatedIds: parseArr(row.related_ids_json),
    appliedEntryId: row.applied_entry_id ? String(row.applied_entry_id) : null,
    reviewAfter: row.review_after ? String(row.review_after) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeContentForHash(content: string): string {
  return String(content).trim().replace(/\s+/g, " ").toLowerCase();
}

function computeCandidateHash(input: { agentId: string; originType: string; originId: string | null; scopeKind: string; scopeId: string | null; content: string }): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      agentId: input.agentId,
      originType: input.originType,
      originId: input.originId ?? "",
      scopeKind: input.scopeKind,
      scopeId: input.scopeId ?? "",
      content: normalizeContentForHash(input.content),
    }))
    .digest("hex");
}

export interface CreateCandidateInput {
  /** Resolved agent id (authoritative). */
  agentId: string;
  content: string;
  type?: string;
  tags?: unknown;
  confidence?: number;
  whenToUse?: string | null;
  happenedAt?: string | null;
  /** Access mode chosen by the producer; scope id from runtime context only. */
  scopeKind: CandidateScopeKind;
  scopeId?: string | null;
  originType: CandidateOrigin;
  originId?: string | null;
  executionId?: string | null;
  nodeId?: string | null;
  sessionId?: string | null;
  documentId?: string | null;
  evidence?: string[];
  sourceSummary?: string | null;
  reviewAfter?: string | null;
  expiresAt?: string | null;
}

/**
 * Create a pending candidate. Validates content with the same rules as direct
 * memory writes, is idempotent by origin + content hash, and records an audit
 * event. Returns the (possibly pre-existing) candidate.
 */
export function createMemoryCandidate(input: CreateCandidateInput): { candidate: MemoryCandidate; created: boolean } {
  // Reuse the exact memory validation (size, secret rejection, type, tags).
  validateMemoryContentInput({ content: input.content, type: input.type, tags: input.tags });

  initializeDatabase();
  const db = getSqlite();
  const agentId = String(input.agentId || "default").trim() || "default";
  const scopeKind: CandidateScopeKind = input.scopeKind === "workflow" ? "workflow" : "agent";
  const scopeId = scopeKind === "workflow" ? (input.scopeId ?? null) : null;
  const hash = computeCandidateHash({ agentId, originType: input.originType, originId: input.originId ?? null, scopeKind, scopeId, content: input.content });

  const existing = db.prepare("SELECT * FROM memory_candidates WHERE candidate_hash = ?").get(hash) as Row | undefined;
  if (existing) {
    return { candidate: rowToCandidate(existing), created: false };
  }

  const now = new Date().toISOString();
  const id = `mc_${nanoid(12)}`;
  const tags = normalizeMemoryTags(input.tags);
  const confidence = Number.isFinite(Number(input.confidence)) ? Math.max(0, Math.min(1, Number(input.confidence))) : 0.8;
  db.prepare(
    `INSERT INTO memory_candidates
      (id, status, agent_id, content, type, tags, confidence, when_to_use, happened_at,
       scope_kind, scope_id, origin_type, origin_id, execution_id, node_id, session_id, document_id,
       evidence_json, source_summary, candidate_hash, conflict_state, related_ids_json,
       review_after, expires_at, created_at, updated_at)
     VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', '[]', ?, ?, ?, ?)`,
  ).run(
    id, agentId, String(input.content).trim(), String(input.type || "fact"), JSON.stringify(tags), confidence,
    input.whenToUse ?? null, input.happenedAt ?? null, scopeKind, scopeId,
    input.originType, input.originId ?? null, input.executionId ?? null, input.nodeId ?? null,
    input.sessionId ?? null, input.documentId ?? null,
    JSON.stringify(input.evidence ?? []), input.sourceSummary ?? null, hash,
    input.reviewAfter ?? null, input.expiresAt ?? null, now, now,
  );

  recordMemoryPromotionEvent({
    agentId,
    eventKind: "candidate_created",
    source: input.originType,
    content: String(input.content).slice(0, 500),
    detail: { candidateId: id, scopeKind, scopeId, originType: input.originType, originId: input.originId ?? null },
  });

  const candidate = getMemoryCandidate(id)!;
  log.info("candidate.created", { id, origin: input.originType, scopeKind, scopeId });
  // Best-effort deterministic conflict/freshness classification.
  try { classifyCandidate(candidate); } catch { /* classification is non-fatal */ }
  return { candidate: getMemoryCandidate(id)!, created: true };
}

export function getMemoryCandidate(id: string): MemoryCandidate | null {
  initializeDatabase();
  const db = getSqlite();
  const row = db.prepare("SELECT * FROM memory_candidates WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToCandidate(row) : null;
}

export function listMemoryCandidates(opts: { agentId?: string; status?: CandidateStatus; limit?: number } = {}): MemoryCandidate[] {
  initializeDatabase();
  const db = getSqlite();
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (opts.agentId) { conditions.push("agent_id = ?"); values.push(opts.agentId); }
  if (opts.status) { conditions.push("status = ?"); values.push(opts.status); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT * FROM memory_candidates ${where} ORDER BY created_at DESC LIMIT ?`,
  ).all(...values, Math.max(1, Math.min(500, opts.limit ?? 100))) as Row[];
  return rows.map(rowToCandidate);
}

function touch(id: string, fields: Record<string, unknown>): void {
  const db = getSqlite();
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE memory_candidates SET ${sets}, updated_at = ? WHERE id = ?`).run(...Object.values(fields), new Date().toISOString(), id);
}

export function approveMemoryCandidate(id: string, decidedBy = "operator"): MemoryCandidate | null {
  const c = getMemoryCandidate(id);
  if (!c || (c.status !== "pending")) return c;
  touch(id, { status: "approved", reviewed_at: new Date().toISOString() });
  recordMemoryPromotionEvent({ agentId: c.agentId, eventKind: "candidate_approved", source: c.originType, content: c.content.slice(0, 200), detail: { candidateId: id, decidedBy } });
  return getMemoryCandidate(id);
}

export function rejectMemoryCandidate(id: string, note?: string): MemoryCandidate | null {
  const c = getMemoryCandidate(id);
  if (!c || (c.status !== "pending" && c.status !== "approved")) return c;
  touch(id, { status: "rejected", reviewed_at: new Date().toISOString() });
  recordMemoryPromotionEvent({ agentId: c.agentId, eventKind: "candidate_rejected", source: c.originType, content: c.content.slice(0, 200), detail: { candidateId: id, note: note ?? null } });
  return getMemoryCandidate(id);
}

/**
 * Apply a candidate into durable memory using the SAME atomic write + visibility
 * path as direct workflow memory. Resolution governs how a flagged conflict is
 * handled — the operator decides; the system never auto-replaces.
 */
export async function applyMemoryCandidate(
  id: string,
  opts: { resolution?: CandidateResolution; targetMemoryId?: string | null } = {},
): Promise<{ candidate: MemoryCandidate; appliedEntryId: string | null; reinforced: boolean }> {
  const c = getMemoryCandidate(id);
  if (!c) throw new MemoryBatchValidationError(`candidate not found: ${id}`);
  if (c.status === "applied") return { candidate: c, appliedEntryId: c.appliedEntryId, reinforced: false };
  if (c.status === "rejected" || c.status === "superseded") {
    throw new MemoryBatchValidationError(`candidate ${id} is ${c.status} and cannot be applied`);
  }

  const resolution: CandidateResolution = opts.resolution ?? "keep_both";
  if (resolution === "reject") {
    rejectMemoryCandidate(id);
    return { candidate: getMemoryCandidate(id)!, appliedEntryId: null, reinforced: false };
  }

  const accessMode: MemoryAccessMode = c.scopeKind === "workflow" ? "workflow" : "agent";
  const visibility = buildWriteVisibility(accessMode, {
    workflowId: c.scopeId,
    executionId: c.executionId,
    nodeId: c.nodeId,
  }) ?? undefined;
  const scope = resolveMemoryScope(c.agentId === "default" ? null : c.agentId);
  const memoryAgentId = scope.memoryAgentId;

  const metadata: Record<string, unknown> = {
    candidateId: c.id,
    originType: c.originType,
    ...(c.originId ? { originId: c.originId } : {}),
    ...(c.sessionId ? { sessionId: c.sessionId } : {}),
    ...(c.executionId ? { executionId: c.executionId } : {}),
    ...(c.nodeId ? { nodeId: c.nodeId } : {}),
    ...(c.whenToUse ? { whenToUse: c.whenToUse } : {}),
    ...(c.happenedAt ? { happenedAt: c.happenedAt } : {}),
  };

  let appliedEntryId: string | null = null;
  let reinforced = false;

  if ((resolution === "replace_existing" || resolution === "reinforce_existing" || resolution === "mark_superseded") && opts.targetMemoryId) {
    const provider = new SimpleMemoryProvider(memoryAgentId);
    const target = await provider.get(opts.targetMemoryId);
    if (!target) throw new MemoryBatchValidationError(`target memory not found: ${opts.targetMemoryId}`);

    if (resolution === "reinforce_existing") {
      // Reinforce: re-write identical content so reinforcement metadata bumps.
      const r = await applyMemoryOperations([{ op: "replace", id: target.id, content: target.content, type: target.type, metadata: { ...(target.metadata ?? {}), reinforcedByCandidate: c.id } }], { agentId: memoryAgentId, visibility });
      appliedEntryId = r.replaced[0] ?? target.id;
      reinforced = true;
    } else if (resolution === "replace_existing") {
      const r = await applyMemoryOperations([{ op: "replace", id: target.id, content: c.content, type: c.type, metadata }], { agentId: memoryAgentId, visibility });
      appliedEntryId = r.replaced[0] ?? target.id;
    } else {
      // mark_superseded: flag the old entry, add the new one alongside.
      await applyMemoryOperations([{ op: "replace", id: target.id, content: target.content, type: target.type, metadata: { ...(target.metadata ?? {}), superseded: true, supersededByCandidate: c.id, supersededAt: new Date().toISOString() } }], { agentId: memoryAgentId, visibility });
      const r = await applyMemoryOperations([{ op: "add", content: c.content, type: c.type, tags: c.tags, metadata }], { agentId: memoryAgentId, visibility });
      appliedEntryId = r.added[0] ?? null;
    }
  } else {
    // keep_both (default): a plain add.
    const r = await applyMemoryOperations([{ op: "add", content: c.content, type: c.type, tags: c.tags, metadata }], { agentId: memoryAgentId, visibility });
    appliedEntryId = r.added[0] ?? null;
  }

  touch(id, { status: "applied", applied_entry_id: appliedEntryId, reviewed_at: new Date().toISOString() });
  recordMemoryPromotionEvent({
    agentId: c.agentId,
    entryId: appliedEntryId,
    eventKind: reinforced ? "candidate_reinforced" : "candidate_applied",
    source: c.originType,
    content: c.content.slice(0, 200),
    detail: { candidateId: id, resolution, scopeKind: c.scopeKind, scopeId: c.scopeId, targetMemoryId: opts.targetMemoryId ?? null },
  });
  log.info("candidate.applied", { id, resolution, appliedEntryId, reinforced });
  return { candidate: getMemoryCandidate(id)!, appliedEntryId, reinforced };
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 3: deterministic conflict + freshness classification (flag only).
// ──────────────────────────────────────────────────────────────────────────

const PREFERENCE_RE = /\b(prefer|prefers|preferred|favou?rite|like|likes|use|uses|default to|always|never)\b/i;
const TYPES_WITH_FRESHNESS = new Set<MemoryType>(["fact", "observation", "event", "knowledge"]);

function tokenize(text: string): Set<string> {
  return new Set(
    String(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Classify a candidate against existing memory within its FINAL visibility scope
 * only. Detects exact duplicates, possible duplicates, and possible conflicts
 * (polarity/temporal signals). Updates conflict_state + related_ids. Never
 * mutates existing memory.
 */
export function classifyCandidate(candidate: MemoryCandidate): { conflictState: CandidateConflictState; relatedIds: string[] } {
  initializeDatabase();
  const db = getSqlite();
  const scope = resolveMemoryScope(candidate.agentId === "default" ? null : candidate.agentId);
  const memoryAgentId = scope.memoryAgentId;

  // Scope the conflict search the same way retrieval is scoped.
  let scopedIds: Set<string> | null = null;
  if (candidate.scopeKind === "workflow") {
    if (!candidate.scopeId) { setConflict(db, candidate.id, "none", []); return { conflictState: "none", relatedIds: [] }; }
    const rows = db.prepare("SELECT id FROM memory_atomic_scope WHERE agent_id = ? AND visibility_kind = 'workflow' AND visibility_id = ?").all(memoryAgentId, candidate.scopeId) as Array<{ id: string }>;
    scopedIds = new Set(rows.map((r) => r.id));
    if (scopedIds.size === 0) { setConflict(db, candidate.id, "none", []); return { conflictState: "none", relatedIds: [] }; }
  } else {
    // agent scope: exclude workflow-private entries.
    const rows = db.prepare("SELECT id FROM memory_atomic_scope WHERE agent_id = ? AND visibility_kind = 'workflow'").all(memoryAgentId) as Array<{ id: string }>;
    const wfPrivate = new Set(rows.map((r) => r.id));
    scopedIds = wfPrivate.size > 0 ? wfPrivate : null; // null = no exclusion needed
  }

  // Pull candidate atomic entries (FTS over content tokens), then scope-filter.
  const ftsQuery = Array.from(tokenize(candidate.content)).slice(0, 12).join(" ");
  let related: Array<{ id: string; content: string; type: string }> = [];
  if (ftsQuery.trim()) {
    try {
      const rows = db.prepare(
        "SELECT id, content, type FROM memories_fts WHERE memories_fts MATCH ? LIMIT 40",
      ).all(ftsQuery.split(/\s+/).map((t) => `"${t}"`).join(" OR ")) as Array<{ id: string; content: string; type: string }>;
      related = rows;
    } catch {
      related = [];
    }
  }
  // Apply visibility scoping.
  related = related.filter((r) => {
    if (candidate.scopeKind === "workflow") return scopedIds!.has(r.id);
    return !(scopedIds && scopedIds.has(r.id)); // agent: exclude workflow-private
  });

  const candTokens = tokenize(candidate.content);
  const candLower = candidate.content.toLowerCase();
  const candHasDate = /\b(20\d{2}|19\d{2})\b|\bv?\d+\.\d+/.test(candLower);
  const exactNorm = normalizeContentForHash(candidate.content);

  let state: CandidateConflictState = "none";
  const relatedIds: string[] = [];
  for (const r of related) {
    if (normalizeContentForHash(r.content) === exactNorm) {
      // exact duplicate
      setConflict(db, candidate.id, "possible_duplicate", [r.id]);
      return { conflictState: "possible_duplicate", relatedIds: [r.id] };
    }
    const sim = jaccard(candTokens, tokenize(r.content));
    if (sim < 0.35) continue;
    relatedIds.push(r.id);
    const rLower = r.content.toLowerCase();
    const bothPreference = PREFERENCE_RE.test(candLower) && PREFERENCE_RE.test(rLower);
    const temporal = candHasDate && /\b(20\d{2}|19\d{2})\b|\bv?\d+\.\d+/.test(rLower) && rLower !== candLower;
    if (bothPreference || temporal || candidate.type === "correction") {
      state = "possible_conflict";
    } else if (state !== "possible_conflict") {
      state = "possible_duplicate";
    }
  }

  setConflict(db, candidate.id, state, relatedIds.slice(0, 10));
  return { conflictState: state, relatedIds: relatedIds.slice(0, 10) };
}

function setConflict(db: ReturnType<typeof getSqlite>, id: string, state: CandidateConflictState, relatedIds: string[]): void {
  db.prepare("UPDATE memory_candidates SET conflict_state = ?, related_ids_json = ?, updated_at = ? WHERE id = ?")
    .run(state, JSON.stringify(relatedIds), new Date().toISOString(), id);
}

/** Default freshness window for fact-like candidate types (null = no auto-expiry). */
export function defaultFreshness(type: string): { reviewAfter: string | null; expiresAt: string | null } {
  if (!TYPES_WITH_FRESHNESS.has(type as MemoryType)) {
    return { reviewAfter: null, expiresAt: null }; // preferences / identity never auto-expire
  }
  const reviewAfter = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  return { reviewAfter, expiresAt: null };
}

/** Candidates and entries due for review (overdue review_after, not yet decided). */
export function listReviewDueCandidates(now = new Date()): MemoryCandidate[] {
  initializeDatabase();
  const db = getSqlite();
  const rows = db.prepare(
    "SELECT * FROM memory_candidates WHERE status = 'pending' AND review_after IS NOT NULL AND review_after < ? ORDER BY review_after ASC LIMIT 200",
  ).all(now.toISOString()) as Row[];
  return rows.map(rowToCandidate);
}
