import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";

export type HierarchyActivityEvent = {
  id: string;
  organizationId: string | null;
  goalId: string | null;
  agentId: string | null;
  actorType: string;
  eventType: string;
  title: string;
  summary: string | null;
  status: string | null;
  costUsd: number;
  tokenCount: number;
  modelProvider: string | null;
  modelId: string | null;
  artifactRefs: unknown[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

type ActivityRow = {
  id: string;
  organization_id: string | null;
  goal_id: string | null;
  agent_id: string | null;
  actor_type: string;
  event_type: string;
  title: string;
  summary: string | null;
  status: string | null;
  cost_usd: number | null;
  token_count: number | null;
  model_provider: string | null;
  model_id: string | null;
  artifact_refs_json: string | null;
  metadata_json: string | null;
  created_at: string;
};

function ensureActivityTables() {
  initializeDatabase();
  return getSqlite();
}

function parseArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function mapActivity(row: ActivityRow): HierarchyActivityEvent {
  return {
    id: row.id,
    organizationId: row.organization_id ?? null,
    goalId: row.goal_id ?? null,
    agentId: row.agent_id ?? null,
    actorType: row.actor_type,
    eventType: row.event_type,
    title: row.title,
    summary: row.summary ?? null,
    status: row.status ?? null,
    costUsd: Number(row.cost_usd ?? 0),
    tokenCount: Number(row.token_count ?? 0),
    modelProvider: row.model_provider ?? null,
    modelId: row.model_id ?? null,
    artifactRefs: parseArray(row.artifact_refs_json),
    metadata: parseObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

export function recordHierarchyActivityEvent(input: {
  organizationId?: string | null;
  goalId?: string | null;
  agentId?: string | null;
  actorType?: "system" | "user" | "agent" | "workflow" | string;
  eventType: string;
  title: string;
  summary?: string | null;
  status?: string | null;
  costUsd?: number | null;
  tokenCount?: number | null;
  modelProvider?: string | null;
  modelId?: string | null;
  artifactRefs?: unknown[] | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}): HierarchyActivityEvent {
  const db = ensureActivityTables();
  const id = nanoid(12);
  const createdAt = input.createdAt ?? new Date().toISOString();
  db.prepare(`
    INSERT INTO hierarchy_activity_events (
      id, organization_id, goal_id, agent_id, actor_type, event_type, title, summary, status,
      cost_usd, token_count, model_provider, model_id, artifact_refs_json, metadata_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.organizationId ?? null,
    input.goalId ?? null,
    input.agentId ?? null,
    input.actorType ?? "system",
    String(input.eventType || "event"),
    String(input.title || "Hierarchy event"),
    input.summary ?? null,
    input.status ?? null,
    Number(input.costUsd ?? 0),
    Math.max(0, Math.floor(Number(input.tokenCount ?? 0))),
    input.modelProvider ?? null,
    input.modelId ?? null,
    JSON.stringify(input.artifactRefs ?? []),
    JSON.stringify(input.metadata ?? {}),
    createdAt,
  );
  return getHierarchyActivityEvent(id)!;
}

export function getHierarchyActivityEvent(id: string): HierarchyActivityEvent | null {
  const db = ensureActivityTables();
  const row = db.prepare("SELECT * FROM hierarchy_activity_events WHERE id = ?").get(id) as ActivityRow | undefined;
  return row ? mapActivity(row) : null;
}

export function listHierarchyActivityEvents(input?: {
  organizationId?: string | null;
  goalId?: string | null;
  agentId?: string | null;
  limit?: number;
}): HierarchyActivityEvent[] {
  const db = ensureActivityTables();
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input?.organizationId) {
    clauses.push("organization_id = ?");
    values.push(input.organizationId);
  }
  if (input?.goalId) {
    clauses.push("goal_id = ?");
    values.push(input.goalId);
  }
  if (input?.agentId) {
    clauses.push("agent_id = ?");
    values.push(input.agentId);
  }
  const limit = Math.max(1, Math.min(200, Math.floor(Number(input?.limit ?? 50))));
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM hierarchy_activity_events ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...values, limit) as ActivityRow[];
  return rows.map(mapActivity);
}

export function summarizeHierarchyActivity(input?: {
  organizationId?: string | null;
  goalId?: string | null;
  agentId?: string | null;
  limit?: number;
}): {
  events: HierarchyActivityEvent[];
  totalEvents: number;
  totalCostUsd: number;
  totalTokens: number;
  blockedCount: number;
  failedCount: number;
  latest: HierarchyActivityEvent | null;
} {
  const events = listHierarchyActivityEvents({ ...input, limit: input?.limit ?? 50 });
  return {
    events,
    totalEvents: events.length,
    totalCostUsd: events.reduce((sum, event) => sum + event.costUsd, 0),
    totalTokens: events.reduce((sum, event) => sum + event.tokenCount, 0),
    blockedCount: events.filter((event) => /blocked/i.test(event.status ?? event.eventType)).length,
    failedCount: events.filter((event) => /fail|error/i.test(event.status ?? event.eventType)).length,
    latest: events[0] ?? null,
  };
}

