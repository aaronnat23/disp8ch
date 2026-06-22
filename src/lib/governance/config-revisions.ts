import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

const log = logger.child("governance:config-revisions");

export type ConfigRevision = {
  id: string;
  agentId: string;
  changedKeys: string[];
  beforeSnapshot: Record<string, unknown>;
  afterSnapshot: Record<string, unknown>;
  source: "patch" | "rollback" | "system";
  rolledBackFromRevisionId: string | null;
  createdAt: string;
};

export function recordConfigRevision(params: {
  agentId: string;
  changedKeys: string[];
  beforeSnapshot: Record<string, unknown>;
  afterSnapshot: Record<string, unknown>;
  source?: "patch" | "rollback" | "system";
  rolledBackFromRevisionId?: string | null;
}): ConfigRevision {
  initializeDatabase();
  const db = getSqlite();
  const rev: ConfigRevision = {
    id: nanoid(12),
    agentId: params.agentId,
    changedKeys: params.changedKeys,
    beforeSnapshot: params.beforeSnapshot,
    afterSnapshot: params.afterSnapshot,
    source: params.source ?? "patch",
    rolledBackFromRevisionId: params.rolledBackFromRevisionId ?? null,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO agent_config_revisions (id, agent_id, changed_keys, before_snapshot, after_snapshot, source, rolled_back_from_revision_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rev.id, rev.agentId, JSON.stringify(rev.changedKeys),
    JSON.stringify(rev.beforeSnapshot), JSON.stringify(rev.afterSnapshot),
    rev.source, rev.rolledBackFromRevisionId, rev.createdAt
  );
  log.info("Config revision recorded", { id: rev.id, agentId: rev.agentId, source: rev.source });
  return rev;
}

export function listConfigRevisions(agentId: string, limit = 20): ConfigRevision[] {
  initializeDatabase();
  const db = getSqlite();
  const rows = db.prepare(
    `SELECT * FROM agent_config_revisions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(agentId, Math.min(limit, 100)) as Array<{
    id: string; agent_id: string; changed_keys: string; before_snapshot: string;
    after_snapshot: string; source: string; rolled_back_from_revision_id: string | null; created_at: string;
  }>;
  return rows.map(r => ({
    id: r.id,
    agentId: r.agent_id,
    changedKeys: JSON.parse(r.changed_keys) as string[],
    beforeSnapshot: JSON.parse(r.before_snapshot) as Record<string, unknown>,
    afterSnapshot: JSON.parse(r.after_snapshot) as Record<string, unknown>,
    source: r.source as "patch" | "rollback" | "system",
    rolledBackFromRevisionId: r.rolled_back_from_revision_id,
    createdAt: r.created_at,
  }));
}

export function getConfigRevision(revisionId: string): ConfigRevision | null {
  initializeDatabase();
  const db = getSqlite();
  const row = db.prepare(`SELECT * FROM agent_config_revisions WHERE id = ?`).get(revisionId) as {
    id: string; agent_id: string; changed_keys: string; before_snapshot: string;
    after_snapshot: string; source: string; rolled_back_from_revision_id: string | null; created_at: string;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    changedKeys: JSON.parse(row.changed_keys) as string[],
    beforeSnapshot: JSON.parse(row.before_snapshot) as Record<string, unknown>,
    afterSnapshot: JSON.parse(row.after_snapshot) as Record<string, unknown>,
    source: row.source as "patch" | "rollback" | "system",
    rolledBackFromRevisionId: row.rolled_back_from_revision_id,
    createdAt: row.created_at,
  };
}
