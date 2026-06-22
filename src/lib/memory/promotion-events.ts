import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";

export type MemoryPromotionEvent = {
  id: string;
  agentId: string;
  entryId: string | null;
  eventKind: string;
  source: string;
  content: string;
  backfillRunId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

function mapEventRow(row: Record<string, unknown>): MemoryPromotionEvent {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    entryId: row.entry_id ? String(row.entry_id) : null,
    eventKind: String(row.event_kind),
    source: String(row.source),
    content: String(row.content),
    backfillRunId: row.backfill_run_id ? String(row.backfill_run_id) : null,
    detail: row.detail_json ? JSON.parse(String(row.detail_json)) as Record<string, unknown> : null,
    createdAt: String(row.created_at),
  };
}

export function recordMemoryPromotionEvent(params: {
  agentId: string;
  entryId?: string | null;
  eventKind: string;
  source: string;
  content: string;
  backfillRunId?: string | null;
  detail?: Record<string, unknown> | null;
}): MemoryPromotionEvent {
  initializeDatabase();
  const db = getSqlite();
  const event: MemoryPromotionEvent = {
    id: `mpe_${nanoid(10)}`,
    agentId: params.agentId,
    entryId: params.entryId ?? null,
    eventKind: params.eventKind,
    source: params.source,
    content: params.content,
    backfillRunId: params.backfillRunId ?? null,
    detail: params.detail ?? null,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO memory_promotion_events
      (id, agent_id, entry_id, event_kind, source, content, backfill_run_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.agentId,
    event.entryId,
    event.eventKind,
    event.source,
    event.content,
    event.backfillRunId,
    event.detail ? JSON.stringify(event.detail) : null,
    event.createdAt,
  );
  return event;
}

export function listMemoryPromotionEvents(options: {
  agentId: string;
  limit?: number;
  backfillRunId?: string | null;
  eventKind?: string | null;
  entryId?: string | null;
}): MemoryPromotionEvent[] {
  initializeDatabase();
  const db = getSqlite();
  const conditions = ["agent_id = ?"];
  const values: unknown[] = [options.agentId];
  if (options.backfillRunId) {
    conditions.push("backfill_run_id = ?");
    values.push(options.backfillRunId);
  }
  if (options.eventKind) {
    conditions.push("event_kind = ?");
    values.push(options.eventKind);
  }
  if (options.entryId) {
    conditions.push("entry_id = ?");
    values.push(options.entryId);
  }
  const rows = db.prepare(
    `SELECT * FROM memory_promotion_events
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(...values, Math.max(1, Math.min(500, Number(options.limit) || 100))) as Array<Record<string, unknown>>;
  return rows.map(mapEventRow);
}

export function clearStagedMemoryPromotionEvents(agentId: string, backfillRunId?: string | null): number {
  initializeDatabase();
  const db = getSqlite();
  if (backfillRunId) {
    const result = db.prepare(
      "DELETE FROM memory_promotion_events WHERE agent_id = ? AND event_kind = 'candidate' AND backfill_run_id = ?",
    ).run(agentId, backfillRunId);
    return result.changes;
  }
  const result = db.prepare(
    "DELETE FROM memory_promotion_events WHERE agent_id = ? AND event_kind = 'candidate'",
  ).run(agentId);
  return result.changes;
}
