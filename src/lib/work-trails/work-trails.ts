/**
 * Cross-tab work trail.
 *
 * A durable record that links every cross-tab operation:
 *   Prompt -> Intent -> Plan -> Confirmation -> Org/Council/Workflow/Board ...
 *
 * The trail is the single visible thread that ties WebChat, Hierarchy, Council,
 * Workflows, Boards, and the Activity tab together. It is compact by default;
 * full detail (timestamps, raw plan JSON, per-step logs) lives in the drawer.
 *
 * This module is the backend: tables + typed helpers. It is intentionally
 * side-effect-light — callers decide which events to append.
 */

import { randomUUID } from "node:crypto";
import { getSqlite } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

const log = logger.child("work-trails");

export type WorkTrailStatus = "pending" | "confirmed" | "executing" | "completed" | "failed" | "cancelled";

export type WorkTrailEventType =
  | "prompt_received"
  | "intent_detected"
  | "plan_drafted"
  | "plan_edited"
  | "confirmed"
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "object_created"
  | "object_linked"
  | "council_started"
  | "council_completed"
  | "workflow_created"
  | "workflow_scheduled"
  | "workflow_run_started"
  | "workflow_run_completed"
  | "board_task_created"
  | "artifact_created"
  | "cancelled";

export type WorkTrailRecord = {
  id: string;
  sessionId: string | null;
  clientTurnId: string | null;
  userMessage: string;
  intentJson: string;
  planJson: string | null;
  status: WorkTrailStatus;
  createdAt: string;
  updatedAt: string;
};

export type WorkTrailEvent = {
  id: string;
  trailId: string;
  eventType: WorkTrailEventType;
  surface: string | null;
  objectType: string | null;
  objectId: string | null;
  objectName: string | null;
  summary: string | null;
  metadataJson: string | null;
  createdAt: string;
};

let tablesReady = false;

export function ensureWorkTrailTables(): void {
  if (tablesReady) return;
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_trails (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      client_turn_id TEXT,
      user_message TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      plan_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_trail_events (
      id TEXT PRIMARY KEY,
      trail_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      surface TEXT,
      object_type TEXT,
      object_id TEXT,
      object_name TEXT,
      summary TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(trail_id) REFERENCES work_trails(id)
    );

    CREATE INDEX IF NOT EXISTS idx_work_trails_session ON work_trails(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_trail_events_trail ON work_trail_events(trail_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_work_trail_events_object ON work_trail_events(surface, object_type, object_id, created_at DESC);
  `);
  tablesReady = true;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createWorkTrail(args: {
  id?: string;
  sessionId?: string | null;
  clientTurnId?: string | null;
  userMessage: string;
  intent: unknown;
  plan?: unknown;
  status?: WorkTrailStatus;
}): string {
  try {
    ensureWorkTrailTables();
    const db = getSqlite();
    const id = args.id || `trail-${randomUUID()}`;
    const ts = nowIso();
    db.prepare(`
      INSERT OR REPLACE INTO work_trails
        (id, session_id, client_turn_id, user_message, intent_json, plan_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      args.sessionId ?? null,
      args.clientTurnId ?? null,
      String(args.userMessage ?? "").slice(0, 4000),
      JSON.stringify(args.intent ?? {}),
      args.plan === undefined ? null : JSON.stringify(args.plan),
      args.status ?? "pending",
      ts,
      ts,
    );
    appendWorkTrailEvent({ trailId: id, eventType: "prompt_received", summary: String(args.userMessage ?? "").slice(0, 200) });
    return id;
  } catch (err) {
    log.warn("createWorkTrail failed", { error: String(err) });
    return args.id || "";
  }
}

export function appendWorkTrailEvent(args: {
  trailId: string;
  eventType: WorkTrailEventType;
  surface?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  objectName?: string | null;
  summary?: string | null;
  metadata?: unknown;
}): void {
  if (!args.trailId) return;
  try {
    ensureWorkTrailTables();
    const db = getSqlite();
    const ts = nowIso();
    db.prepare(`
      INSERT INTO work_trail_events
        (id, trail_id, event_type, surface, object_type, object_id, object_name, summary, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `evt-${randomUUID()}`,
      args.trailId,
      args.eventType,
      args.surface ?? null,
      args.objectType ?? null,
      args.objectId ?? null,
      args.objectName ?? null,
      args.summary ? String(args.summary).slice(0, 500) : null,
      args.metadata === undefined ? null : JSON.stringify(args.metadata),
      ts,
    );
    db.prepare(`UPDATE work_trails SET updated_at = ? WHERE id = ?`).run(ts, args.trailId);
  } catch (err) {
    log.warn("appendWorkTrailEvent failed", { error: String(err), eventType: args.eventType });
  }
}

/** Convenience: record that an app object was created/linked under this trail. */
export function linkObjectToTrail(args: {
  trailId: string;
  surface: string;
  objectType: string;
  objectId?: string | null;
  objectName?: string | null;
  eventType?: WorkTrailEventType;
  summary?: string | null;
}): void {
  appendWorkTrailEvent({
    trailId: args.trailId,
    eventType: args.eventType ?? "object_created",
    surface: args.surface,
    objectType: args.objectType,
    objectId: args.objectId ?? null,
    objectName: args.objectName ?? null,
    summary: args.summary ?? null,
  });
}

export function updateWorkTrailStatus(trailId: string, status: WorkTrailStatus): void {
  if (!trailId) return;
  try {
    ensureWorkTrailTables();
    getSqlite().prepare(`UPDATE work_trails SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), trailId);
  } catch (err) {
    log.warn("updateWorkTrailStatus failed", { error: String(err) });
  }
}

export function updateWorkTrailPlan(trailId: string, plan: unknown): void {
  if (!trailId) return;
  try {
    ensureWorkTrailTables();
    getSqlite().prepare(`UPDATE work_trails SET plan_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(plan ?? null), nowIso(), trailId);
  } catch (err) {
    log.warn("updateWorkTrailPlan failed", { error: String(err) });
  }
}

function rowToTrail(row: Record<string, unknown>): WorkTrailRecord {
  return {
    id: String(row.id),
    sessionId: (row.session_id as string) ?? null,
    clientTurnId: (row.client_turn_id as string) ?? null,
    userMessage: String(row.user_message ?? ""),
    intentJson: String(row.intent_json ?? "{}"),
    planJson: (row.plan_json as string) ?? null,
    status: (String(row.status || "pending")) as WorkTrailStatus,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function rowToEvent(row: Record<string, unknown>): WorkTrailEvent {
  return {
    id: String(row.id),
    trailId: String(row.trail_id),
    eventType: String(row.event_type) as WorkTrailEventType,
    surface: (row.surface as string) ?? null,
    objectType: (row.object_type as string) ?? null,
    objectId: (row.object_id as string) ?? null,
    objectName: (row.object_name as string) ?? null,
    summary: (row.summary as string) ?? null,
    metadataJson: (row.metadata_json as string) ?? null,
    createdAt: String(row.created_at ?? ""),
  };
}

export function getWorkTrail(trailId: string): { trail: WorkTrailRecord; events: WorkTrailEvent[] } | null {
  if (!trailId) return null;
  try {
    ensureWorkTrailTables();
    const db = getSqlite();
    const row = db.prepare(`SELECT * FROM work_trails WHERE id = ?`).get(trailId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const eventRows = db.prepare(`SELECT * FROM work_trail_events WHERE trail_id = ? ORDER BY created_at ASC`).all(trailId) as Record<string, unknown>[];
    return { trail: rowToTrail(row), events: eventRows.map(rowToEvent) };
  } catch (err) {
    log.warn("getWorkTrail failed", { error: String(err) });
    return null;
  }
}

export function listWorkTrails(opts?: { sessionId?: string | null; limit?: number }): Array<WorkTrailRecord & { eventCount: number }> {
  try {
    ensureWorkTrailTables();
    const db = getSqlite();
    const limit = Math.max(1, Math.min(200, opts?.limit ?? 50));
    const rows = opts?.sessionId
      ? db.prepare(`SELECT * FROM work_trails WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`).all(opts.sessionId, limit) as Record<string, unknown>[]
      : db.prepare(`SELECT * FROM work_trails ORDER BY created_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
    return rows.map((row) => {
      const trail = rowToTrail(row);
      const countRow = db.prepare(`SELECT COUNT(*) AS c FROM work_trail_events WHERE trail_id = ?`).get(trail.id) as { c: number } | undefined;
      return { ...trail, eventCount: countRow?.c ?? 0 };
    });
  } catch (err) {
    log.warn("listWorkTrails failed", { error: String(err) });
    return [];
  }
}

/** Compact trail summary for object/session strips: status + a Prompt -> Org ->
 *  Council -> Workflow -> Task style path built from the surface-aware events. */
export type WorkTrailSummary = {
  id: string;
  status: WorkTrailStatus;
  userMessage: string;
  createdAt: string;
  updatedAt: string;
  path: string[];
  objectCount: number;
};

const SURFACE_PATH_ORDER = ["hierarchy", "agents", "goals", "council", "workflows", "scheduler", "boards", "channels"];
const SURFACE_LABEL: Record<string, string> = {
  hierarchy: "Org",
  agents: "Agents",
  goals: "Goal",
  council: "Council",
  workflows: "Workflow",
  scheduler: "Schedule",
  boards: "Task",
  channels: "Channel",
};

function summarizeTrail(trail: WorkTrailRecord, events: WorkTrailEvent[]): WorkTrailSummary {
  const surfaces = new Set<string>();
  let objectCount = 0;
  for (const e of events) {
    if (e.objectId && (e.eventType === "object_created" || e.eventType === "object_linked" ||
      e.eventType === "council_completed" || e.eventType === "workflow_created" ||
      e.eventType === "workflow_scheduled" || e.eventType === "board_task_created")) {
      objectCount++;
      if (e.surface) surfaces.add(e.surface);
    }
  }
  const path = ["Prompt", ...SURFACE_PATH_ORDER.filter((s) => surfaces.has(s)).map((s) => SURFACE_LABEL[s] ?? s)];
  return {
    id: trail.id,
    status: trail.status,
    userMessage: trail.userMessage,
    createdAt: trail.createdAt,
    updatedAt: trail.updatedAt,
    path,
    objectCount,
  };
}

/** Trails that touched a specific app object (for "Related Work Trail" strips in
 *  the Hierarchy/Council/Workflow/Board detail drawers). Newest-first. */
export function getWorkTrailsForObject(
  surface: string,
  objectType: string,
  objectId: string,
  limit = 5,
): WorkTrailSummary[] {
  if (!surface || !objectId) return [];
  try {
    ensureWorkTrailTables();
    const db = getSqlite();
    const cap = Math.max(1, Math.min(50, limit));
    const trailRows = db.prepare(`
      SELECT DISTINCT t.* FROM work_trails t
      JOIN work_trail_events e ON e.trail_id = t.id
      WHERE e.surface = ? AND e.object_id = ?${objectType ? " AND e.object_type = ?" : ""}
      ORDER BY t.created_at DESC LIMIT ?
    `).all(...(objectType ? [surface, objectId, objectType, cap] : [surface, objectId, cap])) as Record<string, unknown>[];
    return trailRows.map((row) => {
      const trail = rowToTrail(row);
      const eventRows = db.prepare(`SELECT * FROM work_trail_events WHERE trail_id = ? ORDER BY created_at ASC`).all(trail.id) as Record<string, unknown>[];
      return summarizeTrail(trail, eventRows.map(rowToEvent));
    });
  } catch (err) {
    log.warn("getWorkTrailsForObject failed", { error: String(err) });
    return [];
  }
}

/** Recent trails for a chat session, as compact summaries (Activity strip / WebChat). */
export function getRecentWorkTrailsForSession(sessionId: string, limit = 5): WorkTrailSummary[] {
  if (!sessionId) return [];
  try {
    ensureWorkTrailTables();
    const db = getSqlite();
    const cap = Math.max(1, Math.min(50, limit));
    const rows = db.prepare(`SELECT * FROM work_trails WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`).all(sessionId, cap) as Record<string, unknown>[];
    return rows.map((row) => {
      const trail = rowToTrail(row);
      const eventRows = db.prepare(`SELECT * FROM work_trail_events WHERE trail_id = ? ORDER BY created_at ASC`).all(trail.id) as Record<string, unknown>[];
      return summarizeTrail(trail, eventRows.map(rowToEvent));
    });
  } catch (err) {
    log.warn("getRecentWorkTrailsForSession failed", { error: String(err) });
    return [];
  }
}

/**
 * Map an executed app-action step to a trail event. Used after a confirmed plan
 * executes so the trail reflects exactly what landed.
 */
export function recordStepResultEvent(args: {
  trailId: string;
  action: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  label?: string;
}): void {
  if (!args.trailId) return;
  const { action, ok, output } = args;
  const out = (output && typeof output === "object" ? output : {}) as Record<string, unknown>;
  const objectId = String(out.id ?? out.organizationId ?? out.workflowId ?? out.taskId ?? out.goalId ?? out.sessionId ?? "") || null;
  const objectName = String(out.name ?? out.title ?? out.topic ?? "") || null;

  if (!ok) {
    appendWorkTrailEvent({ trailId: args.trailId, eventType: "step_failed", summary: `${action}: ${args.error ?? "failed"}`.slice(0, 200), metadata: { action } });
    return;
  }

  // Specific, surface-aware events for the high-signal actions.
  const map: Partial<Record<string, { eventType: WorkTrailEventType; surface: string; objectType: string }>> = {
    create_organization: { eventType: "object_created", surface: "hierarchy", objectType: "organization" },
    apply_org_template: { eventType: "object_created", surface: "hierarchy", objectType: "organization" },
    create_agent: { eventType: "object_created", surface: "agents", objectType: "agent" },
    create_agents: { eventType: "object_created", surface: "agents", objectType: "agents" },
    create_goal: { eventType: "object_created", surface: "goals", objectType: "goal" },
    link_goal_sources: { eventType: "object_linked", surface: "goals", objectType: "goal-sources" },
    run_council: { eventType: "council_completed", surface: "council", objectType: "council-session" },
    create_workflow_from_template: { eventType: "workflow_created", surface: "workflows", objectType: "workflow" },
    schedule_workflow: { eventType: "workflow_scheduled", surface: "scheduler", objectType: "schedule" },
    create_board_task: { eventType: "board_task_created", surface: "boards", objectType: "board-task" },
    connect_channel: { eventType: "object_linked", surface: "channels", objectType: "channel" },
  };
  const mapping = map[action];
  if (mapping) {
    appendWorkTrailEvent({
      trailId: args.trailId,
      eventType: mapping.eventType,
      surface: mapping.surface,
      objectType: mapping.objectType,
      objectId,
      objectName,
      summary: args.label ?? action,
    });
  } else {
    appendWorkTrailEvent({ trailId: args.trailId, eventType: "step_completed", summary: args.label ?? action, metadata: { action } });
  }
}
