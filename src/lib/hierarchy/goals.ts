import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import {
  getActiveHierarchyOrganization,
  listHierarchyOrganizations,
  resolveHierarchyOrganization,
} from "@/lib/hierarchy/organizations";
import { recordHierarchyActivityEvent } from "@/lib/hierarchy/activity";
import { ensureGoalWorkObject } from "@/lib/hierarchy/work-objects";

export type GoalStatus = "planned" | "active" | "blocked" | "done";
export type GoalLevel = "vision" | "mission" | "objective" | "key_result";

export type HierarchyGoalRecord = {
  id: string;
  name: string;
  description: string | null;
  organizationId: string | null;
  organizationName: string | null;
  parentGoalId: string | null;
  parentGoalName: string | null;
  linkedDocumentIds: string[];
  deliverables: string[];
  status: GoalStatus;
  level: GoalLevel | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type GoalRow = {
  id: string;
  name: string;
  description: string | null;
  organization_id: string | null;
  parent_goal_id: string | null;
  linked_document_ids: string | null;
  deliverables: string | null;
  status: string | null;
  level: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
};

function normalizeStringList(input: unknown, maxItems = 24): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of input) {
    const normalized = String(item || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= maxItems) break;
  }
  return output;
}

function parseStoredStringList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    return normalizeStringList(JSON.parse(raw), 48);
  } catch {
    return raw
      .split(/\r?\n|,/g)
      .map((value) => value.trim())
      .filter(Boolean);
  }
}

function ensureGoalTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS hierarchy_goals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      organization_id TEXT,
      parent_goal_id TEXT,
      linked_document_ids TEXT,
      deliverables TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hierarchy_goals_org ON hierarchy_goals(organization_id);
    CREATE INDEX IF NOT EXISTS idx_hierarchy_goals_parent ON hierarchy_goals(parent_goal_id);
  `);
  const goalCols = db.prepare("PRAGMA table_info(hierarchy_goals)").all() as Array<{ name: string }>;
  const goalColNames = new Set(goalCols.map((column) => column.name));
  if (!goalColNames.has("linked_document_ids")) {
    db.exec("ALTER TABLE hierarchy_goals ADD COLUMN linked_document_ids TEXT");
  }
  if (!goalColNames.has("deliverables")) {
    db.exec("ALTER TABLE hierarchy_goals ADD COLUMN deliverables TEXT");
  }
  if (!goalColNames.has("status")) {
    db.exec("ALTER TABLE hierarchy_goals ADD COLUMN status TEXT NOT NULL DEFAULT 'planned'");
  }
  if (!goalColNames.has("level")) {
    db.exec("ALTER TABLE hierarchy_goals ADD COLUMN level TEXT");
  }
  return db;
}

function mapGoal(
  row: GoalRow,
  organizationsById: Map<string, string>,
  goalsById: Map<string, GoalRow>,
): HierarchyGoalRecord {
  const parent = row.parent_goal_id ? goalsById.get(row.parent_goal_id) : null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    organizationId: row.organization_id ?? null,
    organizationName: row.organization_id ? organizationsById.get(row.organization_id) ?? null : null,
    parentGoalId: row.parent_goal_id ?? null,
    parentGoalName: parent?.name ?? null,
    linkedDocumentIds: parseStoredStringList(row.linked_document_ids),
    deliverables: parseStoredStringList(row.deliverables),
    status: (row.status as GoalStatus | null) ?? "planned",
    level: (row.level as GoalLevel | null) ?? null,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listGoalRows(): GoalRow[] {
  const db = ensureGoalTables();
  return db
    .prepare("SELECT * FROM hierarchy_goals ORDER BY updated_at DESC, created_at DESC")
    .all() as GoalRow[];
}

export function listHierarchyGoals(input?: {
  organizationId?: string | null;
  includeInactive?: boolean;
}): HierarchyGoalRecord[] {
  const rows = listGoalRows();
  const organizationsById = new Map(
    listHierarchyOrganizations().map((organization) => [organization.id, organization.name]),
  );
  const goalsById = new Map(rows.map((row) => [row.id, row]));
  return rows
    .filter((row) => (input?.includeInactive ? true : row.is_active === 1))
    .filter((row) => (input?.organizationId ? row.organization_id === input.organizationId : true))
    .map((row) => mapGoal(row, organizationsById, goalsById));
}

export function getHierarchyGoalById(goalId: string): HierarchyGoalRecord | null {
  const rows = listGoalRows();
  const row = rows.find((item) => item.id === goalId);
  if (!row) return null;
  const organizationsById = new Map(
    listHierarchyOrganizations().map((organization) => [organization.id, organization.name]),
  );
  return mapGoal(row, organizationsById, new Map(rows.map((item) => [item.id, item])));
}

export function resolveHierarchyGoal(reference: string, organizationId?: string | null): HierarchyGoalRecord | null {
  const normalized = String(reference || "").trim().toLowerCase();
  if (!normalized) return null;
  const goals = listHierarchyGoals({ organizationId, includeInactive: true });
  return (
    goals.find((goal) => goal.id === reference) ??
    goals.find((goal) => goal.name.trim().toLowerCase() === normalized) ??
    goals.find((goal) => goal.name.toLowerCase().includes(normalized)) ??
    null
  );
}

const VALID_STATUSES: GoalStatus[] = ["planned", "active", "blocked", "done"];
const VALID_LEVELS: GoalLevel[] = ["vision", "mission", "objective", "key_result"];

export function createHierarchyGoal(input: {
  name: string;
  description?: string | null;
  organizationId?: string | null;
  parentGoalId?: string | null;
  linkedDocumentIds?: string[] | null;
  deliverables?: string[] | null;
  status?: GoalStatus | null;
  level?: GoalLevel | null;
}): HierarchyGoalRecord {
  const db = ensureGoalTables();
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Goal name is required");
  const now = new Date().toISOString();
  const organizationId =
    input.organizationId !== undefined
      ? (input.organizationId ? resolveHierarchyOrganization(input.organizationId)?.id ?? input.organizationId : null)
      : (getActiveHierarchyOrganization()?.id ?? null);
  const parentGoalId = input.parentGoalId ? String(input.parentGoalId).trim() : null;
  const linkedDocumentIds = normalizeStringList(input.linkedDocumentIds);
  const deliverables = normalizeStringList(input.deliverables);
  const status: GoalStatus = (input.status && VALID_STATUSES.includes(input.status)) ? input.status : "planned";
  const level: GoalLevel | null = (input.level && VALID_LEVELS.includes(input.level)) ? input.level : null;
  const id = nanoid(12);
  db.prepare(`
    INSERT INTO hierarchy_goals (
      id, name, description, organization_id, parent_goal_id, linked_document_ids, deliverables, status, level, is_active, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    name,
    input.description ?? null,
    organizationId,
    parentGoalId,
    linkedDocumentIds.length > 0 ? JSON.stringify(linkedDocumentIds) : null,
    deliverables.length > 0 ? JSON.stringify(deliverables) : null,
    status,
    level,
    now,
    now,
  );
  const goal = getHierarchyGoalById(id)!;
  ensureGoalWorkObject({
    goalId: goal.id,
    organizationId: goal.organizationId,
    title: goal.name,
    description: goal.description,
    deliverables: goal.deliverables,
    status: goal.status === "active" ? "in_progress" : goal.status === "done" ? "done" : goal.status,
  });
  recordHierarchyActivityEvent({
    organizationId: goal.organizationId,
    goalId: goal.id,
    eventType: "goal.created",
    title: `Goal created: ${goal.name}`,
    summary: goal.description,
    status: goal.status,
    metadata: { level: goal.level, deliverables: goal.deliverables, linkedDocumentIds: goal.linkedDocumentIds },
  });
  return goal;
}

export function updateHierarchyGoal(goalId: string, input: {
  name?: string;
  description?: string | null;
  organizationId?: string | null;
  parentGoalId?: string | null;
  linkedDocumentIds?: string[] | null;
  deliverables?: string[] | null;
  isActive?: boolean;
  status?: GoalStatus | null;
  level?: GoalLevel | null;
}): HierarchyGoalRecord {
  const db = ensureGoalTables();
  const existing = db.prepare("SELECT * FROM hierarchy_goals WHERE id = ?").get(goalId) as GoalRow | undefined;
  if (!existing) throw new Error(`Goal not found: ${goalId}`);
  const organizationId =
    input.organizationId !== undefined
      ? (input.organizationId ? resolveHierarchyOrganization(input.organizationId)?.id ?? input.organizationId : null)
      : existing.organization_id;
  const linkedDocumentIds =
    input.linkedDocumentIds !== undefined
      ? normalizeStringList(input.linkedDocumentIds)
      : parseStoredStringList(existing.linked_document_ids);
  const deliverables =
    input.deliverables !== undefined
      ? normalizeStringList(input.deliverables)
      : parseStoredStringList(existing.deliverables);
  const status: GoalStatus =
    input.status !== undefined
      ? ((input.status && VALID_STATUSES.includes(input.status)) ? input.status : "planned")
      : ((existing.status as GoalStatus | null) ?? "planned");
  const level: GoalLevel | null =
    input.level !== undefined
      ? ((input.level && VALID_LEVELS.includes(input.level)) ? input.level : null)
      : ((existing.level as GoalLevel | null) ?? null);
  db.prepare(`
    UPDATE hierarchy_goals
    SET name = ?, description = ?, organization_id = ?, parent_goal_id = ?, linked_document_ids = ?, deliverables = ?, status = ?, level = ?, is_active = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.name !== undefined ? String(input.name).trim() || existing.name : existing.name,
    input.description !== undefined ? input.description : existing.description,
    organizationId,
    input.parentGoalId !== undefined ? (input.parentGoalId ? String(input.parentGoalId).trim() : null) : existing.parent_goal_id,
    linkedDocumentIds.length > 0 ? JSON.stringify(linkedDocumentIds) : null,
    deliverables.length > 0 ? JSON.stringify(deliverables) : null,
    status,
    level,
    input.isActive !== undefined ? (input.isActive ? 1 : 0) : existing.is_active,
    new Date().toISOString(),
    goalId,
  );
  const goal = getHierarchyGoalById(goalId)!;
  recordHierarchyActivityEvent({
    organizationId: goal.organizationId,
    goalId: goal.id,
    eventType: "goal.updated",
    title: `Goal updated: ${goal.name}`,
    summary: goal.description,
    status: goal.status,
    metadata: { level: goal.level, isActive: goal.isActive, deliverables: goal.deliverables },
  });
  return goal;
}

export function listGoalAncestry(goalId: string): HierarchyGoalRecord[] {
  const rows = listGoalRows();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const organizationsById = new Map(
    listHierarchyOrganizations().map((organization) => [organization.id, organization.name]),
  );
  const output: HierarchyGoalRecord[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(goalId) ?? null;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    output.push(mapGoal(cursor, organizationsById, byId));
    cursor = cursor.parent_goal_id ? byId.get(cursor.parent_goal_id) ?? null : null;
  }
  return output;
}

export function deleteHierarchyGoal(goalId: string): void {
  const db = ensureGoalTables();
  const goal = getHierarchyGoalById(goalId);
  db.prepare("DELETE FROM hierarchy_goals WHERE id = ?").run(goalId);
  if (goal) {
    recordHierarchyActivityEvent({
      organizationId: goal.organizationId,
      goalId: goal.id,
      eventType: "goal.deleted",
      title: `Goal deleted: ${goal.name}`,
      summary: goal.description,
      status: "deleted",
      metadata: { level: goal.level },
    });
  }
}
