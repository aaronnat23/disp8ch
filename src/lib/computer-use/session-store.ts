/**
 * Computer-use session + action audit store. Every session and every action is
 * recorded so desktop control is never silent: the UI shows the action timeline,
 * last screenshot, active app, and pause/stop state from this store.
 */
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import type { ComputerUseSession, ComputerUseSessionStatus } from "./types";

function ensureTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS computer_use_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      label TEXT,
      agent_id TEXT,
      driver TEXT,
      active_app TEXT,
      last_screenshot_path TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS computer_use_actions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      risk TEXT,
      requires_approval INTEGER NOT NULL DEFAULT 0,
      approved INTEGER,
      detail TEXT,
      screenshot_path TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cu_actions_session ON computer_use_actions(session_id);
  `);
  return db;
}

function mapSession(row: {
  id: string;
  status: string;
  label: string | null;
  agent_id: string | null;
  driver: string | null;
  active_app: string | null;
  last_screenshot_path: string | null;
  started_at: string;
  ended_at: string | null;
}): ComputerUseSession {
  return {
    id: row.id,
    status: row.status as ComputerUseSessionStatus,
    label: row.label,
    agentId: row.agent_id,
    driver: row.driver,
    activeApp: row.active_app,
    lastScreenshotPath: row.last_screenshot_path,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function createSessionRecord(input: {
  label?: string | null;
  agentId?: string | null;
  driver?: string | null;
}): ComputerUseSession {
  const db = ensureTables();
  const id = `cus_${nanoid(12)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO computer_use_sessions (id, status, label, agent_id, driver, started_at)
     VALUES (?, 'active', ?, ?, ?, ?)`,
  ).run(id, input.label ?? null, input.agentId ?? null, input.driver ?? null, now);
  return getSessionRecord(id)!;
}

export function getSessionRecord(id: string): ComputerUseSession | null {
  const db = ensureTables();
  const row = db.prepare("SELECT * FROM computer_use_sessions WHERE id = ?").get(id) as any;
  return row ? mapSession(row) : null;
}

export function listSessionRecords(limit = 50): ComputerUseSession[] {
  const db = ensureTables();
  const rows = db
    .prepare("SELECT * FROM computer_use_sessions ORDER BY started_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(200, limit))) as any[];
  return rows.map(mapSession);
}

export function setSessionStatus(id: string, status: ComputerUseSessionStatus): ComputerUseSession {
  const db = ensureTables();
  const ended = status === "stopped" || status === "error" ? new Date().toISOString() : null;
  db.prepare("UPDATE computer_use_sessions SET status = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?").run(
    status,
    ended,
    id,
  );
  const session = getSessionRecord(id);
  if (!session) throw new Error(`Session not found: ${id}`);
  return session;
}

export function recordSessionAction(input: {
  sessionId: string;
  kind: string;
  risk?: string;
  requiresApproval?: boolean;
  approved?: boolean | null;
  detail?: string;
  screenshotPath?: string | null;
  activeApp?: string | null;
}): void {
  const db = ensureTables();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO computer_use_actions (id, session_id, kind, risk, requires_approval, approved, detail, screenshot_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `cua_${nanoid(12)}`,
    input.sessionId,
    input.kind,
    input.risk ?? null,
    input.requiresApproval ? 1 : 0,
    input.approved === undefined || input.approved === null ? null : input.approved ? 1 : 0,
    input.detail ?? null,
    input.screenshotPath ?? null,
    now,
  );
  if (input.screenshotPath || input.activeApp) {
    db.prepare(
      "UPDATE computer_use_sessions SET last_screenshot_path = COALESCE(?, last_screenshot_path), active_app = COALESCE(?, active_app) WHERE id = ?",
    ).run(input.screenshotPath ?? null, input.activeApp ?? null, input.sessionId);
  }
}

export function listSessionActions(sessionId: string, limit = 200): Array<{
  id: string;
  kind: string;
  risk: string | null;
  requiresApproval: boolean;
  approved: boolean | null;
  detail: string | null;
  screenshotPath: string | null;
  createdAt: string;
}> {
  const db = ensureTables();
  const rows = db
    .prepare("SELECT * FROM computer_use_actions WHERE session_id = ? ORDER BY created_at ASC LIMIT ?")
    .all(sessionId, Math.max(1, Math.min(1000, limit))) as any[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    risk: r.risk ?? null,
    requiresApproval: r.requires_approval === 1,
    approved: r.approved === null ? null : r.approved === 1,
    detail: r.detail ?? null,
    screenshotPath: r.screenshot_path ?? null,
    createdAt: r.created_at,
  }));
}
