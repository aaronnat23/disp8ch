import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { getActiveHierarchyOrganization, resolveHierarchyOrganization } from "@/lib/hierarchy/organizations";

export type WorkObjectType = "goal" | "project" | "task" | "workflow" | "decision" | "document" | "incident";
export type WorkObjectStatus = "planned" | "ready" | "in_progress" | "blocked" | "review" | "done" | "cancelled";
export type WorkObjectPriority = "low" | "medium" | "high" | "urgent";
export type WorkObjectRiskLevel = "low" | "medium" | "high";

export type WorkObject = {
  id: string;
  organizationId: string | null;
  goalId: string | null;
  parentWorkObjectId: string | null;
  type: WorkObjectType;
  title: string;
  description: string | null;
  ownerAgentId: string | null;
  status: WorkObjectStatus;
  priority: WorkObjectPriority;
  linkedTaskIds: string[];
  linkedWorkflowIds: string[];
  linkedDocumentIds: string[];
  linkedCouncilSessionIds: string[];
  linkedExecutionIds: string[];
  decisionIds: string[];
  deliverables: string[];
  blockers: string[];
  riskLevel: WorkObjectRiskLevel;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type WorkObjectRow = {
  id: string;
  organization_id: string | null;
  goal_id: string | null;
  parent_work_object_id: string | null;
  type: string;
  title: string;
  description: string | null;
  owner_agent_id: string | null;
  status: string;
  priority: string;
  linked_task_ids: string | null;
  linked_workflow_ids: string | null;
  linked_document_ids: string | null;
  linked_council_session_ids: string | null;
  linked_execution_ids: string | null;
  decision_ids: string | null;
  deliverables: string | null;
  blockers: string | null;
  risk_level: string;
  due_at: string | null;
  created_at: string;
  updated_at: string;
};

const TYPES: WorkObjectType[] = ["goal", "project", "task", "workflow", "decision", "document", "incident"];
const STATUSES: WorkObjectStatus[] = ["planned", "ready", "in_progress", "blocked", "review", "done", "cancelled"];
const PRIORITIES: WorkObjectPriority[] = ["low", "medium", "high", "urgent"];
const RISKS: WorkObjectRiskLevel[] = ["low", "medium", "high"];

function ensureWorkObjectTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS hierarchy_work_objects (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      goal_id TEXT,
      parent_work_object_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      owner_agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      priority TEXT NOT NULL DEFAULT 'medium',
      linked_task_ids TEXT NOT NULL DEFAULT '[]',
      linked_workflow_ids TEXT NOT NULL DEFAULT '[]',
      linked_document_ids TEXT NOT NULL DEFAULT '[]',
      linked_council_session_ids TEXT NOT NULL DEFAULT '[]',
      linked_execution_ids TEXT NOT NULL DEFAULT '[]',
      decision_ids TEXT NOT NULL DEFAULT '[]',
      deliverables TEXT NOT NULL DEFAULT '[]',
      blockers TEXT NOT NULL DEFAULT '[]',
      risk_level TEXT NOT NULL DEFAULT 'low',
      due_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hierarchy_work_objects_org ON hierarchy_work_objects(organization_id);
    CREATE INDEX IF NOT EXISTS idx_hierarchy_work_objects_goal ON hierarchy_work_objects(goal_id);
    CREATE INDEX IF NOT EXISTS idx_hierarchy_work_objects_parent ON hierarchy_work_objects(parent_work_object_id);
    CREATE INDEX IF NOT EXISTS idx_hierarchy_work_objects_status ON hierarchy_work_objects(status);
  `);
  return db;
}

function normalizeList(value: unknown, maxItems = 100): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|,/g)
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const item = String(entry ?? "").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    return normalizeList(JSON.parse(raw));
  } catch {
    return normalizeList(raw);
  }
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const candidate = String(value ?? "").trim();
  return allowed.includes(candidate as T) ? (candidate as T) : fallback;
}

function mapRow(row: WorkObjectRow): WorkObject {
  return {
    id: row.id,
    organizationId: row.organization_id,
    goalId: row.goal_id,
    parentWorkObjectId: row.parent_work_object_id,
    type: normalizeEnum(row.type, TYPES, "task"),
    title: row.title,
    description: row.description,
    ownerAgentId: row.owner_agent_id,
    status: normalizeEnum(row.status, STATUSES, "planned"),
    priority: normalizeEnum(row.priority, PRIORITIES, "medium"),
    linkedTaskIds: parseList(row.linked_task_ids),
    linkedWorkflowIds: parseList(row.linked_workflow_ids),
    linkedDocumentIds: parseList(row.linked_document_ids),
    linkedCouncilSessionIds: parseList(row.linked_council_session_ids),
    linkedExecutionIds: parseList(row.linked_execution_ids),
    decisionIds: parseList(row.decision_ids),
    deliverables: parseList(row.deliverables),
    blockers: parseList(row.blockers),
    riskLevel: normalizeEnum(row.risk_level, RISKS, "low"),
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resolveOrganizationId(input?: string | null): string | null {
  if (input !== undefined) {
    return input ? resolveHierarchyOrganization(input)?.id ?? input : null;
  }
  return getActiveHierarchyOrganization()?.id ?? null;
}

function getById(id: string): WorkObject | null {
  const db = ensureWorkObjectTables();
  const row = db.prepare("SELECT * FROM hierarchy_work_objects WHERE id = ?").get(id) as WorkObjectRow | undefined;
  return row ? mapRow(row) : null;
}

export function listWorkObjects(input?: {
  organizationId?: string | null;
  goalId?: string | null;
  status?: WorkObjectStatus | null;
  type?: WorkObjectType | null;
}): WorkObject[] {
  const db = ensureWorkObjectTables();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input?.organizationId) {
    clauses.push("organization_id = ?");
    params.push(input.organizationId);
  }
  if (input?.goalId) {
    clauses.push("goal_id = ?");
    params.push(input.goalId);
  }
  if (input?.status) {
    clauses.push("status = ?");
    params.push(input.status);
  }
  if (input?.type) {
    clauses.push("type = ?");
    params.push(input.type);
  }
  const sql = `SELECT * FROM hierarchy_work_objects${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_at DESC, created_at DESC`;
  return (db.prepare(sql).all(...params) as WorkObjectRow[]).map(mapRow);
}

export function getWorkObjectById(id: string): WorkObject | null {
  return getById(id);
}

export function getRootWorkObjectForGoal(goalId: string): WorkObject | null {
  const db = ensureWorkObjectTables();
  const row = db
    .prepare("SELECT * FROM hierarchy_work_objects WHERE goal_id = ? AND type = 'goal' ORDER BY created_at ASC LIMIT 1")
    .get(goalId) as WorkObjectRow | undefined;
  return row ? mapRow(row) : null;
}

export function createWorkObject(input: {
  organizationId?: string | null;
  goalId?: string | null;
  parentWorkObjectId?: string | null;
  type: WorkObjectType;
  title: string;
  description?: string | null;
  ownerAgentId?: string | null;
  status?: WorkObjectStatus | null;
  priority?: WorkObjectPriority | null;
  linkedTaskIds?: string[];
  linkedWorkflowIds?: string[];
  linkedDocumentIds?: string[];
  linkedCouncilSessionIds?: string[];
  linkedExecutionIds?: string[];
  decisionIds?: string[];
  deliverables?: string[];
  blockers?: string[];
  riskLevel?: WorkObjectRiskLevel | null;
  dueAt?: string | null;
}): WorkObject {
  const db = ensureWorkObjectTables();
  const title = String(input.title || "").trim();
  if (!title) throw new Error("Work object title is required");
  const id = nanoid(12);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO hierarchy_work_objects (
      id, organization_id, goal_id, parent_work_object_id, type, title, description, owner_agent_id,
      status, priority, linked_task_ids, linked_workflow_ids, linked_document_ids,
      linked_council_session_ids, linked_execution_ids, decision_ids, deliverables, blockers,
      risk_level, due_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    resolveOrganizationId(input.organizationId),
    input.goalId ?? null,
    input.parentWorkObjectId ?? null,
    input.type,
    title,
    input.description ?? null,
    input.ownerAgentId ?? null,
    normalizeEnum(input.status, STATUSES, "planned"),
    normalizeEnum(input.priority, PRIORITIES, "medium"),
    JSON.stringify(normalizeList(input.linkedTaskIds)),
    JSON.stringify(normalizeList(input.linkedWorkflowIds)),
    JSON.stringify(normalizeList(input.linkedDocumentIds)),
    JSON.stringify(normalizeList(input.linkedCouncilSessionIds)),
    JSON.stringify(normalizeList(input.linkedExecutionIds)),
    JSON.stringify(normalizeList(input.decisionIds)),
    JSON.stringify(normalizeList(input.deliverables)),
    JSON.stringify(normalizeList(input.blockers)),
    normalizeEnum(input.riskLevel, RISKS, "low"),
    input.dueAt ?? null,
    now,
    now,
  );
  return getById(id)!;
}

export function ensureGoalWorkObject(input: {
  goalId: string;
  organizationId?: string | null;
  title: string;
  description?: string | null;
  deliverables?: string[];
  status?: WorkObjectStatus | null;
}): WorkObject {
  const existing = getRootWorkObjectForGoal(input.goalId);
  if (existing) return existing;
  return createWorkObject({
    organizationId: input.organizationId,
    goalId: input.goalId,
    type: "goal",
    title: input.title,
    description: input.description,
    deliverables: input.deliverables,
    status: input.status ?? "planned",
  });
}

export function updateWorkObject(id: string, input: Partial<Omit<WorkObject, "id" | "createdAt" | "updatedAt">>): WorkObject {
  const existing = getById(id);
  if (!existing) throw new Error(`Work object not found: ${id}`);
  const next = { ...existing, ...input };
  const db = ensureWorkObjectTables();
  db.prepare(`
    UPDATE hierarchy_work_objects SET
      organization_id = ?, goal_id = ?, parent_work_object_id = ?, type = ?, title = ?, description = ?,
      owner_agent_id = ?, status = ?, priority = ?, linked_task_ids = ?, linked_workflow_ids = ?,
      linked_document_ids = ?, linked_council_session_ids = ?, linked_execution_ids = ?, decision_ids = ?,
      deliverables = ?, blockers = ?, risk_level = ?, due_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.organizationId,
    next.goalId,
    next.parentWorkObjectId,
    normalizeEnum(next.type, TYPES, existing.type),
    String(next.title || existing.title).trim(),
    next.description,
    next.ownerAgentId,
    normalizeEnum(next.status, STATUSES, existing.status),
    normalizeEnum(next.priority, PRIORITIES, existing.priority),
    JSON.stringify(normalizeList(next.linkedTaskIds)),
    JSON.stringify(normalizeList(next.linkedWorkflowIds)),
    JSON.stringify(normalizeList(next.linkedDocumentIds)),
    JSON.stringify(normalizeList(next.linkedCouncilSessionIds)),
    JSON.stringify(normalizeList(next.linkedExecutionIds)),
    JSON.stringify(normalizeList(next.decisionIds)),
    JSON.stringify(normalizeList(next.deliverables)),
    JSON.stringify(normalizeList(next.blockers)),
    normalizeEnum(next.riskLevel, RISKS, existing.riskLevel),
    next.dueAt,
    new Date().toISOString(),
    id,
  );
  return getById(id)!;
}

export function linkWorkObject(id: string, link: {
  taskId?: string;
  workflowId?: string;
  documentId?: string;
  councilSessionId?: string;
  executionId?: string;
  decisionId?: string;
}): WorkObject {
  const existing = getById(id);
  if (!existing) throw new Error(`Work object not found: ${id}`);
  return updateWorkObject(id, {
    linkedTaskIds: link.taskId ? normalizeList([...existing.linkedTaskIds, link.taskId]) : existing.linkedTaskIds,
    linkedWorkflowIds: link.workflowId ? normalizeList([...existing.linkedWorkflowIds, link.workflowId]) : existing.linkedWorkflowIds,
    linkedDocumentIds: link.documentId ? normalizeList([...existing.linkedDocumentIds, link.documentId]) : existing.linkedDocumentIds,
    linkedCouncilSessionIds: link.councilSessionId ? normalizeList([...existing.linkedCouncilSessionIds, link.councilSessionId]) : existing.linkedCouncilSessionIds,
    linkedExecutionIds: link.executionId ? normalizeList([...existing.linkedExecutionIds, link.executionId]) : existing.linkedExecutionIds,
    decisionIds: link.decisionId ? normalizeList([...existing.decisionIds, link.decisionId]) : existing.decisionIds,
  });
}
