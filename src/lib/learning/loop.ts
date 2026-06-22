import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { callModel } from "@/lib/agents/multi-provider";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";
import { resolveModelApiKey } from "@/lib/agents/provider-auth";
import {
  appendMainMemoryNote,
  ensureWorkspaceScaffold,
  getMainMemoryLearningNotes,
  getWorkspaceDir,
  pruneLearningLoopMemoryNotes,
} from "@/lib/workspace/files";
import { logger } from "@/lib/utils/logger";
import { getModelPricing } from "@/lib/agents/cost-estimator";
import { isProviderLocallyHosted, getProviderPlugin } from "@/lib/agents/provider-plugins";
import { scanLearningWrite } from "@/lib/learning/memory-guard";
import { scanSkillContent } from "@/lib/learning/skill-guard";

const log = logger.child("learning:loop");
const LEARNING_EVENT_MAX_ROWS = 1200;
const LEARNING_DISMISSED_CANDIDATE_MAX_ROWS = 250;
const LEARNING_DISMISSED_CANDIDATE_MAX_AGE_DAYS = 45;
const LEARNING_MEMORY_NOTE_MAX_ENTRIES = 20;

export type LearningMode = "off" | "review" | "auto";
export type LearningCandidateKind = "memory-note" | "workspace-skill";
export type LearningCandidateStatus = "proposed" | "promoted" | "dismissed";
export type LearningEventKind = "user-preference" | "playbook" | "user-profile" | "workspace-context";

export type LearningConfig = {
  enabled: boolean;
  mode: LearningMode;
  capturePreferences: boolean;
  capturePlaybooks: boolean;
  autoPromoteThreshold: number;
  llmReviewEnabled: boolean;
  llmReviewInterval: number;
  showFeedback: boolean;
};

export type LearningEventRecord = {
  id: string;
  kind: LearningEventKind;
  fingerprint: string;
  scope: string;
  scopeId: string | null;
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  createdAt: string;
};

export type LearningCandidateRecord = {
  id: string;
  fingerprint: string;
  status: LearningCandidateStatus;
  kind: LearningCandidateKind;
  scope: string;
  scopeId: string | null;
  title: string;
  summary: string;
  content: string | null;
  confidence: number;
  evidenceCount: number;
  sourceEventIds: string[];
  targetPath: string | null;
  promotedAt: string | null;
  lastSynthesizedEvidenceCount: number | null;
  createdAt: string;
  updatedAt: string;
};

type LearningEventRow = {
  id: string;
  kind: LearningEventKind;
  fingerprint: string;
  scope: string;
  scope_id: string | null;
  title: string;
  summary: string;
  evidence_json: string;
  created_at: string;
};

type LearningCandidateRow = {
  id: string;
  fingerprint: string;
  status: LearningCandidateStatus;
  kind: LearningCandidateKind;
  scope: string;
  scope_id: string | null;
  title: string;
  summary: string;
  content: string | null;
  confidence: number | null;
  evidence_count: number | null;
  source_event_ids: string;
  target_path: string | null;
  promoted_at: string | null;
  last_synthesized_evidence_count: number | null;
  created_at: string;
  updated_at: string;
};

type PreferenceSignal = {
  fingerprint: string;
  title: string;
  summary: string;
  note: string;
};

type PlaybookSignal = {
  fingerprint: string;
  scope: string;
  scopeId: string | null;
  title: string;
  summary: string;
};

type InteractionInput = {
  sessionId: string;
  message: string;
  response: string;
  routeSource: string | null;
  agentId: string | null;
};

type LlmLearningFinding = {
  type: string;
  summary: string;
  confidence: number;
};

type LearningSessionTurn = {
  message: string;
  response: string;
};

type LearningSessionState = {
  turnsSinceLastLlmReview: number;
  recentTurns: LearningSessionTurn[];
  lastTouchedAt: number;
};

type LearningNotificationKind =
  | "preference"
  | "profile"
  | "workspace"
  | "playbook"
  | "llm-finding";

export type LearningNotification = {
  sessionId: string;
  kind: LearningNotificationKind;
  summary: string;
  field?: string;
  savedAt: number;
};

const LEARNING_SESSION_STATE_TTL_MS = 6 * 60 * 60 * 1000;
const LEARNING_NOTIFICATION_TTL_MS = 60_000;
const MAX_LEARNING_NOTIFICATIONS_PER_SESSION = 5;
const learningSessionState = new Map<string, LearningSessionState>();
const recentLearningNotifications = new Map<string, LearningNotification[]>();

function collapseWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clip(value: string, maxChars = 240): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function slugify(value: string): string {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function parseJsonArray(value: string | null): string[] {
  try {
    const parsed = JSON.parse(String(value || "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value || "{}")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapEventRow(row: LearningEventRow): LearningEventRecord {
  return {
    id: row.id,
    kind: row.kind,
    fingerprint: row.fingerprint,
    scope: row.scope,
    scopeId: row.scope_id ?? null,
    title: row.title,
    summary: row.summary,
    evidence: parseJsonObject(row.evidence_json),
    createdAt: row.created_at,
  };
}

function mapCandidateRow(row: LearningCandidateRow): LearningCandidateRecord {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    status: row.status,
    kind: row.kind,
    scope: row.scope,
    scopeId: row.scope_id ?? null,
    title: row.title,
    summary: row.summary,
    content: row.content ?? null,
    confidence: Number(row.confidence ?? 0),
    evidenceCount: Number(row.evidence_count ?? 0),
    sourceEventIds: parseJsonArray(row.source_event_ids),
    targetPath: row.target_path ?? null,
    promotedAt: row.promoted_at ?? null,
    lastSynthesizedEvidenceCount: row.last_synthesized_evidence_count ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMillis(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function countWords(value: string): number {
  return collapseWhitespace(value).split(/\s+/).filter(Boolean).length;
}

function containsAny(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

function looksLikeQuestion(value: string): boolean {
  const text = collapseWhitespace(value).toLowerCase();
  return text.endsWith("?") || /^(what|why|how|when|where|who|can|could|would|should|do|does|did|is|are|am)\b/.test(text);
}

const LOW_SIGNAL_LEARNING_PHRASES = [
  "you are",
  "assistant is",
  "the assistant",
  "chatgpt",
  "claude",
  "gemini",
  "llm",
  "ai model",
  "good at",
  "capable of",
  "helpful",
  "smart",
  "likes when",
  "wants you to",
  "the user likes",
  "the user prefers",
  "the workspace prefers",
];

function isLowSignalLearningText(value: string): boolean {
  const text = collapseWhitespace(value);
  if (!text) return true;
  if (looksLikeQuestion(text)) return true;
  if (countWords(text) < 3) return true;
  if (countWords(text) > 18) return true;
  if (containsAny(text, LOW_SIGNAL_LEARNING_PHRASES)) return true;
  if (/[<{}`[\]]/.test(text)) return true;
  return false;
}

function shouldCaptureProfileValue(field: string, value: string): boolean {
  const normalized = collapseWhitespace(value);
  if (!normalized) return false;
  const words = countWords(normalized);
  if (words < 1 || words > 8) return false;
  if (looksLikeQuestion(normalized)) return false;
  if (containsAny(normalized, ["please", "always", "never", "use ", "format", "response", "reply"])) return false;
  if (containsAny(normalized, ["assistant", "model", "tool", "agent"])) return false;
  return true;
}

function shouldCaptureWorkspaceContextValue(key: string, value: string): boolean {
  const normalized = collapseWhitespace(value);
  if (!normalized) return false;
  const words = countWords(normalized);
  if (words < 1 || words > 12) return false;
  if (looksLikeQuestion(normalized)) return false;
  if (containsAny(normalized, ["please", "always", "never", "i prefer", "use bullet", "response", "reply"])) return false;
  if (containsAny(normalized, ["assistant", "model", "tool", "agent"])) return false;
  return true;
}

function normalizeLearningSummary(summary: string): string {
  return clip(
    collapseWhitespace(summary)
      .replace(/^(?:the user|user)\s+(?:prefers?|wants?|likes?)\s+/i, "")
      .replace(/^(?:the workspace|workspace)\s+(?:prefers?|uses?)\s+/i, "")
      .replace(/^(?:please|always)\s+/i, ""),
    180,
  );
}

function shouldKeepLlmFinding(finding: LlmLearningFinding): boolean {
  if (!finding.summary) return false;
  if (Number(finding.confidence || 0) < 0.72) return false;
  const normalized = normalizeLearningSummary(finding.summary);
  if (isLowSignalLearningText(normalized)) return false;
  if (finding.type === "playbook" && countWords(normalized) < 5) return false;
  if (finding.type === "user-profile" && containsAny(normalized, ["assistant", "model", "tool", "agent"])) return false;
  return ["preference", "playbook", "user-profile"].includes(String(finding.type || "").toLowerCase());
}

function cleanupLearningSessionState(now = Date.now()): void {
  for (const [key, state] of learningSessionState) {
    if (now - state.lastTouchedAt > LEARNING_SESSION_STATE_TTL_MS) {
      learningSessionState.delete(key);
    }
  }
}

function getLearningSessionKey(sessionId: string, agentId?: string | null): string {
  const session = String(sessionId || "").trim();
  const agent = String(agentId || "").trim();
  return agent ? `${session}::${agent}` : session;
}

function getOrCreateLearningSessionState(sessionId: string, agentId?: string | null): LearningSessionState {
  const now = Date.now();
  cleanupLearningSessionState(now);
  const key = getLearningSessionKey(sessionId, agentId);
  const existing = learningSessionState.get(key);
  if (existing) {
    existing.lastTouchedAt = now;
    return existing;
  }
  const next: LearningSessionState = {
    turnsSinceLastLlmReview: 0,
    recentTurns: [],
    lastTouchedAt: now,
  };
  learningSessionState.set(key, next);
  return next;
}

function enqueueLearningNotification(
  sessionId: string,
  notification: Omit<LearningNotification, "sessionId" | "savedAt">,
): void {
  if (!sessionId) return;
  const now = Date.now();
  const current = recentLearningNotifications.get(sessionId) ?? [];
  const fresh = current.filter((item) => now - item.savedAt < LEARNING_NOTIFICATION_TTL_MS);
  const duplicate = fresh.find((item) => item.kind === notification.kind && item.summary === notification.summary && item.field === notification.field);
  if (duplicate) return;
  fresh.push({
    ...notification,
    sessionId,
    savedAt: now,
  });
  recentLearningNotifications.set(sessionId, fresh.slice(-MAX_LEARNING_NOTIFICATIONS_PER_SESSION));
}

export function drainLearningNotifications(sessionId: string): LearningNotification[] {
  const now = Date.now();
  const current = recentLearningNotifications.get(sessionId) ?? [];
  recentLearningNotifications.delete(sessionId);
  return current.filter((item) => now - item.savedAt < LEARNING_NOTIFICATION_TTL_MS);
}

export function formatLearningFeedbackText(items: LearningNotification[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) {
    const item = items[0]!;
    if (item.kind === "profile") return `Profile updated: ${item.field || item.summary}`;
    if (item.kind === "workspace") return `Workspace updated: ${item.field || item.summary}`;
    if (item.kind === "playbook") return `Playbook saved: ${item.summary}`;
    return `Remembered: ${item.summary}`;
  }
  return `Saved ${items.length} learnings`;
}

function pruneLearningDatabaseState(): void {
  initializeDatabase();
  const db = getSqlite();
  const protectedEventIds = new Set<string>();
  const candidateRows = db.prepare(`
    SELECT status, source_event_ids
    FROM learning_candidates
    WHERE status IN ('proposed', 'promoted')
  `).all() as Array<{ status: string; source_event_ids: string }>;
  for (const row of candidateRows) {
    for (const id of parseJsonArray(row.source_event_ids)) {
      if (id) protectedEventIds.add(id);
    }
  }

  const eventRows = db.prepare(`
    SELECT id
    FROM learning_events
    ORDER BY created_at DESC
  `).all() as Array<{ id: string }>;
  const staleEventIds = eventRows
    .slice(LEARNING_EVENT_MAX_ROWS)
    .map((row) => row.id)
    .filter((id) => !protectedEventIds.has(id));

  const dismissedRows = db.prepare(`
    SELECT id, updated_at
    FROM learning_candidates
    WHERE status = 'dismissed'
    ORDER BY updated_at DESC
  `).all() as Array<{ id: string; updated_at: string }>;
  const now = Date.now();
  const staleDismissedIds = dismissedRows
    .filter((row, index) => {
      if (index >= LEARNING_DISMISSED_CANDIDATE_MAX_ROWS) return true;
      const ageDays = (now - toMillis(row.updated_at)) / (1000 * 60 * 60 * 24);
      return ageDays > LEARNING_DISMISSED_CANDIDATE_MAX_AGE_DAYS;
    })
    .map((row) => row.id);

  if (staleEventIds.length === 0 && staleDismissedIds.length === 0) return;

  withSqliteWriteRecovery("learning-retention:prune", (writer) => {
    if (staleEventIds.length > 0) {
      const deleteEventStmt = writer.prepare("DELETE FROM learning_events WHERE id = ?");
      for (const id of staleEventIds) deleteEventStmt.run(id);
    }
    if (staleDismissedIds.length > 0) {
      const deleteCandidateStmt = writer.prepare("DELETE FROM learning_candidates WHERE id = ?");
      for (const id of staleDismissedIds) deleteCandidateStmt.run(id);
    }
  });
}

export function getLearningConfig(): LearningConfig {
  initializeDatabase();
  const db = getSqlite();
  const row = db.prepare(`
    SELECT
      learning_enabled,
      learning_mode,
      learning_capture_preferences,
      learning_capture_playbooks,
      learning_auto_promote_threshold,
      learning_llm_review_enabled,
      learning_llm_review_interval,
      learning_show_feedback
    FROM app_config
    WHERE id = 'default'
  `).get() as
    | {
        learning_enabled?: number;
        learning_mode?: string | null;
        learning_capture_preferences?: number;
        learning_capture_playbooks?: number;
        learning_auto_promote_threshold?: number;
        learning_llm_review_enabled?: number;
        learning_llm_review_interval?: number;
        learning_show_feedback?: number;
      }
    | undefined;

  const modeRaw = String(row?.learning_mode || "review").trim().toLowerCase();
  const mode: LearningMode =
    modeRaw === "auto" ? "auto" : modeRaw === "off" ? "off" : "review";

  return {
    enabled: (row?.learning_enabled ?? 0) === 1 && mode !== "off",
    mode,
    capturePreferences: (row?.learning_capture_preferences ?? 1) === 1,
    capturePlaybooks: (row?.learning_capture_playbooks ?? 1) === 1,
    autoPromoteThreshold: Math.max(1, Math.min(10, Number(row?.learning_auto_promote_threshold ?? 2))),
    llmReviewEnabled: (row?.learning_llm_review_enabled ?? 1) === 1,
    llmReviewInterval: Math.max(3, Math.min(50, Number(row?.learning_llm_review_interval ?? 10))),
    showFeedback: (row?.learning_show_feedback ?? 1) === 1,
  };
}

export function listLearningEvents(limit = 50): LearningEventRecord[] {
  initializeDatabase();
  const db = getSqlite();
  const rows = db.prepare(`
    SELECT id, kind, fingerprint, scope, scope_id, title, summary, evidence_json, created_at
    FROM learning_events
    ORDER BY created_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(200, limit))) as LearningEventRow[];
  return rows.map(mapEventRow);
}

export function listLearningCandidates(status?: LearningCandidateStatus | "all"): LearningCandidateRecord[] {
  initializeDatabase();
  const db = getSqlite();
  const rows = (
    status && status !== "all"
      ? db.prepare(`
          SELECT *
          FROM learning_candidates
          WHERE status = ?
          ORDER BY updated_at DESC, created_at DESC
        `).all(status)
      : db.prepare(`
          SELECT *
          FROM learning_candidates
          ORDER BY updated_at DESC, created_at DESC
        `).all()
  ) as LearningCandidateRow[];
  return rows.map(mapCandidateRow);
}

export function getLearningCandidate(reference: string): LearningCandidateRecord | null {
  const trimmed = String(reference || "").trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === "latest" || lower === "newest") {
    const byCreatedAtDesc = (a: LearningCandidateRecord, b: LearningCandidateRecord) =>
      Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "") ||
      Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "");
    return (
      [...listLearningCandidates("proposed")].sort(byCreatedAtDesc)[0] ??
      [...listLearningCandidates("all")].sort(byCreatedAtDesc)[0] ??
      null
    );
  }
  const candidates = listLearningCandidates("all");
  return (
    candidates.find((candidate) => candidate.id === trimmed) ??
    candidates.find((candidate) => candidate.fingerprint === trimmed) ??
    candidates.find((candidate) => candidate.title.toLowerCase() === lower) ??
    candidates.find((candidate) => candidate.title.toLowerCase().includes(lower)) ??
    null
  );
}

function detectPreferenceSignal(message: string): PreferenceSignal | null {
  const raw = collapseWhitespace(message);
  if (!raw) return null;
  const patterns: Array<{ re: RegExp; label: string }> = [
    { re: /^(?:i|we)\s+prefer\s+(.+)$/i, label: "User Preference" },
    { re: /^(?:i|we)'?d\s+(?:rather|prefer)\s+(.+)$/i, label: "User Preference" },
    { re: /^(?:please\s+)?default\s+to\s+(.+)$/i, label: "User Preference" },
    { re: /^(?:please\s+)?always\s+use\s+(.+)$/i, label: "User Preference" },
    { re: /^(?:please\s+)?(?:don'?t|do not)\s+use\s+(.+)$/i, label: "User Preference" },
    { re: /^(?:i|we)\s+(?:hate|dislike|don'?t like)\s+(.+)$/i, label: "User Preference" },
    { re: /^(.+?)\s+(?:doesn'?t|don'?t|never)\s+work(?:s)?\s+for\s+(?:me|us)$/i, label: "User Preference" },
    { re: /^(?:from now on|starting now),?\s+(?:please\s+)?(.+)$/i, label: "User Preference" },
    { re: /^(?:please\s+)?stop\s+(?:doing\s+)?(.+)$/i, label: "User Preference" },
    { re: /^(?:please\s+)?make sure\s+(?:you\s+)?(?:always\s+)?(.+)$/i, label: "User Preference" },
    { re: /^(?:for\s+me|for\s+this\s+workspace),?\s*(.+)$/i, label: "User Preference" },
    // procedural / contextual rules stated by the user
    { re: /^whenever\s+(?:i|you|we)\s+(?:ask|need|request|want)\s+(.+)$/i, label: "Procedural Rule" },
    { re: /^whenever\s+(.+)$/i, label: "Procedural Rule" },
    { re: /^when\s+(?:reviewing|working on|implementing|writing|reading|analyzing|checking)\s+(.+)$/i, label: "Procedural Rule" },
    { re: /^(?:please\s+)?(?:always\s+)?follow\s+(?:this|these)\s+(?:checklist|format|steps?|procedure|rule)\b(.*)$/i, label: "Procedural Rule" },
    { re: /^(?:for\s+)?(?:every|all)\s+(.+?),?\s+(?:please\s+)?(?:always\s+)?(?:check|follow|use|include|apply)\s+(.+)$/i, label: "Procedural Rule" },
  ];
  for (const { re, label } of patterns) {
    const match = raw.match(re);
    // for multi-group patterns take first non-null capture group
    const captured = match?.slice(1).filter(Boolean).join(" ").trim();
    if (!captured) continue;
    const preference = clip(captured, 180);
    if (!preference) continue;
    return {
      fingerprint: `preference:${slugify(preference)}`,
      title: `${label}: ${preference}`,
      summary: preference,
      note: preference,
    };
  }
  return null;
}

function detectPlaybookSignal(input: InteractionInput): PlaybookSignal | null {
  const message = collapseWhitespace(input.message).toLowerCase();
  const response = collapseWhitespace(input.response);
  const combined = `${message}\n${response}`.toLowerCase();
  const patterns: Array<{ test: RegExp; fingerprint: string; scope: string; title: string; summary: string }> = [
    {
      test: /leadership council|execution orchestration|specialist contributions|member opinions/,
      fingerprint: "playbook:org-collaboration",
      scope: "organization",
      title: "Org Collaboration Routing",
      summary: "Successful organization work routed through council for discussion or execution orchestration for delivery.",
    },
    {
      test: /\bcreated workflow\b|\bworkflow generated\b|\bworkflow import(ed)?\b|\bworkflow export(ed)?\b/,
      fingerprint: "playbook:workflow-control",
      scope: "workflow",
      title: "Workflow Control From Plain English",
      summary: "Successful plain-English workflow creation, generation, import, or export.",
    },
    {
      test: /\bschedule created\b|\bcron\b|\brun now\b/,
      fingerprint: "playbook:scheduler-control",
      scope: "scheduler",
      title: "Scheduler Control From Plain English",
      summary: "Successful plain-English schedule creation or execution.",
    },
    {
      test: /\bdata source\b|\bdocument created\b|\buploaded\b|\bscraped\b|\bcrawled\b/,
      fingerprint: "playbook:data-source-control",
      scope: "data-source",
      title: "Data Source Control From Plain English",
      summary: "Successful plain-English data source creation or follow-up task generation.",
    },
    {
      test:
        /\b(?:enable(?:d)?|disable(?:d)?|assign(?:ed)?|switch(?:ed)?|set|change(?:d)?|make|made)\b.*\b(?:agent|for agent)\b.*\b(?:skill|skills|extension|extensions|provider|model)\b|\b(?:agent|for agent)\b.*\b(?:now uses|uses|use)\b.*\b(?:skill|skills|extension|extensions|provider|model)\b|\b(?:enable(?:d)?|disable(?:d)?)\b.*\b(?:skill|skills|extension|extensions)\b.*\b(?:for|on)\b.*\bagent\b/,
      fingerprint: "playbook:agent-capability-control",
      scope: "agent",
      title: "Agent Capability Assignment",
      summary: "Successful plain-English assignment of provider, skills, or extensions to an agent.",
    },
    {
      test: /\bexported organization\b|\bimported organization\b|\borg pack\b|\bcompany package\b/,
      fingerprint: "playbook:org-pack-control",
      scope: "organization",
      title: "Organization Pack Management",
      summary: "Successful plain-English export or import of an organization pack.",
    },
    {
      test: /\bimported external skill library\b|\bimported workspace skill library\b|\bexternal skill pack\b/,
      fingerprint: "playbook:ecosystem-import",
      scope: "skills",
      title: "External Ecosystem Import",
      summary: "Successful import of external skills into disp8ch skill packs.",
    },
  ];

  const matched = patterns.find((pattern) => pattern.test.test(combined));
  if (!matched) return null;
  return {
    fingerprint: matched.fingerprint,
    scope: matched.scope,
    scopeId: input.agentId ?? null,
    title: matched.title,
    summary: matched.summary,
  };
}

async function loadLearningEvents(eventIds: string[]): Promise<LearningEventRecord[]> {
  if (eventIds.length === 0) return [];
  initializeDatabase();
  const db = getSqlite();
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, kind, fingerprint, scope, scope_id, title, summary, evidence_json, created_at
    FROM learning_events
    WHERE id IN (${placeholders})
    ORDER BY created_at ASC
  `).all(...eventIds) as LearningEventRow[];
  return rows.map(mapEventRow);
}

type LearningModelConfig = {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
} | null;

type ScoredModel = {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  costScore: number;
};

/**
 * Resolve the cheapest available model for LLM-based learning reviews.
 * Expands each configured provider to its full catalog so a user who only
 * added an expensive model (e.g. Claude Opus) still gets reviewed with the
 * cheapest model available under that API key (e.g. Claude Haiku).
 * Scoped ONLY to this function — does not affect any other model resolution.
 */
function resolveLearningModel(): LearningModelConfig {
  initializeDatabase();
  const db = getSqlite();

  // Step 1: Get all active model rows to extract per-provider credentials
  const rows = db.prepare(`
    SELECT provider, model_id, api_key, base_url
    FROM models
    WHERE is_active = 1
  `).all() as Array<{
    provider: string;
    model_id: string;
    api_key: string;
    base_url?: string | null;
  }>;

  // Step 2: Collect one valid credential per provider (first valid one wins)
  const providerCreds = new Map<string, { apiKey: string; baseUrl?: string }>();
  for (const row of rows) {
    if (providerCreds.has(row.provider)) continue;
    const auth = resolveModelApiKey({ provider: row.provider, storedApiKey: row.api_key });
    if (!auth.apiKey && !isProviderLocallyHosted(row.provider)) continue;
    providerCreds.set(row.provider, {
      apiKey: auth.apiKey,
      baseUrl:
        normalizeProviderBaseUrl(row.provider, row.base_url ?? undefined) ??
        row.base_url ??
        undefined,
    });
  }

  // Step 3: Expand each provider to its full catalog and score by actual cost
  const candidates: ScoredModel[] = [];
  for (const [provider, cred] of providerCreds) {
    const plugin = getProviderPlugin(provider);
    const catalogModels = plugin?.models ?? [];

    if (isProviderLocallyHosted(provider)) {
      // Local providers: use the user's configured model (catalog is dynamic)
      const userRow = rows.find((r) => r.provider === provider);
      if (userRow) {
        candidates.push({
          provider,
          modelId: userRow.model_id,
          apiKey: cred.apiKey,
          baseUrl: cred.baseUrl,
          costScore: 0, // free
        });
      }
      continue;
    }

    if (catalogModels.length === 0) {
      // No catalog (unknown openai-compatible etc.) — use user's configured model
      const userRow = rows.find((r) => r.provider === provider);
      if (userRow) {
        const pricing = getModelPricing(userRow.model_id);
        candidates.push({
          provider,
          modelId: userRow.model_id,
          apiKey: cred.apiKey,
          baseUrl: cred.baseUrl,
          costScore: pricing ? pricing.inputPerMillion + pricing.outputPerMillion : 5,
        });
      }
      continue;
    }

    // Score each catalog model by actual cost — skip legacy models
    for (const catalogModel of catalogModels) {
      if (catalogModel.status === "legacy") continue;
      const pricing = getModelPricing(catalogModel.id);
      candidates.push({
        provider,
        modelId: catalogModel.id,
        apiKey: cred.apiKey,
        baseUrl: cred.baseUrl,
        costScore: pricing ? pricing.inputPerMillion + pricing.outputPerMillion : 5,
      });
    }
  }

  // Step 4: Pick the cheapest
  candidates.sort((a, b) => a.costScore - b.costScore);
  const best = candidates[0];
  if (!best) return null;

  return {
    provider: best.provider,
    modelId: best.modelId,
    apiKey: best.apiKey,
    baseUrl: best.baseUrl,
  };
}

const SEMANTIC_DEDUP_THRESHOLD = 0.55;

function jaccardWordSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

function findSimilarLearningNoteId(newNote: string): string | null {
  const existing = getMainMemoryLearningNotes();
  for (const entry of existing) {
    if (jaccardWordSimilarity(newNote, entry.note) >= SEMANTIC_DEDUP_THRESHOLD) {
      return entry.id;
    }
  }
  return null;
}

type UserProfileSignal = {
  field: string;
  value: string;
};

function detectUserProfileSignal(message: string): UserProfileSignal | null {
  const raw = collapseWhitespace(message);
  if (!raw) return null;
  const patterns: Array<{ re: RegExp; field: string }> = [
    { re: /^my (?:name) is (.+)$/i, field: "Name" },
    { re: /^my (?:role|title|job) is (.+)$/i, field: "Role" },
    { re: /^my (?:timezone|tz) is (.+)$/i, field: "Timezone" },
    { re: /^my (?:location|city|country) is (.+)$/i, field: "Location" },
    { re: /^my (?:team|company|org) is (.+)$/i, field: "Company" },
    { re: /^i(?:'m| am) (?:a|an) (.+)$/i, field: "Role" },
    { re: /^call me (.+)$/i, field: "Name" },
    { re: /^i (?:work|live) (?:at|in|from) (.+)$/i, field: "Location" },
  ];
  for (const { re, field } of patterns) {
    const match = raw.match(re);
    const value = match?.[1]?.trim();
    if (!value) continue;
    const clipped = clip(value, 120);
    if (!shouldCaptureProfileValue(field, clipped)) continue;
    return { field, value: clipped };
  }
  return null;
}

function upsertUserProfileField(
  field: string,
  value: string,
  scope?: string,
): boolean {
  try {
    const guard = scanLearningWrite("user", `${field}: ${value}`);
    if (!guard.safe) {
      log.warn("Blocked USER.md profile write from learning loop", {
        field,
        findings: guard.findings.map((finding) => finding.label),
      });
      return false;
    }
    const workspaceDir = getWorkspaceDir(scope);
    const userMdPath = path.join(workspaceDir, "USER.md");
    if (!fs.existsSync(userMdPath)) return false;

    const existing = fs.readFileSync(userMdPath, "utf-8");
    const lines = existing.split("\n");

    // Find or locate ## Profile section
    const profileIdx = lines.findIndex((l) => /^##\s+Profile/i.test(l));

    if (profileIdx === -1) {
      // Append a new ## Profile section
      const updated = existing.trimEnd() + `\n\n## Profile\n- ${field}: ${value}\n`;
      fs.writeFileSync(userMdPath, updated, "utf-8");
      return true;
    }

    // Look for an existing "- Field: ..." line in the Profile section
    const fieldRe = new RegExp(`^-\\s+${field}:`, "i");
    let foundAt = -1;
    // Scan from profileIdx+1 until next ## heading or EOF
    for (let i = profileIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i] || "")) break;
      if (fieldRe.test(lines[i] || "")) {
        foundAt = i;
        break;
      }
    }

    if (foundAt !== -1) {
      if ((lines[foundAt] || "").trim() === `- ${field}: ${value}`) return false;
      lines[foundAt] = `- ${field}: ${value}`;
    } else {
      // Insert after ## Profile heading
      lines.splice(profileIdx + 1, 0, `- ${field}: ${value}`);
    }

    fs.writeFileSync(userMdPath, lines.join("\n"), "utf-8");
    return true;
  } catch (err) {
    log.warn("Failed to update USER.md profile field", { field, error: String(err) });
    return false;
  }
}

type WorkspaceContextSignal = {
  key: string;
  value: string;
};

function detectWorkspaceContextSignal(message: string): WorkspaceContextSignal | null {
  const raw = collapseWhitespace(message);
  if (!raw) return null;
  const patterns: Array<{ re: RegExp; key: string }> = [
    { re: /^(?:we(?:'re| are) using|we use|our stack (?:is|uses?))\s+(.+)$/i, key: "Stack" },
    { re: /^(?:our|this)\s+(?:project|app|codebase|repo)\s+(?:uses?|is built (?:with|on))\s+(.+)$/i, key: "Stack" },
    { re: /^our\s+(?:database|db)\s+is\s+(.+)$/i, key: "Database" },
    { re: /^our\s+(?:frontend|ui)\s+(?:is|uses?)\s+(.+)$/i, key: "Frontend" },
    { re: /^our\s+(?:backend|api|server)\s+(?:is|uses?)\s+(.+)$/i, key: "Backend" },
    { re: /^(?:this|our)\s+(?:project|workspace)\s+is\s+(?:called|named)\s+(.+)$/i, key: "Project" },
    { re: /^the\s+team\s+(?:uses?|is using)\s+(.+)$/i, key: "Team Tooling" },
    { re: /^(?:we(?:'re| are) building|working on)\s+(.+)$/i, key: "Project" },
  ];
  for (const { re, key } of patterns) {
    const match = raw.match(re);
    const value = match?.[1]?.trim();
    if (!value || value.length < 2) continue;
    const clipped = clip(value, 120);
    if (!shouldCaptureWorkspaceContextValue(key, clipped)) continue;
    return { key, value: clipped };
  }
  return null;
}

function upsertWorkspaceContextFact(key: string, value: string, scope?: string): boolean {
  try {
    const guard = scanLearningWrite("user", `${key}: ${value}`);
    if (!guard.safe) {
      log.warn("Blocked USER.md workspace write from learning loop", {
        key,
        findings: guard.findings.map((finding) => finding.label),
      });
      return false;
    }
    const workspaceDir = getWorkspaceDir(scope);
    const userMdPath = path.join(workspaceDir, "USER.md");
    if (!fs.existsSync(userMdPath)) return false;

    const existing = fs.readFileSync(userMdPath, "utf-8");
    const lines = existing.split("\n");

    let sectionIdx = lines.findIndex((l) => /^##\s+Workspace Context/i.test(l));
    if (sectionIdx === -1) {
      const updated = existing.trimEnd() + `\n\n## Workspace Context\n- ${key}: ${value}\n`;
      fs.writeFileSync(userMdPath, updated, "utf-8");
      return true;
    }

    const fieldRe = new RegExp(`^-\\s+${key}:`, "i");
    let foundAt = -1;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i] || "")) break;
      if (fieldRe.test(lines[i] || "")) { foundAt = i; break; }
    }

    if (foundAt !== -1) {
      if ((lines[foundAt] || "").trim() === `- ${key}: ${value}`) return false;
      lines[foundAt] = `- ${key}: ${value}`;
    } else {
      lines.splice(sectionIdx + 1, 0, `- ${key}: ${value}`);
    }
    fs.writeFileSync(userMdPath, lines.join("\n"), "utf-8");
    return true;
  } catch (err) {
    log.warn("Failed to update USER.md workspace context", { key, error: String(err) });
    return false;
  }
}

// Session-scoped in-memory state for batched LLM review (resets on server restart).
// Each session keeps its own rolling turn window so separate chats do not influence
// each other's review timing or review inputs.
const RECENT_TURNS_BUFFER_MAX = 500;

const LLM_REVIEW_PROMPT = `Review the conversation below and extract at most 3 durable learnings.

Return ONLY a JSON array. No markdown. No prose. No code fences.

Allowed finding types:
- "preference": stable user preferences about tools, style, workflow, or how the assistant should behave
- "user-profile": durable facts about the user or team that belong in USER.md
- "playbook": a reusable non-trivial workflow or operating pattern worth turning into a learned skill

Each item must be an object with:
- "type": "preference" | "playbook" | "user-profile"
- "summary": one specific sentence
- "confidence": a number from 0.0 to 1.0

Keep only durable, reusable findings. Ignore:
- one-off requests
- transient states
- speculative guesses
- facts already obvious from the current turn alone unless they are clearly stable
- task progress, completed-work logs, PR/issue numbers, commit SHAs, phase status, temporary TODOs, and anything likely to be stale within 7 days
- imperative self-instructions; write durable memories as declarative facts instead

Good examples:
- {"type":"preference","summary":"The user prefers Python over JavaScript for automation tasks.","confidence":0.82}
- {"type":"user-profile","summary":"The user's timezone is UTC+8.","confidence":0.95}
- {"type":"playbook","summary":"For workspace migrations, first inspect the schema, then update the migration, then run the regression script before UI changes.","confidence":0.74}

Bad examples:
- {"type":"preference","summary":"The user asked for a fix in this message.","confidence":0.40}
- {"type":"playbook","summary":"The assistant answered the question.","confidence":0.20}
- {"type":"preference","summary":"Always run a specific benchmark regression after every change.","confidence":0.60}
- {"type":"user-profile","summary":"PR #123 fixed the memory bug.","confidence":0.70}

If nothing durable stands out, return [] exactly.`;

// Heuristic: message contains sentiment/preference words that regex might have missed.
// Used to trigger an early LLM review when no regex pattern matched.
function hasPotentialLearningSignal(message: string): boolean {
  if (message.length < 15) return false;
  return /\b(?:prefer|prefer(?:ably|red)?|rather|like|love|hate|dislike|don'?t like|wish|want|need|should|shouldn'?t|always|never|usually|typically|better|worse|easier|harder|faster|slower|annoying|frustrat|helpful|unhelpful|ideal|perfect|terrible|awful|great|stop|start|keep|avoid|use|switch|change|different|instead|next time|in the future|going forward|from now)\b/i.test(message);
}

async function maybeLlmReview(params: {
  message: string;
  response: string;
  agentId: string | null;
  sessionId: string;
  config: LearningConfig;
  forceEarly?: boolean;
}): Promise<void> {
  if (!params.config.enabled) return;
  if (!params.config.llmReviewEnabled) return;
  if (!params.sessionId) return;

  const state = getOrCreateLearningSessionState(params.sessionId, params.agentId);

  // Accumulate turn in the session-local buffer.
  state.recentTurns.push({ message: params.message, response: params.response });
  if (state.recentTurns.length > RECENT_TURNS_BUFFER_MAX) {
    state.recentTurns.shift();
  }

  // Early trigger: bypass the interval counter for this call, but don't reset the counter.
  // This fires a focused review of just the last few turns instead of the full buffer.
  if (params.forceEarly) {
    const model = resolveLearningModel();
    if (!model) return;
    const focusedTurns = state.recentTurns.slice(-3);
    const focusedText = focusedTurns
      .map((turn, i) => `Turn ${i + 1}\nUser: ${clip(turn.message, 150)}\nAssistant: ${clip(turn.response, 100)}`)
      .join("\n\n");
    try {
      const result = await callModel({
        provider: model.provider as any,
        modelId: model.modelId,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
        systemPrompt: LLM_REVIEW_PROMPT,
        userMessage: focusedText,
        maxTokens: 300,
        temperature: 0.2,
      });
      await processLlmFindings(result.response ?? "", params.agentId, params.sessionId, params.config);
    } catch (err) {
      log.warn("LLM early-trigger review failed", { error: String(err) });
    }
    return;
  }

  state.turnsSinceLastLlmReview += 1;
  if (state.turnsSinceLastLlmReview < params.config.llmReviewInterval) return;
  state.turnsSinceLastLlmReview = 0;

  const model = resolveLearningModel();
  if (!model) return; // no model available — regex-only mode, not an error

  const conversationText = state.recentTurns
    .map((turn, i) => `Turn ${i + 1}\nUser: ${clip(turn.message, 150)}\nAssistant: ${clip(turn.response, 100)}`)
    .join("\n\n");

  let rawResponse = "";
  try {
    const result = await callModel({
      provider: model.provider as any,
      modelId: model.modelId,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      systemPrompt: LLM_REVIEW_PROMPT,
      userMessage: conversationText,
      maxTokens: 500,
      temperature: 0.2,
    });
    rawResponse = result.response ?? "";
  } catch (err) {
    log.warn("LLM review call failed", { error: String(err) });
    return;
  }

  await processLlmFindings(rawResponse, params.agentId, params.sessionId, params.config);
}

async function processLlmFindings(
  rawResponse: string,
  agentId: string | null,
  sessionId: string,
  config: LearningConfig,
): Promise<void> {
  // Parse JSON — strip code fences if present
  let findings: LlmLearningFinding[] = [];
  try {
    const cleaned = rawResponse.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) {
      findings = parsed
        .filter(
          (item): item is { type: string; summary: string; confidence: number } =>
            item !== null &&
            typeof item === "object" &&
            typeof (item as any).type === "string" &&
            typeof (item as any).summary === "string",
        )
        .map((item) => ({
          type: String(item.type).toLowerCase(),
          summary: normalizeLearningSummary(String(item.summary)),
          confidence: Math.min(0.9, Math.max(0, Number(item.confidence) || 0.6)),
        }))
        .filter(shouldKeepLlmFinding);
    }
  } catch {
    return; // malformed JSON — silent no-op
  }

  for (const finding of findings) {
    if (!finding.summary) continue;

    if (finding.type === "user-profile") {
      // Route to USER.md — pick field name from summary heuristically
      const fieldMatch = finding.summary.match(/^(?:user(?:'s)?|the user(?:'s)?)\s+(\w+)\s+is\s+(.+)$/i);
      if (fieldMatch) {
        if (shouldCaptureProfileValue(fieldMatch[1], fieldMatch[2])) {
          const changed = upsertUserProfileField(fieldMatch[1], fieldMatch[2]);
          if (changed && config.showFeedback) {
            enqueueLearningNotification(sessionId, {
              kind: "profile",
              field: fieldMatch[1],
              summary: fieldMatch[2],
            });
          }
          await recordLearningEvent({
            kind: "user-profile",
            fingerprint: `llm-profile:${slugify(finding.summary)}`,
            scope: "user",
            scopeId: sessionId,
            title: `User Profile: ${clip(finding.summary, 60)}`,
            summary: finding.summary,
            evidence: { sessionId, agentId, source: "llm-review" },
            confidence: finding.confidence,
            config,
            createCandidate: false,
          });
        }
      }
      continue;
    }

    if (finding.type === "preference") {
      await recordLearningEvent({
        kind: "user-preference",
        fingerprint: `llm-pref:${slugify(finding.summary)}`,
        scope: "user",
        scopeId: sessionId,
        title: `LLM Preference: ${clip(finding.summary, 60)}`,
        summary: finding.summary,
        evidence: { sessionId, agentId, source: "llm-review" },
        candidateKind: "memory-note",
        confidence: finding.confidence,
        config,
      });
      if (config.showFeedback) {
        enqueueLearningNotification(sessionId, {
          kind: "llm-finding",
          summary: finding.summary,
        });
      }
      continue;
    }

    if (finding.type === "playbook") {
      await recordLearningEvent({
        kind: "playbook",
        fingerprint: `llm-playbook:${slugify(finding.summary)}`,
        scope: "workspace",
        scopeId: agentId,
        title: `LLM Playbook: ${clip(finding.summary, 60)}`,
        summary: finding.summary,
        evidence: { sessionId, agentId, source: "llm-review" },
        candidateKind: "workspace-skill",
        confidence: finding.confidence,
        config,
      });
      if (config.showFeedback) {
        enqueueLearningNotification(sessionId, {
          kind: "playbook",
          summary: finding.summary,
        });
      }
    }
  }
}

async function synthesizeSkillMarkdown(
  candidate: LearningCandidateRecord,
  events: LearningEventRecord[],
): Promise<string> {
  const model = resolveLearningModel();
  const evidenceLines = events.map((event, index) => {
    const message = clip(String(event.evidence.message || ""), 180);
    const response = clip(String(event.evidence.response || ""), 180);
    return `${index + 1}. Message: ${message}\nResponse: ${response}`;
  }).join("\n\n");

  if (model) {
    try {
      const result = await callModel({
        provider: model.provider as any,
        modelId: model.modelId,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
        systemPrompt:
          "You create concise reusable disp8ch skills from repeated successful evidence. Return markdown only. Structure: # Title, ## Use When, ## Playbook, ## Guardrails, ## Evidence. No code fences.",
        userMessage: [
          `Title: ${candidate.title}`,
          `Summary: ${candidate.summary}`,
          "",
          "Evidence:",
          evidenceLines || "- No detailed evidence captured.",
          "",
          "Make the playbook actionable for a disp8ch agent operating inside WebChat, workflows, or hierarchy execution.",
        ].join("\n"),
        maxTokens: 900,
        temperature: 0.2,
      });
      const markdown = collapseWhitespace(result.response).includes("#")
        ? result.response.trim()
        : "";
      if (markdown) {
        const scan = scanSkillContent(markdown);
        if (!scan.safe) {
          log.warn("LLM-synthesized skill content failed security scan — using heuristic fallback", {
            candidateId: candidate.id,
            threats: scan.threats,
          });
        } else {
          return `${markdown}\n\n<!-- generated-by: ${model.provider}:${model.modelId} -->\n`;
        }
      }
    } catch (error) {
      log.warn("Learning skill synthesis fell back to template", {
        candidateId: candidate.id,
        error: String(error),
      });
    }
  }

  return [
    `# ${candidate.title}`,
    "",
    "## Use When",
    candidate.summary,
    "",
    "## Playbook",
    "1. Confirm the user intent from the successful evidence pattern.",
    "2. Reuse the same app surface or org routing path that previously worked.",
    "3. Keep the response structured and call out the next concrete step.",
    "",
    "## Guardrails",
    "- Prefer builtin app-control routes before generic tool use.",
    "- Keep the action scoped to the user request and existing app state.",
    "- Escalate with a clarifying question only when local resolution is ambiguous.",
    "",
    "## Evidence",
    ...events.map((event) => `- ${event.summary} (${event.createdAt})`),
    "",
    "<!-- generated-by: heuristic-fallback -->",
  ].join("\n");
}

function getRecentlyActiveLearningFingerprints(): Set<string> {
  try {
    initializeDatabase();
    const db = getSqlite();
    const rows = db.prepare(`
      SELECT DISTINCT fingerprint
      FROM learning_events
      WHERE created_at > datetime('now', '-30 days')
    `).all() as Array<{ fingerprint: string }>;
    return new Set(rows.map((r) => r.fingerprint));
  } catch {
    return new Set();
  }
}

export async function promoteLearningCandidate(reference: string): Promise<LearningCandidateRecord> {
  const candidate = getLearningCandidate(reference);
  if (!candidate) {
    throw new Error(`Learning candidate not found: ${reference}`);
  }
  if (candidate.status === "promoted") return candidate;
  const now = new Date().toISOString();
  let targetPath: string | null = candidate.targetPath ?? null;
  let content = candidate.content ?? null;

  if (candidate.kind === "memory-note") {
    const guard = scanLearningWrite("memory", candidate.summary);
    if (!guard.safe) {
      throw new Error(
        `Memory promotion blocked by guard: ${guard.findings.map((finding) => finding.label).join(", ")}`,
      );
    }
    const similarId = findSimilarLearningNoteId(candidate.summary);
    // Use a short 12-char MD5 hash as the stable, compact ID for new entries.
    const shortHash = createHash("md5").update(candidate.fingerprint).digest("hex").slice(0, 12);
    appendMainMemoryNote(candidate.summary, {
      id: similarId ?? `learning:${shortHash}`,
      source: "learning-loop",
      confidence: Math.min(0.99, Math.max(0.10, candidate.confidence)),
    });
    const recentFingerprints = getRecentlyActiveLearningFingerprints();
    pruneLearningLoopMemoryNotes({ maxEntries: LEARNING_MEMORY_NOTE_MAX_ENTRIES, pinnedFingerprints: recentFingerprints });
    targetPath = path.join(getWorkspaceDir(), "MEMORY.md");
    content = candidate.summary;
  } else {
    const events = await loadLearningEvents(candidate.sourceEventIds);
    const markdown = await synthesizeSkillMarkdown(candidate, events);
    const scan = scanSkillContent(markdown);
    if (!scan.safe) {
      throw new Error(`Skill promotion blocked by security scan: ${scan.threats.join(", ")}`);
    }
    const workspaceDir = getWorkspaceDir();
    ensureWorkspaceScaffold({ workspacePath: workspaceDir });
    const skillDir = path.join(workspaceDir, "skills", `learned-${slugify(candidate.title) || candidate.id}`);
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillPath, `${markdown.trimEnd()}\n`, "utf8");
    const metadataPath = path.join(skillDir, "learning.json");
    fs.writeFileSync(
      metadataPath,
      `${JSON.stringify(
        {
          id: candidate.id,
          title: candidate.title,
          summary: candidate.summary,
          evidenceCount: candidate.evidenceCount,
          sourceEventIds: candidate.sourceEventIds,
          promotedAt: now,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    targetPath = skillPath;
    content = markdown;
  }

  withSqliteWriteRecovery("learning-candidate:promote", (db) => {
    db.prepare(`
      UPDATE learning_candidates
      SET status = 'promoted',
          content = ?,
          target_path = ?,
          promoted_at = ?,
          last_synthesized_evidence_count = ?,
          updated_at = ?
      WHERE id = ?
    `).run(content, targetPath, now, candidate.kind === "workspace-skill" ? candidate.evidenceCount : null, now, candidate.id);
  });

  pruneLearningDatabaseState();

  return getLearningCandidate(candidate.id) as LearningCandidateRecord;
}

// Re-synthesize a promoted workspace-skill when enough new evidence has accumulated.
// Fires fire-and-forget from upsertCandidateFromEvent — never blocks the caller.
const SKILL_RESYNTH_EVIDENCE_DELTA = 3;

async function resynthesizePromotedSkill(candidate: LearningCandidateRecord): Promise<void> {
  if (candidate.kind !== "workspace-skill") return;
  if (!candidate.targetPath) return;
  const skillDir = path.dirname(candidate.targetPath);
  if (!fs.existsSync(skillDir)) return;

  try {
    const events = await loadLearningEvents(candidate.sourceEventIds);
    const markdown = await synthesizeSkillMarkdown(candidate, events);
    const scan = scanSkillContent(markdown);
    if (!scan.safe) {
      logger.warn(`[learning] Skill re-synthesis blocked by security scan (${candidate.fingerprint}): ${scan.threats.join(", ")}`);
      return;
    }
    fs.writeFileSync(candidate.targetPath, `${markdown.trimEnd()}\n`, "utf8");
    const metadataPath = path.join(skillDir, "learning.json");
    fs.writeFileSync(
      metadataPath,
      `${JSON.stringify(
        {
          id: candidate.id,
          title: candidate.title,
          summary: candidate.summary,
          evidenceCount: candidate.evidenceCount,
          sourceEventIds: candidate.sourceEventIds,
          promotedAt: candidate.promotedAt,
          resynthesizedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    withSqliteWriteRecovery("learning-candidate:resynth", (db) => {
      db.prepare(`
        UPDATE learning_candidates
        SET last_synthesized_evidence_count = ?, updated_at = ?
        WHERE id = ?
      `).run(candidate.evidenceCount, new Date().toISOString(), candidate.id);
    });
    logger.info(`[learning] Skill re-synthesized: ${candidate.title} (evidence: ${candidate.evidenceCount})`);
  } catch (err) {
    logger.warn(`[learning] Skill re-synthesis failed (${candidate.fingerprint}): ${String(err)}`);
  }
}

export function dismissLearningCandidate(reference: string): LearningCandidateRecord {
  const candidate = getLearningCandidate(reference);
  if (!candidate) {
    throw new Error(`Learning candidate not found: ${reference}`);
  }
  const now = new Date().toISOString();
  withSqliteWriteRecovery("learning-candidate:dismiss", (db) => {
    db.prepare(`
      UPDATE learning_candidates
      SET status = 'dismissed',
          updated_at = ?
      WHERE id = ?
    `).run(now, candidate.id);
  });
  pruneLearningDatabaseState();
  return getLearningCandidate(candidate.id) as LearningCandidateRecord;
}

async function upsertCandidateFromEvent(params: {
  kind: LearningCandidateKind;
  fingerprint: string;
  scope: string;
  scopeId: string | null;
  title: string;
  summary: string;
  eventId: string;
  confidence: number;
  config: LearningConfig;
}): Promise<LearningCandidateRecord> {
  initializeDatabase();
  const db = getSqlite();
  const existingRow = db.prepare(`
    SELECT *
    FROM learning_candidates
    WHERE fingerprint = ?
    LIMIT 1
  `).get(params.fingerprint) as LearningCandidateRow | undefined;
  const now = new Date().toISOString();

  if (!existingRow) {
    const id = nanoid(12);
    withSqliteWriteRecovery("learning-candidate:create", (writer) => {
      writer.prepare(`
        INSERT INTO learning_candidates (
          id, fingerprint, status, kind, scope, scope_id, title, summary, content, confidence,
          evidence_count, source_event_ids, target_path, promoted_at, created_at, updated_at
        ) VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?, NULL, ?, 1, ?, NULL, NULL, ?, ?)
      `).run(
        id,
        params.fingerprint,
        params.kind,
        params.scope,
        params.scopeId,
        params.title,
        params.summary,
        params.confidence,
        JSON.stringify([params.eventId]),
        now,
        now,
      );
    });
  } else if (existingRow.status === "dismissed") {
    withSqliteWriteRecovery("learning-candidate:revive", (writer) => {
      writer.prepare(`
        UPDATE learning_candidates
        SET status = 'proposed',
            kind = ?,
            scope = ?,
            scope_id = ?,
            title = ?,
            summary = ?,
            content = NULL,
            confidence = ?,
            evidence_count = 1,
            source_event_ids = ?,
            target_path = NULL,
            promoted_at = NULL,
            last_synthesized_evidence_count = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(
        params.kind,
        params.scope,
        params.scopeId,
        params.title,
        params.summary,
        params.confidence,
        JSON.stringify([params.eventId]),
        now,
        existingRow.id,
      );
    });
  } else {
    const existing = mapCandidateRow(existingRow);
    const nextEvents = Array.from(new Set([...existing.sourceEventIds, params.eventId]));
    const nextCount = existing.evidenceCount + 1;
    const nextConfidence = Math.min(0.99, Math.max(existing.confidence, params.confidence) + 0.05);
    withSqliteWriteRecovery("learning-candidate:update", (writer) => {
      writer.prepare(`
        UPDATE learning_candidates
        SET title = ?,
            summary = ?,
            confidence = ?,
            evidence_count = ?,
            source_event_ids = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        params.title,
        params.summary,
        nextConfidence,
        nextCount,
        JSON.stringify(nextEvents),
        now,
        existing.id,
      );
    });
  }

  const candidate = getLearningCandidate(params.fingerprint) as LearningCandidateRecord;

  // Re-synthesize promoted workspace-skills when enough new evidence has accumulated
  if (
    existingRow &&
    candidate.status === "promoted" &&
    candidate.kind === "workspace-skill" &&
    candidate.lastSynthesizedEvidenceCount !== null &&
    candidate.evidenceCount - candidate.lastSynthesizedEvidenceCount >= SKILL_RESYNTH_EVIDENCE_DELTA
  ) {
    void resynthesizePromotedSkill(candidate).catch((err) => {
      logger.warn(`[learning] Background skill re-synthesis error: ${String(err)}`);
    });
  }

  const shouldAutoPromote =
    params.config.enabled &&
    params.config.mode === "auto" &&
    candidate.status === "proposed" &&
    candidate.evidenceCount >= params.config.autoPromoteThreshold;

  if (shouldAutoPromote) {
    return promoteLearningCandidate(candidate.id);
  }
  return candidate;
}

async function recordLearningEvent(params: {
  kind: LearningEventKind;
  fingerprint: string;
  scope: string;
  scopeId?: string | null;
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  candidateKind?: LearningCandidateKind;
  confidence: number;
  config: LearningConfig;
  createCandidate?: boolean;
}): Promise<{ event: LearningEventRecord; candidate: LearningCandidateRecord | null }> {
  const eventId = nanoid(12);
  const now = new Date().toISOString();
  withSqliteWriteRecovery("learning-event:create", (db) => {
    db.prepare(`
      INSERT INTO learning_events (
        id, kind, fingerprint, scope, scope_id, title, summary, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      params.kind,
      params.fingerprint,
      params.scope,
      params.scopeId ?? null,
      params.title,
      params.summary,
      JSON.stringify(params.evidence),
      now,
    );
  });
  const event = listLearningEvents(200).find((candidate) => candidate.id === eventId) as LearningEventRecord;
  let candidate: LearningCandidateRecord | null = null;
  if (params.createCandidate !== false && params.candidateKind) {
    candidate = await upsertCandidateFromEvent({
      kind: params.candidateKind,
      fingerprint: params.fingerprint,
      scope: params.scope,
      scopeId: params.scopeId ?? null,
      title: params.title,
      summary: params.summary,
      eventId,
      confidence: params.confidence,
      config: params.config,
    });
  }
  pruneLearningDatabaseState();
  return { event, candidate };
}

export async function captureLearningFromChannelInteraction(input: InteractionInput): Promise<void> {
  const config = getLearningConfig();
  if (!config.enabled) return;

  // Regex-based preference detection (instant, zero-cost)
  const preference = config.capturePreferences ? detectPreferenceSignal(input.message) : null;
  if (preference) {
    await recordLearningEvent({
      kind: "user-preference",
      fingerprint: preference.fingerprint,
      scope: "user",
      scopeId: input.sessionId,
      title: preference.title,
      summary: preference.summary,
      evidence: {
        sessionId: input.sessionId,
        agentId: input.agentId,
        message: input.message,
        response: input.response,
        routeSource: input.routeSource,
      },
      candidateKind: "memory-note",
      confidence: 0.95,
      config,
    });
    if (config.showFeedback) {
      enqueueLearningNotification(input.sessionId, {
        kind: "preference",
        summary: clip(preference.summary, 80),
      });
    }
  }

  // User profile detection → USER.md (instant, zero-cost)
  const profileSignal = config.capturePreferences ? detectUserProfileSignal(input.message) : null;
  if (profileSignal && !preference) {
    // Only write to USER.md if regex didn't already capture this as a general preference
    const changed = upsertUserProfileField(profileSignal.field, profileSignal.value);
    if (changed) {
      await recordLearningEvent({
        kind: "user-profile",
        fingerprint: `profile:${slugify(`${profileSignal.field}:${profileSignal.value}`)}`,
        scope: "user",
        scopeId: input.sessionId,
        title: `Profile: ${profileSignal.field}`,
        summary: `User's ${profileSignal.field} is ${profileSignal.value}`,
        evidence: {
          sessionId: input.sessionId,
          agentId: input.agentId,
          message: input.message,
          response: input.response,
          routeSource: input.routeSource,
        },
        confidence: 0.95,
        config,
        createCandidate: false,
      });
      if (config.showFeedback) {
        enqueueLearningNotification(input.sessionId, {
          kind: "profile",
          field: profileSignal.field,
          summary: profileSignal.value,
        });
      }
    }
  }

  // Workspace context detection → USER.md Workspace Context section (instant, zero-cost)
  const wsSignal = config.capturePreferences ? detectWorkspaceContextSignal(input.message) : null;
  if (wsSignal && !preference && !profileSignal) {
    const changed = upsertWorkspaceContextFact(wsSignal.key, wsSignal.value);
    if (changed) {
      await recordLearningEvent({
        kind: "workspace-context",
        fingerprint: `workspace:${slugify(`${wsSignal.key}:${wsSignal.value}`)}`,
        scope: "workspace",
        scopeId: input.agentId,
        title: `Workspace Context: ${wsSignal.key}`,
        summary: `${wsSignal.key}: ${wsSignal.value}`,
        evidence: {
          sessionId: input.sessionId,
          agentId: input.agentId,
          message: input.message,
          response: input.response,
          routeSource: input.routeSource,
        },
        confidence: 0.9,
        config,
        createCandidate: false,
      });
      if (config.showFeedback) {
        enqueueLearningNotification(input.sessionId, {
          kind: "workspace",
          field: wsSignal.key,
          summary: wsSignal.value,
        });
      }
    }
  }

  // Playbook detection (instant, zero-cost)
  const playbook = config.capturePlaybooks ? detectPlaybookSignal(input) : null;
  if (playbook) {
    await recordLearningEvent({
      kind: "playbook",
      fingerprint: playbook.fingerprint,
      scope: playbook.scope,
      scopeId: playbook.scopeId,
      title: playbook.title,
      summary: playbook.summary,
      evidence: {
        sessionId: input.sessionId,
        agentId: input.agentId,
        message: input.message,
        response: input.response,
        routeSource: input.routeSource,
      },
      candidateKind: "workspace-skill",
      confidence: 0.7,
      config,
    });
    if (config.showFeedback) {
      enqueueLearningNotification(input.sessionId, {
        kind: "playbook",
        summary: playbook.title,
      });
    }
  }

  // LLM review — fire-and-forget, never blocks response.
  // If regex/profile/workspace didn't capture anything but the message looks like it
  // might carry a learning signal, trigger an early focused review of the last few turns
  // instead of waiting for the N-turn interval. This is the key improvement over pure
  // regex-only detection — LLM catches implicit signals that patterns miss.
  const regexCaptured = !!(preference || profileSignal || wsSignal || playbook);
  const earlyTrigger = !regexCaptured && config.llmReviewEnabled && hasPotentialLearningSignal(input.message);
  void maybeLlmReview({
    message: input.message,
    response: input.response,
    agentId: input.agentId,
    sessionId: input.sessionId,
    config,
    forceEarly: earlyTrigger,
  }).catch((err) => {
    log.warn("LLM review background error", { error: String(err) });
  });

  // evidence-rich self-learning review: also writes durable skill/memory/test
  // proposals. Uses the same evidence (conversation + tool trace when the
  // route was agentic) but is gated by `shouldRunSelfLearningReview` so it
  // only fires on meaningful agentic or corrective turns.
  if (input.routeSource && /^agentic:/i.test(String(input.routeSource))) {
    const routeSource = String(input.routeSource);
    void runBackgroundSkillReviewFromLearning({
      sessionId: input.sessionId,
      agentId: input.agentId ?? null,
      routeSource,
      message: input.message,
      response: input.response,
    }).catch((err) => {
      log.warn("Self-learning reviewer background error", { error: String(err) });
    });
  }
}

async function runBackgroundSkillReviewFromLearning(input: {
  sessionId: string;
  agentId: string | null;
  routeSource: string;
  message: string;
  response: string;
}): Promise<void> {
  if (!input.sessionId) return;
  const { getSqlite, initializeDatabase } = await import("@/lib/db");
  initializeDatabase();
  const db = getSqlite();
  const rows = db
    .prepare(
      `SELECT role, content
         FROM messages
        WHERE session_id = ?
          AND role IN ('user', 'assistant')
        ORDER BY created_at DESC
        LIMIT 12`,
    )
    .all(input.sessionId) as Array<{ role: string; content: string }>;
  if (rows.length < 2) return;
  const conversation = rows.reverse().map((row) => ({ role: row.role, content: row.content }));
  const model = resolveLearningModel();
  if (!model) return;
  const { runSelfLearningReview, persistSelfLearningProposals, shouldRunSelfLearningReview } = await import(
    "@/lib/learning/self-learning-reviewer"
  );
  if (!shouldRunSelfLearningReview({ routeSource: input.routeSource, message: input.message })) return;
  const proposals = await runSelfLearningReview(
    {
      sessionId: input.sessionId,
      agentId: input.agentId,
      conversation,
      routeSource: input.routeSource,
      learningMode: "review",
    },
    model,
  );
  if (proposals.length === 0) return;
  await persistSelfLearningProposals(proposals, input.sessionId);
}

const READY_FOR_PROMOTION_THRESHOLD = 3;

export function formatLearningStatusMarkdown(): string {
  const config = getLearningConfig();
  const candidates = listLearningCandidates("all");
  const events = listLearningEvents(LEARNING_EVENT_MAX_ROWS + 20);
  const proposed = candidates.filter((candidate) => candidate.status === "proposed");
  const promoted = candidates.filter((candidate) => candidate.status === "promoted");
  const readyForPromotion = proposed.filter(
    (candidate) => candidate.evidenceCount >= READY_FOR_PROMOTION_THRESHOLD,
  );
  const latest = candidates[0] ?? null;

  // 30-day activity stats
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recentEvents = events.filter((e) => e.createdAt >= thirtyDaysAgo);
  const recentPromoted = promoted.filter((c) => c.promotedAt && c.promotedAt >= thirtyDaysAgo);
  const recentProposed = proposed.filter((c) => c.createdAt >= thirtyDaysAgo);

  // Current MEMORY.md learning note count
  const memoryNotes = getMainMemoryLearningNotes();
  const estimatedChars = memoryNotes.reduce((sum, n) => sum + 80 + n.note.length, 0);

  const lines = [
    "## Learning Loop",
    `**Enabled:** ${config.enabled ? "yes" : "no"}`,
    `**Mode:** ${config.mode}`,
    `**Capture user preferences:** ${config.capturePreferences ? "yes" : "no"}`,
    `**Capture playbooks:** ${config.capturePlaybooks ? "yes" : "no"}`,
    `**Auto-promote threshold:** ${config.autoPromoteThreshold}`,
    `**LLM review:** ${config.llmReviewEnabled ? `enabled (every ${config.llmReviewInterval} turns + immediate on potential signals)` : "disabled (regex-only)"}`,
    "",
    "### Candidate Summary",
    `- proposed: ${proposed.length}`,
    `- promoted: ${promoted.length}`,
    `- stored events: ${events.length}${events.length >= LEARNING_EVENT_MAX_ROWS ? "+" : ""}`,
    latest ? `- latest: ${latest.title} [${latest.status}]` : "- latest: none",
    "",
    "### 30-Day Activity",
    `- ${recentEvents.length} learning events captured`,
    `- ${recentProposed.length} new candidates proposed`,
    `- ${recentPromoted.length} candidates promoted to memory/skills`,
  ];

  if (readyForPromotion.length > 0) {
    lines.push(
      "",
      `### Ready for Promotion (evidence >= ${READY_FOR_PROMOTION_THRESHOLD})`,
      ...readyForPromotion.slice(0, 8).map(
        (candidate) =>
          `- **${candidate.title}** · evidence=${candidate.evidenceCount} · confidence=${candidate.confidence.toFixed(2)} · id=${candidate.id}`,
      ),
      "",
      'These candidates have strong evidence. Use "promote learning candidate <id>" to accept.',
    );
  }

  lines.push(
    "",
    "### Retention Policy",
    `- MEMORY.md active learning notes: ${memoryNotes.length}/${LEARNING_MEMORY_NOTE_MAX_ENTRIES} (~${estimatedChars} chars)`,
    `- Notes older than 60 days have confidence halved each cycle (floor 0.10); at floor they are archived`,
    `- Cap: ${LEARNING_MEMORY_NOTE_MAX_ENTRIES} active entries; older ones archived to memory/learning-archive.md`,
    `- Learning events: latest ${LEARNING_EVENT_MAX_ROWS} rows kept unless still referenced by active candidates`,
    `- Dismissed candidates pruned after ${LEARNING_DISMISSED_CANDIDATE_MAX_AGE_DAYS} days or when queue exceeds ${LEARNING_DISMISSED_CANDIDATE_MAX_ROWS}`,
  );

  return lines.join("\n");
}
