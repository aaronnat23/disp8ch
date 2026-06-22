import { nanoid } from "nanoid";
import { defaultChannelAgentId, persistChannelEvent } from "@/lib/channels/transcript";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { scheduleSessionIndex } from "@/lib/memory/session-watcher";

export type SessionCompactionSkillEntry = {
  id: string;
  label: string;
};

export type SessionCompactionState = {
  sessionId: string;
  agentId: string;
  latestSummary: string | null;
  compactionCount: number;
  lastCompactedAt: string | null;
  lastFlushAt: string | null;
  lastFlushCycle: number;
  lastTokensBefore: number | null;
  lastTokensAfter: number | null;
  recentSkills: SessionCompactionSkillEntry[];
  updatedAt: string;
};

type StateRow = {
  session_id: string;
  agent_id: string;
  latest_summary: string | null;
  compaction_count: number;
  last_compacted_at: string | null;
  last_flush_at: string | null;
  last_flush_cycle: number;
  last_tokens_before: number | null;
  last_tokens_after: number | null;
  recent_skills_json: string | null;
  updated_at: string;
};

function normalizeAgentId(agentId?: string | null): string {
  return String(agentId || defaultChannelAgentId()).trim() || defaultChannelAgentId();
}

function parseRecentSkills(value: string | null): SessionCompactionSkillEntry[] {
  try {
    const parsed = JSON.parse(String(value || "[]")) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SessionCompactionSkillEntry[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const id = String((item as { id?: unknown }).id || "").trim();
      const label = String((item as { label?: unknown }).label || "").trim();
      if (!id || !label || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label });
      if (out.length >= 8) break;
    }
    return out;
  } catch {
    return [];
  }
}

function rowToState(row: StateRow | undefined): SessionCompactionState | null {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    agentId: row.agent_id,
    latestSummary: row.latest_summary,
    compactionCount: Number(row.compaction_count || 0),
    lastCompactedAt: row.last_compacted_at,
    lastFlushAt: row.last_flush_at,
    lastFlushCycle: Number(row.last_flush_cycle ?? -1),
    lastTokensBefore: row.last_tokens_before == null ? null : Number(row.last_tokens_before),
    lastTokensAfter: row.last_tokens_after == null ? null : Number(row.last_tokens_after),
    recentSkills: parseRecentSkills(row.recent_skills_json),
    updatedAt: row.updated_at,
  };
}

export function getSessionCompactionState(
  sessionId: string | null | undefined,
  agentId?: string | null,
): SessionCompactionState | null {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) return null;
  initializeDatabase();
  const db = getSqlite();
  const row = db
    .prepare(
      `SELECT session_id,
              agent_id,
              latest_summary,
              compaction_count,
              last_compacted_at,
              last_flush_at,
              last_flush_cycle,
              last_tokens_before,
              last_tokens_after,
              recent_skills_json,
              updated_at
         FROM session_compaction_state
        WHERE session_id = ?
          AND agent_id = ?`,
    )
    .get(normalizedSessionId, normalizeAgentId(agentId)) as StateRow | undefined;
  return rowToState(row);
}

export function getLatestSessionCompactionSummary(
  sessionId: string | null | undefined,
  agentId?: string | null,
): string | null {
  return getSessionCompactionState(sessionId, agentId)?.latestSummary ?? null;
}

export function shouldRunSoftCompactionMemoryFlush(params: {
  sessionId: string | null | undefined;
  agentId?: string | null;
  tokensBefore: number;
  triggerTokens: number;
  softThresholdTokens: number;
}): boolean {
  const normalizedSessionId = String(params.sessionId || "").trim();
  if (!normalizedSessionId) return false;
  const triggerAt = Math.max(1, params.triggerTokens - Math.max(0, Math.floor(params.softThresholdTokens)));
  if (params.tokensBefore < triggerAt) return false;
  const state = getSessionCompactionState(normalizedSessionId, params.agentId);
  const currentCycle = state?.compactionCount ?? 0;
  return (state?.lastFlushCycle ?? -1) < currentCycle;
}

export function getRecentSessionCompactionSkills(
  sessionId: string | null | undefined,
  agentId?: string | null,
): SessionCompactionSkillEntry[] {
  return getSessionCompactionState(sessionId, agentId)?.recentSkills ?? [];
}

export function persistSessionCompactionSkills(params: {
  sessionId: string | null | undefined;
  agentId?: string | null;
  skills: SessionCompactionSkillEntry[];
}): SessionCompactionState | null {
  const sessionId = String(params.sessionId || "").trim();
  if (!sessionId) return null;
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();
  const agentId = normalizeAgentId(params.agentId);
  const current = getSessionCompactionState(sessionId, agentId);
  const nextSkills = parseRecentSkills(JSON.stringify(params.skills));

  db.prepare(
    `INSERT INTO session_compaction_state (
       session_id,
       agent_id,
       latest_summary,
       compaction_count,
       last_compacted_at,
       last_flush_at,
       last_flush_cycle,
       last_tokens_before,
       last_tokens_after,
       recent_skills_json,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, agent_id) DO UPDATE SET
       recent_skills_json = excluded.recent_skills_json,
       updated_at = excluded.updated_at`,
  ).run(
    sessionId,
    agentId,
    current?.latestSummary ?? null,
    current?.compactionCount ?? 0,
    current?.lastCompactedAt ?? null,
    current?.lastFlushAt ?? null,
    current?.lastFlushCycle ?? -1,
    current?.lastTokensBefore ?? null,
    current?.lastTokensAfter ?? null,
    JSON.stringify(nextSkills),
    now,
  );

  return getSessionCompactionState(sessionId, agentId);
}

export function markSessionMemoryFlush(params: {
  sessionId: string;
  agentId?: string | null;
  tokensBefore?: number | null;
}): void {
  const sessionId = String(params.sessionId || "").trim();
  if (!sessionId) return;
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();
  const agentId = normalizeAgentId(params.agentId);
  const current = getSessionCompactionState(sessionId, agentId);
  const cycle = current?.compactionCount ?? 0;
  db.prepare(
    `INSERT INTO session_compaction_state (
       session_id,
       agent_id,
       latest_summary,
       compaction_count,
       last_compacted_at,
       last_flush_at,
       last_flush_cycle,
       last_tokens_before,
       last_tokens_after,
       recent_skills_json,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, agent_id) DO UPDATE SET
       last_flush_at = excluded.last_flush_at,
       last_flush_cycle = excluded.last_flush_cycle,
       last_tokens_before = COALESCE(excluded.last_tokens_before, session_compaction_state.last_tokens_before),
       recent_skills_json = COALESCE(session_compaction_state.recent_skills_json, excluded.recent_skills_json),
       updated_at = excluded.updated_at`,
  ).run(
    sessionId,
    agentId,
    current?.latestSummary ?? null,
    cycle,
    current?.lastCompactedAt ?? null,
    now,
    cycle,
    params.tokensBefore ?? current?.lastTokensBefore ?? null,
    current?.lastTokensAfter ?? null,
    JSON.stringify(current?.recentSkills ?? []),
    now,
  );
}

export function persistSessionCompactionSummary(params: {
  sessionId: string | null | undefined;
  agentId?: string | null;
  summary: string;
  tokensBefore?: number | null;
  tokensAfter?: number | null;
  droppedMessages?: number | null;
  keptMessages?: number | null;
}): SessionCompactionState | null {
  const sessionId = String(params.sessionId || "").trim();
  const summary = String(params.summary || "").trim();
  if (!sessionId || !summary) return null;
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();
  const agentId = normalizeAgentId(params.agentId);
  const current = getSessionCompactionState(sessionId, agentId);
  const nextCount = (current?.compactionCount ?? 0) + 1;

  db.prepare(
    `INSERT INTO session_compaction_state (
       session_id,
       agent_id,
       latest_summary,
       compaction_count,
       last_compacted_at,
       last_flush_at,
       last_flush_cycle,
       last_tokens_before,
       last_tokens_after,
       recent_skills_json,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, agent_id) DO UPDATE SET
       latest_summary = excluded.latest_summary,
       compaction_count = excluded.compaction_count,
       last_compacted_at = excluded.last_compacted_at,
       last_tokens_before = excluded.last_tokens_before,
       last_tokens_after = excluded.last_tokens_after,
       recent_skills_json = COALESCE(session_compaction_state.recent_skills_json, excluded.recent_skills_json),
       updated_at = excluded.updated_at`,
  ).run(
    sessionId,
    agentId,
    summary,
    nextCount,
    now,
    current?.lastFlushAt ?? null,
    current?.lastFlushCycle ?? -1,
    params.tokensBefore ?? null,
    params.tokensAfter ?? null,
    JSON.stringify(current?.recentSkills ?? []),
    now,
  );

  persistChannelEvent({
    sessionId,
    agentId,
    content: `[Compaction summary ${nanoid(6)}]\n${summary}`,
    metadata: {
      eventType: "compaction-summary",
      compactionCount: nextCount,
      tokensBefore: params.tokensBefore ?? null,
      tokensAfter: params.tokensAfter ?? null,
      droppedMessages: params.droppedMessages ?? null,
      keptMessages: params.keptMessages ?? null,
    },
    createdAt: now,
  });
  scheduleSessionIndex(sessionId, agentId);

  return getSessionCompactionState(sessionId, agentId);
}

