import { getSqlite, withSqliteWriteRecovery } from "@/lib/db";
import {
  classifyExactRecallQuery,
  compareExactRecallCandidates,
  extractIdentifierValue,
  filterExactIdentifierCandidates,
  inferMemoryLaneFromCandidate,
  inferPreferredMemoryLane,
  isIdentifierOnlyReplyQuery,
  isValidIdentifierToken,
  normalizeExactRecallText,
  queryNeedsIdentifierComparison,
  resolveExactIdentifierCandidate,
  stripIdentifiersForSubjectKey,
  type ExactRecallCandidate,
  type MemoryLane,
  type QueryRecallClass,
} from "./exact-recall";

export type IdentifierIndexRow = {
  id: string;
  agentId: string;
  subjectKey: string;
  identifier: string;
  content: string;
  lane: MemoryLane;
  sessionId: string | null;
  sourcePath: string | null;
  memoryEntryId: string | null;
  createdAt: string;
  updatedAt: string;
  isCurrent: boolean;
  supersededBy: string | null;
  metadata: Record<string, unknown> | null;
};

type RecordIdentifierObservationParams = {
  agentId?: string;
  content: string;
  sessionId?: string | null;
  sourcePath?: string | null;
  memoryEntryId?: string | null;
  lane?: MemoryLane | null;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown> | null;
};

type ResolveIdentifierQueryParams = {
  agentId?: string;
  query: string;
  sessionId?: string | null;
  sessionContext?: string;
};

export type ResolvedIdentifierQuery =
  | {
      kind: "exact_current" | "session_recent";
      queryClass: QueryRecallClass;
      identifier: string;
      row: IdentifierIndexRow;
      wantsOnlyIdentifier: boolean;
    }
  | {
      kind: "exact_history";
      queryClass: QueryRecallClass;
      identifier: string;
      row: IdentifierIndexRow;
      history: IdentifierIndexRow[];
      wantsOnlyIdentifier: boolean;
    };

type CandidateRow = Omit<IdentifierIndexRow, "sessionId" | "metadata"> & ExactRecallCandidate & {
  sessionId?: string;
  metadata: Record<string, unknown>;
};

function mapRow(row: Record<string, unknown>): IdentifierIndexRow {
  let metadata: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(String(row.metadata_json || "null"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    metadata = null;
  }
  return {
    id: String(row.id || ""),
    agentId: String(row.agent_id || "default"),
    subjectKey: String(row.subject_key || ""),
    identifier: String(row.identifier || ""),
    content: String(row.content || ""),
    lane: String(row.lane || "persistent_facts") as MemoryLane,
    sessionId: row.session_id ? String(row.session_id) : null,
    sourcePath: row.source_path ? String(row.source_path) : null,
    memoryEntryId: row.memory_entry_id ? String(row.memory_entry_id) : null,
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
    isCurrent: Number(row.is_current || 0) !== 0,
    supersededBy: row.superseded_by ? String(row.superseded_by) : null,
    metadata,
  };
}

function rowToCandidate(row: IdentifierIndexRow): CandidateRow {
  return {
    ...row,
    path: row.sourcePath || row.memoryEntryId || `identifier-index:${row.id}`,
    created: row.createdAt,
    updated: row.updatedAt,
    sessionId: row.sessionId ?? undefined,
    metadata: row.metadata ?? {},
    tags: [],
    lastReinforcedAt: row.updatedAt,
    score: row.isCurrent ? 1 : 0.75,
  };
}

function candidateToIdentifierRow(candidate: CandidateRow): IdentifierIndexRow {
  return {
    id: candidate.id,
    agentId: candidate.agentId,
    subjectKey: candidate.subjectKey,
    identifier: candidate.identifier,
    content: candidate.content,
    lane: candidate.lane,
    sessionId: candidate.sessionId ?? null,
    sourcePath: candidate.sourcePath,
    memoryEntryId: candidate.memoryEntryId,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    isCurrent: candidate.isCurrent,
    supersededBy: candidate.supersededBy,
    metadata: candidate.metadata,
  };
}

function loadRows(params: {
  agentId: string;
  lane?: MemoryLane | null;
  isCurrent?: boolean | null;
  sessionId?: string | null;
  limit?: number;
}): IdentifierIndexRow[] {
  const db = getSqlite();
  const where: string[] = ["agent_id = ?"];
  const values: Array<string | number> = [params.agentId];
  if (params.lane) {
    where.push("lane = ?");
    values.push(params.lane);
  }
  if (typeof params.isCurrent === "boolean") {
    where.push("is_current = ?");
    values.push(params.isCurrent ? 1 : 0);
  }
  if (params.sessionId) {
    where.push("session_id = ?");
    values.push(params.sessionId);
  }
  const limit = Math.max(1, Math.min(Number(params.limit) || 100, 500));
  const rows = db
    .prepare(
      `SELECT *
         FROM memory_identifier_index
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?`,
    )
    .all(...values, limit) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

function scoreRowSubjectMatch(query: string, row: CandidateRow): number {
  const subject = normalizeExactRecallText(row.subjectKey);
  const normalizedQuery = normalizeExactRecallText(query);
  if (!subject || !normalizedQuery) return 0;
  if (normalizedQuery.includes(subject)) return 4;
  const tokens = subject.split(/\s+/).filter((token) => token.length >= 4);
  if (!tokens.length) return 0;
  return tokens.reduce((sum, token) => sum + (normalizedQuery.includes(token) ? 1 : 0), 0);
}

function rankRows(query: string, rows: IdentifierIndexRow[], sessionContext = ""): CandidateRow[] {
  const rankingQuery = `${sessionContext} ${query}`.trim();
  const candidates = rows.map(rowToCandidate);
  const filtered = filterExactIdentifierCandidates(rankingQuery, candidates);
  return [...filtered].sort((left, right) => {
    const subjectDiff = scoreRowSubjectMatch(rankingQuery, right) - scoreRowSubjectMatch(rankingQuery, left);
    if (subjectDiff !== 0) return subjectDiff;
    return compareExactRecallCandidates(rankingQuery, left, right);
  });
}

export function recordIdentifierObservation(params: RecordIdentifierObservationParams): IdentifierIndexRow | null {
  const content = String(params.content || "").trim();
  const identifier = extractIdentifierValue(content);
  const subjectKey = stripIdentifiersForSubjectKey(content);
  if (!identifier || !isValidIdentifierToken(identifier) || !subjectKey) return null;

  const now = new Date().toISOString();
  const agentId = String(params.agentId || "default").trim() || "default";
  const lane =
    params.lane ||
    inferMemoryLaneFromCandidate({
      content,
      metadata: params.metadata ?? undefined,
      path: params.sourcePath || undefined,
      sessionId: params.sessionId || undefined,
    });
  const createdAt = params.createdAt || now;
  const updatedAt = params.updatedAt || now;
  const sourcePath = params.sourcePath ? String(params.sourcePath) : null;
  const memoryEntryId = params.memoryEntryId ? String(params.memoryEntryId) : null;
  const sessionId = params.sessionId ? String(params.sessionId) : null;
  const metadataJson = JSON.stringify(params.metadata ?? null);

  return withSqliteWriteRecovery("identifier-index upsert", (db) => {
    const existing = db
      .prepare(
        `SELECT *
           FROM memory_identifier_index
          WHERE agent_id = ?
            AND subject_key = ?
            AND identifier = ?
            AND COALESCE(memory_entry_id, '') = COALESCE(?, '')
            AND COALESCE(source_path, '') = COALESCE(?, '')
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get(agentId, subjectKey, identifier, memoryEntryId, sourcePath) as Record<string, unknown> | undefined;

    if (existing) {
      db.prepare(
        `UPDATE memory_identifier_index
            SET lane = ?,
                session_id = ?,
                content = ?,
                updated_at = ?,
                metadata_json = ?,
                is_current = 1
          WHERE id = ?`,
      ).run(lane, sessionId, content, updatedAt, metadataJson, existing.id);
      return mapRow({
        ...existing,
        lane,
        session_id: sessionId,
        content,
        updated_at: updatedAt,
        metadata_json: metadataJson,
        is_current: 1,
      });
    }

    const sameCurrent = db
      .prepare(
        `SELECT *
           FROM memory_identifier_index
          WHERE agent_id = ?
            AND subject_key = ?
            AND identifier = ?
            AND is_current = 1
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get(agentId, subjectKey, identifier) as Record<string, unknown> | undefined;
    if (sameCurrent) {
      db.prepare(
        `UPDATE memory_identifier_index
            SET updated_at = ?,
                metadata_json = COALESCE(?, metadata_json)
          WHERE id = ?`,
      ).run(updatedAt, metadataJson, sameCurrent.id);
      return mapRow({
        ...sameCurrent,
        updated_at: updatedAt,
        metadata_json: metadataJson || sameCurrent.metadata_json,
      });
    }

    const id = `idx_${Math.random().toString(36).slice(2, 10)}`;
    const tx = db.transaction(() => {
      const currentRows = db
        .prepare(
          `SELECT id
             FROM memory_identifier_index
            WHERE agent_id = ?
              AND subject_key = ?
              AND is_current = 1`,
        )
        .all(agentId, subjectKey) as Array<{ id: string }>;
      if (currentRows.length > 0) {
        db.prepare(
          `UPDATE memory_identifier_index
              SET is_current = 0,
                  superseded_by = ?,
                  updated_at = ?
            WHERE agent_id = ?
              AND subject_key = ?
              AND is_current = 1`,
        ).run(id, updatedAt, agentId, subjectKey);
      }
      db.prepare(
        `INSERT INTO memory_identifier_index (
           id, agent_id, subject_key, identifier, content, lane, session_id, source_path, memory_entry_id,
           created_at, updated_at, is_current, superseded_by, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)`,
      ).run(id, agentId, subjectKey, identifier, content, lane, sessionId, sourcePath, memoryEntryId, createdAt, updatedAt, metadataJson);
    });
    tx();
    return {
      id,
      agentId,
      subjectKey,
      identifier,
      content,
      lane,
      sessionId,
      sourcePath,
      memoryEntryId,
      createdAt,
      updatedAt,
      isCurrent: true,
      supersededBy: null,
      metadata: params.metadata ?? null,
    };
  });
}

export function markIdentifierObservationsDeleted(params: {
  agentId?: string;
  memoryEntryId?: string | null;
  sourcePath?: string | null;
}): number {
  const agentId = String(params.agentId || "default").trim() || "default";
  const memoryEntryId = params.memoryEntryId ? String(params.memoryEntryId) : null;
  const sourcePath = params.sourcePath ? String(params.sourcePath) : null;
  if (!memoryEntryId && !sourcePath) return 0;
  return withSqliteWriteRecovery("identifier-index delete mark", (db) => {
    const where: string[] = ["agent_id = ?"];
    const values: Array<string | number> = [agentId];
    if (memoryEntryId) {
      where.push("memory_entry_id = ?");
      values.push(memoryEntryId);
    }
    if (sourcePath) {
      where.push("source_path = ?");
      values.push(sourcePath);
    }
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE memory_identifier_index
            SET is_current = 0,
                updated_at = ?,
                metadata_json = ?
          WHERE ${where.join(" AND ")}`,
      )
      .run(now, JSON.stringify({ deleted: true }), ...values);
    return Number(result.changes || 0);
  });
}

export function resolveIdentifierQuery(params: ResolveIdentifierQueryParams): ResolvedIdentifierQuery | null {
  const query = String(params.query || "").trim();
  if (!query) return null;
  const agentId = String(params.agentId || "default").trim() || "default";
  const queryClass = classifyExactRecallQuery(query);
  if (queryClass === "semantic_memory") return null;
  const wantsOnlyIdentifier = isIdentifierOnlyReplyQuery(query);
  const sessionContext = String(params.sessionContext || "").trim();
  const effectiveQuery = `${sessionContext} ${query}`.trim();
  const preferredLane = inferPreferredMemoryLane(effectiveQuery || query);
  const sessionId = params.sessionId ? String(params.sessionId) : null;

  const tryResolve = (rows: IdentifierIndexRow[]) => {
    const ranked = rankRows(query, rows, sessionContext);
    const row = ranked.find((candidate) => isValidIdentifierToken(candidate.identifier));
    if (!row) return null;
    return { row: candidateToIdentifierRow(row), identifier: row.identifier };
  };

  if (queryClass === "session_recent" && sessionId) {
    const sessionRows = loadRows({ agentId, sessionId, isCurrent: true, limit: 80 });
    const sessionResolved = tryResolve(sessionRows);
    if (sessionResolved) {
      return {
        kind: "session_recent",
        queryClass,
        identifier: sessionResolved.identifier,
        row: sessionResolved.row,
        wantsOnlyIdentifier,
      };
    }
  }

  const preferredRows = loadRows({ agentId, lane: preferredLane, isCurrent: true, limit: 120 });
  const preferredResolved = tryResolve(preferredRows);
  if (preferredResolved) {
    if (queryClass === "exact_history" || queryNeedsIdentifierComparison(query)) {
      const history = loadRows({ agentId, isCurrent: null, limit: 200 })
        .filter((row) => row.subjectKey === preferredResolved.row.subjectKey)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      return {
        kind: "exact_history",
        queryClass,
        identifier: preferredResolved.identifier,
        row: preferredResolved.row,
        history,
        wantsOnlyIdentifier,
      };
    }
    return {
      kind: queryClass === "session_recent" ? "session_recent" : "exact_current",
      queryClass,
      identifier: preferredResolved.identifier,
      row: preferredResolved.row,
      wantsOnlyIdentifier,
    };
  }

  const fallbackRows = loadRows({ agentId, isCurrent: true, limit: 200 });
  const fallbackResolved = tryResolve(fallbackRows);
  if (!fallbackResolved) return null;
  if (queryClass === "exact_history" || queryNeedsIdentifierComparison(query)) {
    const history = loadRows({ agentId, isCurrent: null, limit: 200 })
      .filter((row) => row.subjectKey === fallbackResolved.row.subjectKey)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return {
      kind: "exact_history",
      queryClass,
      identifier: fallbackResolved.identifier,
      row: fallbackResolved.row,
      history,
      wantsOnlyIdentifier,
    };
  }
  return {
    kind: queryClass === "session_recent" ? "session_recent" : "exact_current",
    queryClass,
    identifier: fallbackResolved.identifier,
    row: fallbackResolved.row,
    wantsOnlyIdentifier,
  };
}
