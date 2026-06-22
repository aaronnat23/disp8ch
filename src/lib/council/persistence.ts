import { getSqlite } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

export interface CouncilSessionRecord {
  id: string;
  orgId: string | null;
  topic: string;
  mode: string;
  votingMethod: string;
  participants: string;
  options: string;
  result: string;
  verdict: string | null;
  createdAt: string;
  completedAt: string | null;
}

export function initCouncilTable() {
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS council_sessions (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      topic TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'debate',
      voting_method TEXT NOT NULL DEFAULT 'majority',
      participants TEXT NOT NULL DEFAULT '[]',
      options TEXT NOT NULL DEFAULT '[]',
      result TEXT,
      verdict TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_council_sessions_org ON council_sessions(org_id, created_at DESC);
  `);
}

export function saveCouncilSession(session: {
  id: string;
  orgId?: string | null;
  topic: string;
  mode: string;
  votingMethod: string;
  participants: string[];
  options: string[];
  result?: unknown;
  verdict?: string | null;
}) {
  try {
    const db = getSqlite();
    initCouncilTable();
    db.prepare(`
      INSERT OR REPLACE INTO council_sessions (id, org_id, topic, mode, voting_method, participants, options, result, verdict, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      session.id,
      session.orgId || null,
      session.topic,
      session.mode,
      session.votingMethod,
      JSON.stringify(session.participants),
      JSON.stringify(session.options),
      session.result ? JSON.stringify(session.result) : null,
      session.verdict || null,
    );
  } catch (err) {
    logger.error("[council-persistence] Failed to save session", { error: String(err) });
  }
}

export function listCouncilSessions(orgId?: string | null, limit = 50): CouncilSessionRecord[] {
  try {
    const db = getSqlite();
    initCouncilTable();
    if (orgId) {
      return db.prepare("SELECT * FROM council_sessions WHERE org_id = ? ORDER BY created_at DESC LIMIT ?").all(orgId, limit) as CouncilSessionRecord[];
    }
    return db.prepare("SELECT * FROM council_sessions ORDER BY created_at DESC LIMIT ?").all(limit) as CouncilSessionRecord[];
  } catch {
    return [];
  }
}

export function getCouncilSession(id: string): CouncilSessionRecord | null {
  try {
    const db = getSqlite();
    initCouncilTable();
    return (db.prepare("SELECT * FROM council_sessions WHERE id = ?").get(id) as CouncilSessionRecord) || null;
  } catch {
    return null;
  }
}

export function deleteCouncilSession(id: string): boolean {
  try {
    const db = getSqlite();
    db.prepare("DELETE FROM council_sessions WHERE id = ?").run(id);
    return true;
  } catch {
    return false;
  }
}
