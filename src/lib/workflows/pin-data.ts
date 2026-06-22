import { getSqlite } from "@/lib/db";
import { nanoid } from "nanoid";

export type PinnedNodeData = {
  workflowId: string;
  nodeId: string;
  dataJson: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * Validate a raw pinned-data JSON string before saving. Pinned data must be a
 * JSON object (the node's output shape), not a primitive or array.
 */
export function validatePinnedJson(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${String(err)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Pinned data must be a JSON object." };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export function getPinnedData(workflowId: string, nodeId: string): PinnedNodeData | null {
  const db = getSqlite();
  const row = db.prepare(
    "SELECT workflow_id, node_id, data_json, enabled, created_at, updated_at FROM workflow_node_pin_data WHERE workflow_id = ? AND node_id = ?",
  ).get(workflowId, nodeId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    workflowId: String(row.workflow_id),
    nodeId: String(row.node_id),
    dataJson: String(row.data_json),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listPinnedData(workflowId: string): PinnedNodeData[] {
  const db = getSqlite();
  const rows = db.prepare(
    "SELECT workflow_id, node_id, data_json, enabled, created_at, updated_at FROM workflow_node_pin_data WHERE workflow_id = ? ORDER BY node_id",
  ).all(workflowId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    workflowId: String(row.workflow_id),
    nodeId: String(row.node_id),
    dataJson: String(row.data_json),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export function upsertPinnedData(workflowId: string, nodeId: string, data: unknown): PinnedNodeData {
  const db = getSqlite();
  const dataJson = JSON.stringify(data);
  const now = new Date().toISOString();
  const existing = db.prepare(
    "SELECT workflow_id FROM workflow_node_pin_data WHERE workflow_id = ? AND node_id = ?",
  ).get(workflowId, nodeId);
  if (existing) {
    db.prepare(
      "UPDATE workflow_node_pin_data SET data_json = ?, enabled = 1, updated_at = ? WHERE workflow_id = ? AND node_id = ?",
    ).run(dataJson, now, workflowId, nodeId);
  } else {
    db.prepare(
      "INSERT INTO workflow_node_pin_data (workflow_id, node_id, data_json, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    ).run(workflowId, nodeId, dataJson, now, now);
  }
  return {
    workflowId,
    nodeId,
    dataJson,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function deletePinnedData(workflowId: string, nodeId: string): void {
  const db = getSqlite();
  db.prepare("DELETE FROM workflow_node_pin_data WHERE workflow_id = ? AND node_id = ?").run(workflowId, nodeId);
}

export function disablePinnedData(workflowId: string, nodeId: string): void {
  const db = getSqlite();
  db.prepare(
    "UPDATE workflow_node_pin_data SET enabled = 0, updated_at = ? WHERE workflow_id = ? AND node_id = ?",
  ).run(new Date().toISOString(), workflowId, nodeId);
}

export function getPinnedDataForExecution(workflowId: string): Map<string, Record<string, unknown>> {
  const pinMap = new Map<string, Record<string, unknown>>();
  const all = listPinnedData(workflowId).filter((p) => p.enabled);
  for (const pin of all) {
    try {
      pinMap.set(pin.nodeId, JSON.parse(pin.dataJson));
    } catch { /* ignore malformed */ }
  }
  return pinMap;
}
