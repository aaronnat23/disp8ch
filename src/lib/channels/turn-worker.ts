import { getSqlite } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import { nanoid } from "nanoid";
import { registerTurnAbort, unregisterTurnAbort, isTurnAborted } from "@/lib/channels/turn-abort-registry";

const log = logger.child("channels:turn-worker");
const WEBCHAT_TURN_WORKER_TIMEOUT_MS = 120_000;

export function resetStaleProcessingTurns(sessionId?: string) {
  const db = getSqlite();
  const now = new Date().toISOString();
  if (sessionId) {
    db.prepare(
      `UPDATE channel_session_turns
       SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE session_id = ? AND status = 'processing'
         AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
    ).run(now, sessionId, now);
    return;
  }
  db.prepare(
    `UPDATE channel_session_turns
     SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE status = 'processing'
       AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
  ).run(now, now);
}

export function processQueuedWebChatTurn(clientTurnId: string, origin: string) {
  const db = getSqlite();
  const row = db
    .prepare("SELECT request_payload FROM channel_session_turns WHERE client_turn_id = ?")
    .get(clientTurnId) as { request_payload: string | null } | undefined;
  if (!row?.request_payload) return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.request_payload) as Record<string, unknown>;
  } catch {
    return;
  }
  const workerId = `${process.pid}-${Date.now()}`;
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const claimed = db
    .prepare(
      `UPDATE channel_session_turns
       SET status = 'processing', worker_id = ?, lease_expires_at = ?, updated_at = ?
       WHERE client_turn_id = ? AND status IN ('queued', 'failed')`,
    )
    .run(workerId, leaseExpiresAt, now, clientTurnId);
  if (claimed.changes === 0) return;
  if (isTurnAborted(clientTurnId)) {
    db.prepare("UPDATE channel_session_turns SET status = 'cancelled', updated_at = ? WHERE client_turn_id = ?")
      .run(new Date().toISOString(), clientTurnId);
    unregisterTurnAbort(clientTurnId);
    return;
  }
  const controller = new AbortController();
  registerTurnAbort(clientTurnId, controller);
  const timeout = setTimeout(() => controller.abort(), WEBCHAT_TURN_WORKER_TIMEOUT_MS);
  void fetch(`${origin}/api/channels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({ ...payload, waitForCompletion: true }),
  }).then(async (response) => {
    if (isTurnAborted(clientTurnId)) return;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`WebChat turn failed with ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`);
    }
  }).catch((error) => {
    if (isTurnAborted(clientTurnId)) return;
    const isAbort = error instanceof Error && error.name === "AbortError";
    try {
      const current = getSqlite()
        .prepare("SELECT status FROM channel_session_turns WHERE client_turn_id = ?")
        .get(clientTurnId) as { status: string } | undefined;
      if (current?.status === "cancelled" || current?.status === "completed") return;
      getSqlite()
        .prepare(
          `UPDATE channel_session_turns
           SET status = 'failed', error = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
           WHERE client_turn_id = ?`,
        )
        .run(
          isAbort ? `WebChat turn timed out after ${Math.round(WEBCHAT_TURN_WORKER_TIMEOUT_MS / 1000)} seconds.` : String(error),
          new Date().toISOString(),
          new Date().toISOString(),
          clientTurnId,
        );
    } catch {
      // ignore
    }
  }).finally(() => {
    clearTimeout(timeout);
    unregisterTurnAbort(clientTurnId);
  });
}

export function persistProgressEvent(clientTurnId: string, eventType: string, data: object) {
  try {
    getSqlite()
      .prepare(
        `INSERT OR IGNORE INTO turn_progress_events (id, client_turn_id, event_type, data, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(nanoid(12), clientTurnId, eventType, JSON.stringify(data), new Date().toISOString());
  } catch {
    // best-effort persistence
  }
}

export function initDurableTurnWorker() {
  const g = globalThis as Record<string, unknown>;
  if (g.__disp8chTurnWorker) return;
  g.__disp8chTurnWorker = true;

  const workerOrigin = `http://127.0.0.1:${process.env.PORT ?? 3100}`;

  // Reset stale turns every 60 seconds
  setInterval(() => {
    try {
      resetStaleProcessingTurns();
    } catch (err) {
      log.error("stale reset failed", { error: String(err) });
    }
  }, 60_000);

  // Poll for queued turns every 5 seconds
  setInterval(() => {
    try {
      const db = getSqlite();
      const queued = db
        .prepare(
          `SELECT client_turn_id FROM channel_session_turns
           WHERE status = 'queued'
           ORDER BY created_at ASC
           LIMIT 4`,
        )
        .all() as Array<{ client_turn_id: string }>;
      for (const row of queued) {
        processQueuedWebChatTurn(row.client_turn_id, workerOrigin);
      }
    } catch (err) {
      log.error("turn worker poll failed", { error: String(err) });
    }
  }, 5_000);

  log.info("durable turn worker started", { origin: workerOrigin });
}
