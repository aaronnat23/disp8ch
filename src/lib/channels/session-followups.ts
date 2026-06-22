import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";

export type SessionFollowUpRecord = {
  sessionId: string;
  message: string;
  hiddenPayload: string;
  createdAt: string;
  updatedAt: string;
};

function mapRow(row: {
  session_id: string;
  message: string | null;
  hidden_payload: string | null;
  created_at: string;
  updated_at: string;
}): SessionFollowUpRecord {
  return {
    sessionId: row.session_id,
    message: String(row.message || "").trim(),
    hiddenPayload: String(row.hidden_payload || "").trim(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getSessionFollowUp(sessionIdRaw: string | null | undefined): SessionFollowUpRecord | null {
  const sessionId = String(sessionIdRaw || "").trim();
  if (!sessionId) return null;
  initializeDatabase();
  const db = getSqlite();
  const row = db
    .prepare("SELECT session_id, message, hidden_payload, created_at, updated_at FROM session_followups WHERE session_id = ?")
    .get(sessionId) as
    | {
        session_id: string;
        message: string | null;
        hidden_payload: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  return row ? mapRow(row) : null;
}

export function upsertSessionFollowUp(params: {
  sessionId: string;
  message?: string | null;
  hiddenPayload?: string | null;
}): SessionFollowUpRecord {
  const sessionId = String(params.sessionId || "").trim();
  if (!sessionId) {
    throw new Error("Session ID is required");
  }
  const now = new Date().toISOString();
  const message = String(params.message || "").trim();
  const hiddenPayload = String(params.hiddenPayload || "").trim();

  withSqliteWriteRecovery("session-followups:upsert", (db) => {
    db.prepare(`
      INSERT INTO session_followups (session_id, message, hidden_payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        message = excluded.message,
        hidden_payload = excluded.hidden_payload,
        updated_at = excluded.updated_at
    `).run(sessionId, message, hiddenPayload, now, now);
  });

  return getSessionFollowUp(sessionId) as SessionFollowUpRecord;
}

export function clearSessionFollowUp(sessionIdRaw: string | null | undefined): void {
  const sessionId = String(sessionIdRaw || "").trim();
  if (!sessionId) return;
  withSqliteWriteRecovery("session-followups:clear", (db) => {
    db.prepare("DELETE FROM session_followups WHERE session_id = ?").run(sessionId);
  });
}

export function consumeSessionFollowUp(sessionIdRaw: string | null | undefined): SessionFollowUpRecord | null {
  const sessionId = String(sessionIdRaw || "").trim();
  if (!sessionId) return null;
  const existing = getSessionFollowUp(sessionId);
  if (!existing) return null;
  clearSessionFollowUp(sessionId);
  return existing;
}
