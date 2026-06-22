import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

const log = logger.child("governance:wakeup-queue");

export type WakeupRequestStatus = "queued" | "claimed" | "finished";

export type WakeupRequest = {
  id: string;
  agentId: string;
  source: string;
  triggerDetail: string | null;
  payload: Record<string, unknown> | null;
  idempotencyKey: string | null;
  coalescedCount: number;
  status: WakeupRequestStatus;
  claimedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export function enqueueWakeup(params: {
  agentId: string;
  source: string;
  triggerDetail?: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
}): WakeupRequest {
  initializeDatabase();
  const db = getSqlite();

  // Coalesce if same idempotency key is still queued
  if (params.idempotencyKey) {
    const existing = db.prepare(
      `SELECT id, coalesced_count FROM agent_wakeup_requests
       WHERE agent_id = ? AND idempotency_key = ? AND status = 'queued'`
    ).get(params.agentId, params.idempotencyKey) as { id: string; coalesced_count: number } | undefined;
    if (existing) {
      db.prepare("UPDATE agent_wakeup_requests SET coalesced_count = coalesced_count + 1 WHERE id = ?").run(existing.id);
      log.info("Coalesced wakeup request", { id: existing.id, count: existing.coalesced_count + 1 });
      return getWakeupRequest(existing.id)!;
    }
  }

  const req: WakeupRequest = {
    id: nanoid(12),
    agentId: params.agentId,
    source: params.source,
    triggerDetail: params.triggerDetail ?? null,
    payload: params.payload ?? null,
    idempotencyKey: params.idempotencyKey ?? null,
    coalescedCount: 1,
    status: "queued",
    claimedAt: null,
    finishedAt: null,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO agent_wakeup_requests (id, agent_id, source, trigger_detail, payload, idempotency_key, coalesced_count, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.id, req.agentId, req.source, req.triggerDetail,
    req.payload ? JSON.stringify(req.payload) : null,
    req.idempotencyKey, req.coalescedCount, req.status, req.createdAt);
  log.info("Wakeup request enqueued", { id: req.id, agentId: req.agentId, source: req.source });
  return req;
}

export function claimWakeup(requestId: string): WakeupRequest | null {
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();
  const changes = db.prepare(
    `UPDATE agent_wakeup_requests SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'queued'`
  ).run(now, requestId);
  if (changes.changes === 0) return null;
  return getWakeupRequest(requestId);
}

export function finishWakeup(requestId: string): void {
  initializeDatabase();
  const db = getSqlite();
  db.prepare(
    `UPDATE agent_wakeup_requests SET status = 'finished', finished_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), requestId);
}

export function listWakeupRequests(params?: {
  agentId?: string;
  status?: WakeupRequestStatus;
  limit?: number;
}): WakeupRequest[] {
  initializeDatabase();
  const db = getSqlite();
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params?.agentId) { conditions.push("agent_id = ?"); values.push(params.agentId); }
  if (params?.status) { conditions.push("status = ?"); values.push(params.status); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(params?.limit ?? 50, 200);
  const rows = db.prepare(
    `SELECT * FROM agent_wakeup_requests ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...values, limit) as Array<WakeupRow>;
  return rows.map(mapWakeupRow);
}

function getWakeupRequest(id: string): WakeupRequest | null {
  const db = getSqlite();
  const row = db.prepare("SELECT * FROM agent_wakeup_requests WHERE id = ?").get(id) as WakeupRow | undefined;
  return row ? mapWakeupRow(row) : null;
}

interface WakeupRow {
  id: string; agent_id: string; source: string; trigger_detail: string | null;
  payload: string | null; idempotency_key: string | null; coalesced_count: number;
  status: string; claimed_at: string | null; finished_at: string | null; created_at: string;
}

function mapWakeupRow(r: WakeupRow): WakeupRequest {
  return {
    id: r.id, agentId: r.agent_id, source: r.source, triggerDetail: r.trigger_detail,
    payload: r.payload ? JSON.parse(r.payload) as Record<string, unknown> : null,
    idempotencyKey: r.idempotency_key, coalescedCount: r.coalesced_count,
    status: r.status as WakeupRequestStatus,
    claimedAt: r.claimed_at, finishedAt: r.finished_at, createdAt: r.created_at,
  };
}
