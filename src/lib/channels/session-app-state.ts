import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";

export type SessionEntityRef = {
  id?: string | null;
  name?: string | null;
};

export type SessionAppStatePayload = {
  workflow?: SessionEntityRef | null;
  schedule?: SessionEntityRef | null;
  scheduleTargetWorkflow?: SessionEntityRef | null;
  dataSource?: SessionEntityRef | null;
  task?: SessionEntityRef | null;
  agent?: SessionEntityRef | null;
  organization?: SessionEntityRef | null;
  goal?: SessionEntityRef | null;
  lastDomain?: string | null;
  lastAction?: string | null;
  lastSurface?: string | null;
  pendingMutation?:
    | {
        kind?: string | null;
        summary?: string | null;
        payload?: unknown;
        createdAt?: number | null;
      }
    | null;
};

export type SessionAppStateRecord = {
  sessionId: string;
  payload: SessionAppStatePayload;
  createdAt: string;
  updatedAt: string;
};

type SessionAppStateRow = {
  session_id: string;
  payload: string | null;
  created_at: string;
  updated_at: string;
};

function normalizeEntityRef(input: SessionEntityRef | null | undefined): SessionEntityRef | null {
  if (!input) return null;
  const id = String(input.id || "").trim();
  const name = String(input.name || "").trim();
  if (!id && !name) return null;
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
  };
}

function sanitizePayload(input: unknown): SessionAppStatePayload {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const readEntity = (key: string): SessionEntityRef | null =>
    normalizeEntityRef(raw[key] as SessionEntityRef | null | undefined);
  const readText = (key: string): string | null => {
    const value = String(raw[key] || "").trim();
    return value || null;
  };
  return {
    workflow: readEntity("workflow"),
    schedule: readEntity("schedule"),
    scheduleTargetWorkflow: readEntity("scheduleTargetWorkflow"),
    dataSource: readEntity("dataSource"),
    task: readEntity("task"),
    agent: readEntity("agent"),
    organization: readEntity("organization"),
    goal: readEntity("goal"),
    lastDomain: readText("lastDomain"),
    lastAction: readText("lastAction"),
    lastSurface: readText("lastSurface"),
    pendingMutation:
      raw.pendingMutation && typeof raw.pendingMutation === "object"
        ? {
            kind: String((raw.pendingMutation as Record<string, unknown>).kind || "").trim() || null,
            summary: String((raw.pendingMutation as Record<string, unknown>).summary || "").trim() || null,
            payload: (raw.pendingMutation as Record<string, unknown>).payload ?? null,
            createdAt:
              typeof (raw.pendingMutation as Record<string, unknown>).createdAt === "number" &&
              Number.isFinite((raw.pendingMutation as Record<string, unknown>).createdAt)
                ? Number((raw.pendingMutation as Record<string, unknown>).createdAt)
                : null,
          }
        : null,
  };
}

function mapRow(row: SessionAppStateRow): SessionAppStateRecord {
  let parsed: unknown = {};
  try {
    parsed = row.payload ? JSON.parse(row.payload) : {};
  } catch {
    parsed = {};
  }
  return {
    sessionId: row.session_id,
    payload: sanitizePayload(parsed),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getChannelSessionAppState(sessionIdRaw: string | null | undefined): SessionAppStateRecord | null {
  const sessionId = String(sessionIdRaw || "").trim();
  if (!sessionId) return null;
  initializeDatabase();
  const db = getSqlite();
  const row = db
    .prepare("SELECT session_id, payload, created_at, updated_at FROM channel_session_app_state WHERE session_id = ?")
    .get(sessionId) as SessionAppStateRow | undefined;
  return row ? mapRow(row) : null;
}

export function upsertChannelSessionAppState(params: {
  sessionId: string;
  patch: Partial<SessionAppStatePayload>;
}): SessionAppStateRecord {
  const sessionId = String(params.sessionId || "").trim();
  if (!sessionId) {
    throw new Error("Session ID is required");
  }

  const existing = getChannelSessionAppState(sessionId)?.payload ?? {};
  const nextPayload = sanitizePayload({
    ...existing,
    ...params.patch,
  });
  const now = new Date().toISOString();

  withSqliteWriteRecovery("channel-session-app-state:upsert", (db) => {
    db.prepare(`
      INSERT INTO channel_session_app_state (session_id, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).run(sessionId, JSON.stringify(nextPayload), now, now);
  });

  return getChannelSessionAppState(sessionId) as SessionAppStateRecord;
}
