import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

const log = logger.child("governance:activity-log");

export type ActivityLogEntry = {
  id: string;
  actorType: "user" | "agent" | "system";
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
  companyId: string | null;
  createdAt: string;
};

export function logActivity(params: {
  actorType: "user" | "agent" | "system";
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
  companyId?: string | null;
}): ActivityLogEntry {
  initializeDatabase();
  const db = getSqlite();
  const entry: ActivityLogEntry = {
    id: nanoid(12),
    actorType: params.actorType,
    actorId: params.actorId ?? null,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId ?? null,
    details: params.details ?? null,
    companyId: params.companyId ?? null,
    createdAt: new Date().toISOString(),
  };

  // company_id column may not exist on older DBs — use a safe insert
  const cols = db.prepare("PRAGMA table_info(activity_log)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const hasCompanyId = colNames.has("company_id");

  if (hasCompanyId) {
    db.prepare(
      `INSERT INTO activity_log (id, actor_type, actor_id, action, entity_type, entity_id, details, company_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.id, entry.actorType, entry.actorId, entry.action,
      entry.entityType, entry.entityId,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.companyId,
      entry.createdAt
    );
  } else {
    db.prepare(
      `INSERT INTO activity_log (id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.id, entry.actorType, entry.actorId, entry.action,
      entry.entityType, entry.entityId,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.createdAt
    );
  }

  log.info("Activity logged", { id: entry.id, action: entry.action, entityType: entry.entityType });
  return entry;
}

export function listActivityLog(params?: {
  entityType?: string;
  entityId?: string;
  actorType?: string;
  companyId?: string;
  limit?: number;
}): ActivityLogEntry[] {
  initializeDatabase();
  const db = getSqlite();
  const limit = Math.min(params?.limit ?? 50, 200);
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params?.entityType) { conditions.push("entity_type = ?"); values.push(params.entityType); }
  if (params?.entityId) { conditions.push("entity_id = ?"); values.push(params.entityId); }
  if (params?.actorType) { conditions.push("actor_type = ?"); values.push(params.actorType); }

  // company_id filter — only add if column exists
  const cols = db.prepare("PRAGMA table_info(activity_log)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const hasCompanyId = colNames.has("company_id");
  if (hasCompanyId && params?.companyId) {
    conditions.push("company_id = ?");
    values.push(params.companyId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT * FROM activity_log ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...values, limit) as Array<{
    id: string; actor_type: string; actor_id: string | null; action: string;
    entity_type: string; entity_id: string | null; details: string | null;
    company_id?: string | null; created_at: string;
  }>;

  return rows.map(r => ({
    id: r.id,
    actorType: r.actor_type as "user" | "agent" | "system",
    actorId: r.actor_id,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    details: r.details ? JSON.parse(r.details) as Record<string, unknown> : null,
    companyId: r.company_id ?? null,
    createdAt: r.created_at,
  }));
}
