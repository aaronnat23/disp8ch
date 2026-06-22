import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { normalizeIngressProvenanceMode, type IngressProvenanceMode } from "@/lib/provenance";

export type AcpSessionRecord = {
  sessionId: string;
  sessionLabel: string | null;
  status: string;
  actor: string | null;
  client: string | null;
  provenanceMode: IngressProvenanceMode;
  lastTraceId: string | null;
  turnCount: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
};

type AcpSessionRow = {
  session_id: string;
  session_label: string | null;
  status: string;
  actor: string | null;
  client: string | null;
  provenance_mode: string | null;
  last_trace_id: string | null;
  turn_count: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string;
};

export type ResolveAcpSessionParams = {
  sessionId?: string | null;
  sessionLabel?: string | null;
  actor?: string | null;
  client?: string | null;
  provenanceMode?: string | null;
  requireExisting?: boolean;
  resetSession?: boolean;
  metadata?: Record<string, unknown> | null;
};

function mapRow(row: AcpSessionRow | undefined | null): AcpSessionRecord | null {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    sessionLabel: row.session_label,
    status: row.status,
    actor: row.actor,
    client: row.client,
    provenanceMode: normalizeIngressProvenanceMode(row.provenance_mode),
    lastTraceId: row.last_trace_id,
    turnCount: Number(row.turn_count || 0),
    metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function normalizeSessionLabel(label?: string | null): string | null {
  const value = String(label || "").trim();
  return value || null;
}

function deriveSessionIdFromLabel(label: string): string {
  const hash = crypto.createHash("sha1").update(label).digest("hex").slice(0, 16);
  return `acp-label:${hash}`;
}

function ensureAcpSessionTable(): void {
  initializeDatabase();
  getSqlite().exec(`
    CREATE TABLE IF NOT EXISTS acp_sessions (
      session_id TEXT PRIMARY KEY,
      session_label TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      actor TEXT,
      client TEXT,
      provenance_mode TEXT,
      last_trace_id TEXT,
      turn_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_acp_sessions_label ON acp_sessions(session_label);
    CREATE INDEX IF NOT EXISTS idx_acp_sessions_last_used_at ON acp_sessions(last_used_at DESC);
  `);
}

export function listAcpSessions(limit = 50): AcpSessionRecord[] {
  ensureAcpSessionTable();
  const db = getSqlite();
  const rows = db
    .prepare(`
      SELECT session_id, session_label, status, actor, client, provenance_mode, last_trace_id,
             turn_count, metadata, created_at, updated_at, last_used_at
      FROM acp_sessions
      ORDER BY last_used_at DESC
      LIMIT ?
    `)
    .all(limit) as AcpSessionRow[];
  return rows.map((row) => mapRow(row)).filter(Boolean) as AcpSessionRecord[];
}

export function getAcpSession(sessionId: string): AcpSessionRecord | null {
  ensureAcpSessionTable();
  const db = getSqlite();
  const row = db
    .prepare(`
      SELECT session_id, session_label, status, actor, client, provenance_mode, last_trace_id,
             turn_count, metadata, created_at, updated_at, last_used_at
      FROM acp_sessions
      WHERE session_id = ?
      LIMIT 1
    `)
    .get(String(sessionId || "").trim()) as AcpSessionRow | undefined;
  return mapRow(row);
}

export function findAcpSessionByLabel(sessionLabel: string): AcpSessionRecord | null {
  ensureAcpSessionTable();
  const normalized = normalizeSessionLabel(sessionLabel);
  if (!normalized) return null;
  const db = getSqlite();
  const row = db
    .prepare(`
      SELECT session_id, session_label, status, actor, client, provenance_mode, last_trace_id,
             turn_count, metadata, created_at, updated_at, last_used_at
      FROM acp_sessions
      WHERE session_label = ?
      ORDER BY last_used_at DESC
      LIMIT 1
    `)
    .get(normalized) as AcpSessionRow | undefined;
  return mapRow(row);
}

export function resolveAcpSession(params: ResolveAcpSessionParams): AcpSessionRecord {
  ensureAcpSessionTable();
  const providedId = String(params.sessionId || "").trim();
  const sessionLabel = normalizeSessionLabel(params.sessionLabel);
  let existing = providedId
    ? getAcpSession(providedId)
    : (sessionLabel ? findAcpSessionByLabel(sessionLabel) : null);

  if (!existing && params.requireExisting) {
    throw new Error(`ACP session not found: ${providedId || sessionLabel || "(unspecified)"}`);
  }

  const sessionId = existing?.sessionId || providedId || (sessionLabel ? deriveSessionIdFromLabel(sessionLabel) : `acp:${nanoid(10)}`);
  const now = new Date().toISOString();
  const nextMode = normalizeIngressProvenanceMode(params.provenanceMode || existing?.provenanceMode || "meta");
  const nextMetadata = params.metadata ?? existing?.metadata ?? null;

  withSqliteWriteRecovery("resolveAcpSession", (db) => {
    if (params.resetSession && existing) {
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
      db.prepare("UPDATE acp_sessions SET turn_count = 0, status = 'reset', updated_at = ?, last_used_at = ? WHERE session_id = ?")
        .run(now, now, sessionId);
      existing = getAcpSession(sessionId);
    }

    db.prepare(`
      INSERT INTO acp_sessions (
        session_id, session_label, status, actor, client, provenance_mode, last_trace_id,
        turn_count, metadata, created_at, updated_at, last_used_at
      ) VALUES (?, ?, 'active', ?, ?, ?, NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        session_label = excluded.session_label,
        status = 'active',
        actor = excluded.actor,
        client = excluded.client,
        provenance_mode = excluded.provenance_mode,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at,
        last_used_at = excluded.last_used_at
    `).run(
      sessionId,
      sessionLabel,
      params.actor ?? existing?.actor ?? null,
      params.client ?? existing?.client ?? null,
      nextMode,
      existing?.turnCount ?? 0,
      nextMetadata ? JSON.stringify(nextMetadata) : null,
      existing?.createdAt ?? now,
      now,
      now,
    );
  });

  return getAcpSession(sessionId) as AcpSessionRecord;
}

export function recordAcpSessionTurn(params: {
  sessionId: string;
  traceId?: string | null;
  actor?: string | null;
  client?: string | null;
  provenanceMode?: string | null;
  metadata?: Record<string, unknown> | null;
}): AcpSessionRecord | null {
  ensureAcpSessionTable();
  const sessionId = String(params.sessionId || "").trim();
  if (!sessionId) return null;
  const now = new Date().toISOString();
  withSqliteWriteRecovery("recordAcpSessionTurn", (db) => {
    db.prepare(`
      UPDATE acp_sessions
      SET turn_count = turn_count + 1,
          last_trace_id = COALESCE(?, last_trace_id),
          actor = COALESCE(?, actor),
          client = COALESCE(?, client),
          provenance_mode = COALESCE(?, provenance_mode),
          metadata = COALESCE(?, metadata),
          status = 'active',
          updated_at = ?,
          last_used_at = ?
      WHERE session_id = ?
    `).run(
      params.traceId ?? null,
      params.actor ?? null,
      params.client ?? null,
      params.provenanceMode ? normalizeIngressProvenanceMode(params.provenanceMode) : null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      now,
      now,
      sessionId,
    );
  });
  return getAcpSession(sessionId);
}

export function resetAcpSession(params: { sessionId?: string | null; sessionLabel?: string | null }): AcpSessionRecord | null {
  ensureAcpSessionTable();
  const existing = params.sessionId
    ? getAcpSession(String(params.sessionId || "").trim())
    : (params.sessionLabel ? findAcpSessionByLabel(params.sessionLabel) : null);
  if (!existing) return null;
  const now = new Date().toISOString();
  withSqliteWriteRecovery("resetAcpSession", (db) => {
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(existing.sessionId);
    db.prepare(`
      UPDATE acp_sessions
      SET turn_count = 0,
          last_trace_id = NULL,
          status = 'reset',
          updated_at = ?,
          last_used_at = ?
      WHERE session_id = ?
    `).run(now, now, existing.sessionId);
  });
  return getAcpSession(existing.sessionId);
}
