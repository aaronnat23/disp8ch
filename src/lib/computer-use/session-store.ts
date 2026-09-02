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
      payload_json TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cu_actions_session ON computer_use_actions(session_id);
  `);
  const columns = new Set((db.prepare("PRAGMA table_info(computer_use_actions)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has("payload_json")) db.exec("ALTER TABLE computer_use_actions ADD COLUMN payload_json TEXT");
  if (!columns.has("result_json")) db.exec("ALTER TABLE computer_use_actions ADD COLUMN result_json TEXT");
  return db;
}

function sanitizeRecordedValue(value: unknown, kind: string, key = "", depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (/password|secret|token|api.?key|credential|authorization|cookie/i.test(key)) return "{{secret}}";
  if ((kind === "type" || kind === "set_value") && key === "detail") return "Input action completed; typed value redacted.";
  if (kind === "type" && key === "text") return "{{input_text}}";
  if (kind === "set_value" && key === "value") return "{{input_value}}";
  if ((kind === "type" || kind === "set_value") && key === "evidence") return "[post-action evidence redacted]";
  if ((kind === "type" || kind === "set_value") && key === "query") return "{{expected_state}}";
  if ((kind === "type" || kind === "set_value") && key === "reason") return "Post-action verification result recorded; text redacted.";
  if (/screenshot.*(?:b64|base64)|image.*(?:b64|base64)/i.test(key)) return "[binary omitted]";
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => sanitizeRecordedValue(entry, kind, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([childKey, childValue]) => [
      childKey,
      sanitizeRecordedValue(childValue, kind, childKey, depth + 1),
    ]));
  }
  if (typeof value === "string") {
    if (/^(?:bearer\s+)?(?:sk-|ghp_|github_pat_|xox[baprs]-)[a-z0-9_\-]{12,}$/i.test(value.trim())) return "{{secret}}";
    return value.slice(0, 12_000);
  }
  return value;
}

function sanitizeRecordedPayload(kind: string, payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!payload) return null;
  return sanitizeRecordedValue(payload, kind) as Record<string, unknown>;
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
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
}): string {
  const db = ensureTables();
  const now = new Date().toISOString();
  const actionId = `cua_${nanoid(12)}`;
  db.prepare(
    `INSERT INTO computer_use_actions (id, session_id, kind, risk, requires_approval, approved, detail, screenshot_path, payload_json, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    actionId,
    input.sessionId,
    input.kind,
    input.risk ?? null,
    input.requiresApproval ? 1 : 0,
    input.approved === undefined || input.approved === null ? null : input.approved ? 1 : 0,
    input.detail ? sanitizeRecordedValue(input.detail, input.kind, "detail") : null,
    input.screenshotPath ?? null,
    input.payload ? JSON.stringify(sanitizeRecordedPayload(input.kind, input.payload)) : null,
    input.result ? JSON.stringify(sanitizeRecordedValue(input.result, input.kind)) : null,
    now,
  );
  if (input.screenshotPath || input.activeApp) {
    db.prepare(
      "UPDATE computer_use_sessions SET last_screenshot_path = COALESCE(?, last_screenshot_path), active_app = COALESCE(?, active_app) WHERE id = ?",
    ).run(input.screenshotPath ?? null, input.activeApp ?? null, input.sessionId);
  }
  return actionId;
}

export function updateSessionActionPolicy(input: {
  actionId: string;
  sessionId: string;
  risk: string;
  requiresApproval: boolean;
  approved: boolean | null;
}): void {
  ensureTables().prepare(`
    UPDATE computer_use_actions
    SET risk = ?, requires_approval = ?, approved = ?
    WHERE id = ? AND session_id = ?
  `).run(
    input.risk,
    input.requiresApproval ? 1 : 0,
    input.approved === null ? null : input.approved ? 1 : 0,
    input.actionId,
    input.sessionId,
  );
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
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
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
    payload: (() => { try { return r.payload_json ? JSON.parse(r.payload_json) : null; } catch { return null; } })(),
    result: (() => { try { return r.result_json ? JSON.parse(r.result_json) : null; } catch { return null; } })(),
  }));
}
