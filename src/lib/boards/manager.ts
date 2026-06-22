import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { listAgents } from "@/lib/agents/registry";
import { unscheduleCronWorkflow } from "@/lib/cron/manager";
import { canAgentAssignTarget } from "@/lib/hierarchy/delegation";
import { getHierarchyGoalById, resolveHierarchyGoal } from "@/lib/hierarchy/goals";
import { resolveHierarchyOrganization } from "@/lib/hierarchy/organizations";
import { pruneGeneratedScheduledBoardTasks } from "@/lib/maintenance/generated-artifacts";
import {
  listTagMapForTargets,
  setTagsForTarget,
  type TagRecord,
} from "@/lib/tags/manager";
import {
  getLabelsForTask,
  getLabelsForTasks,
  type TaskLabel,
} from "@/lib/governance/task-labels";

export type BoardTaskStatus = "inbox" | "in_progress" | "review" | "done" | "blocked";
export type BoardTaskPriority = "low" | "medium" | "high" | "urgent";

export type BoardRecord = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
};

export type BoardTaskRecord = {
  id: string;
  boardId: string;
  boardName: string | null;
  organizationId: string | null;
  goalId: string | null;
  goalName: string | null;
  title: string;
  description: string | null;
  workflowTemplateKey: string | null;
  workflowId: string | null;
  sourceType: string | null;
  sourceRef: string | null;
  linkedDocumentIds: string[];
  deliverables: string[];
  status: BoardTaskStatus;
  priority: BoardTaskPriority;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  checkedOutByAgentId: string | null;
  checkedOutByAgentName: string | null;
  checkedOutAt: string | null;
  executionLockedAt: string | null;
  executionRunId: string | null;
  parentId: string | null;
  requestDepth: number;
  requesterAgentId: string | null;
  subtaskCount: number;
  /** Disp8chTeam-style dependency: task IDs this task is blocked by. Auto-transitions to inbox when all blockers complete. */
  blockedBy: string[];
  tags: TagRecord[];
  labels: TaskLabel[];
  createdAt: string;
  updatedAt: string;
};

interface BoardRow {
  id: string;
  name: string;
  description: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface BoardTaskRow {
  id: string;
  board_id: string;
  organization_id: string | null;
  goal_id: string | null;
  title: string;
  description: string | null;
  workflow_template_key: string | null;
  workflow_id: string | null;
  source_type: string | null;
  source_ref: string | null;
  linked_document_ids?: string | null;
  deliverables?: string | null;
  status: string;
  priority: string;
  assigned_agent_id: string | null;
  checked_out_by_agent_id: string | null;
  checked_out_at: string | null;
  execution_locked_at: string | null;
  execution_run_id: string | null;
  parent_id: string | null;
  request_depth: number | null;
  requester_agent_id: string | null;
  blocked_by?: string | null;
  created_at: string;
  updated_at: string;
  board_name?: string | null;
  subtask_count?: number | null;
}

const ALLOWED_STATUSES: BoardTaskStatus[] = ["inbox", "in_progress", "review", "done", "blocked"];
const ALLOWED_PRIORITIES: BoardTaskPriority[] = ["low", "medium", "high", "urgent"];

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

function deriveLinkedDocumentIds(
  linkedDocumentIds: unknown,
  sourceType?: string | null,
  sourceRef?: string | null,
): string[] {
  const output = normalizeStringList(linkedDocumentIds);
  const normalizedType = String(sourceType || "").trim().toLowerCase();
  const normalizedRef = String(sourceRef || "").trim();
  if (
    normalizedRef &&
    ["data-source", "upload", "scrape", "integration"].includes(normalizedType) &&
    !output.includes(normalizedRef)
  ) {
    output.push(normalizedRef);
  }
  return output.slice(0, 24);
}

function ensureTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS board_tasks (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      workflow_template_key TEXT,
      workflow_id TEXT,
      source_type TEXT,
      source_ref TEXT,
      linked_document_ids TEXT,
      deliverables TEXT,
      organization_id TEXT,
      goal_id TEXT,
      status TEXT NOT NULL DEFAULT 'inbox',
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_agent_id TEXT,
      checked_out_by_agent_id TEXT,
      checked_out_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_board_tasks_board_id ON board_tasks(board_id);
    CREATE INDEX IF NOT EXISTS idx_board_tasks_status ON board_tasks(status);
  `);

  const taskCols = db.prepare("PRAGMA table_info(board_tasks)").all() as Array<{ name: string }>;
  const taskColNames = new Set(taskCols.map((column) => column.name));
  if (!taskColNames.has("workflow_template_key")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN workflow_template_key TEXT");
  }
  if (!taskColNames.has("workflow_id")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN workflow_id TEXT");
  }
  if (!taskColNames.has("source_type")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN source_type TEXT");
  }
  if (!taskColNames.has("source_ref")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN source_ref TEXT");
  }
  if (!taskColNames.has("linked_document_ids")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN linked_document_ids TEXT");
  }
  if (!taskColNames.has("deliverables")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN deliverables TEXT");
  }
  if (!taskColNames.has("organization_id")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN organization_id TEXT");
  }
  if (!taskColNames.has("goal_id")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN goal_id TEXT");
  }
  if (!taskColNames.has("checked_out_by_agent_id")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN checked_out_by_agent_id TEXT");
  }
  if (!taskColNames.has("checked_out_at")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN checked_out_at TEXT");
  }
  if (!taskColNames.has("execution_locked_at")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN execution_locked_at TEXT");
  }
  if (!taskColNames.has("execution_run_id")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN execution_run_id TEXT");
  }
  if (!taskColNames.has("request_depth")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN request_depth INTEGER DEFAULT 0");
  }
  if (!taskColNames.has("requester_agent_id")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN requester_agent_id TEXT");
  }
  if (!taskColNames.has("parent_id")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN parent_id TEXT");
  }
  if (!taskColNames.has("blocked_by")) {
    db.exec("ALTER TABLE board_tasks ADD COLUMN blocked_by TEXT");
  }

  const boardCountRow = db.prepare("SELECT COUNT(*) AS c FROM boards").get() as { c: number };
  if (Number(boardCountRow?.c || 0) === 0) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO boards (id, name, description, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run("main-board", "Main Board", "Default execution board", now, now);
  }

  return db;
}

function normalizeStatus(value: unknown): BoardTaskStatus {
  const status = String(value ?? "inbox").trim().toLowerCase();
  if (ALLOWED_STATUSES.includes(status as BoardTaskStatus)) {
    return status as BoardTaskStatus;
  }
  return "inbox";
}

function normalizePriority(value: unknown): BoardTaskPriority {
  const priority = String(value ?? "medium").trim().toLowerCase();
  if (ALLOWED_PRIORITIES.includes(priority as BoardTaskPriority)) {
    return priority as BoardTaskPriority;
  }
  return "medium";
}

function mapBoard(row: BoardRow, taskCount: number): BoardRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    taskCount,
  };
}

function mapTask(
  row: BoardTaskRow,
  agentsById: Map<string, string>,
  boardNameById: Map<string, string>,
  taskTagsById: Record<string, TagRecord[]>,
  taskLabelsById?: Record<string, TaskLabel[]>,
): BoardTaskRecord {
  const assignedAgentId = row.assigned_agent_id ? String(row.assigned_agent_id) : null;
  const checkedOutByAgentId = row.checked_out_by_agent_id ? String(row.checked_out_by_agent_id) : null;
  const goal = row.goal_id ? getHierarchyGoalById(row.goal_id) : null;
  return {
    id: row.id,
    boardId: row.board_id,
    boardName: row.board_name ?? boardNameById.get(row.board_id) ?? null,
    organizationId: row.organization_id ?? null,
    goalId: row.goal_id ?? null,
    goalName: goal?.name ?? null,
    title: row.title,
    description: row.description ?? null,
    workflowTemplateKey: row.workflow_template_key ?? null,
    workflowId: row.workflow_id ?? null,
    sourceType: row.source_type ?? null,
    sourceRef: row.source_ref ?? null,
    linkedDocumentIds: deriveLinkedDocumentIds(row.linked_document_ids ? parseStoredStringList(row.linked_document_ids) : [], row.source_type, row.source_ref),
    deliverables: parseStoredStringList(row.deliverables),
    status: normalizeStatus(row.status),
    priority: normalizePriority(row.priority),
    assignedAgentId,
    assignedAgentName: assignedAgentId ? agentsById.get(assignedAgentId) ?? null : null,
    checkedOutByAgentId,
    checkedOutByAgentName: checkedOutByAgentId ? agentsById.get(checkedOutByAgentId) ?? null : null,
    checkedOutAt: row.checked_out_at ?? null,
    executionLockedAt: row.execution_locked_at ?? null,
    executionRunId: row.execution_run_id ?? null,
    parentId: row.parent_id ?? null,
    requestDepth: row.request_depth ?? 0,
    requesterAgentId: row.requester_agent_id ?? null,
    subtaskCount: Number(row.subtask_count ?? 0),
    blockedBy: row.blocked_by ? (() => { try { return JSON.parse(row.blocked_by!) as string[]; } catch { return row.blocked_by!.split(",").map((s) => s.trim()).filter(Boolean); } })() : [],
    tags: taskTagsById[row.id] ?? [],
    labels: taskLabelsById ? (taskLabelsById[row.id] ?? []) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resolveGoalForTask(input: {
  goalId?: string | null;
  organizationId?: string | null;
}): { goalId: string | null; organizationId: string | null } {
  const requestedOrganizationId = input.organizationId
    ? (resolveHierarchyOrganization(input.organizationId)?.id ?? String(input.organizationId).trim())
    : null;
  if (!input.goalId) {
    return { goalId: null, organizationId: requestedOrganizationId };
  }
  const goal = resolveHierarchyGoal(input.goalId, requestedOrganizationId ?? undefined)
    ?? getHierarchyGoalById(String(input.goalId).trim());
  if (!goal) {
    throw new Error(`Goal not found: ${input.goalId}`);
  }
  if (requestedOrganizationId && goal.organizationId && goal.organizationId !== requestedOrganizationId) {
    throw new Error("Goal does not belong to the selected organization");
  }
  return {
    goalId: goal.id,
    organizationId: goal.organizationId ?? requestedOrganizationId,
  };
}

export function listBoards(): BoardRecord[] {
  const db = ensureTables();
  const rows = db.prepare(`
    SELECT b.*, COUNT(t.id) AS task_count
    FROM boards b
    LEFT JOIN board_tasks t ON t.board_id = b.id
    GROUP BY b.id
    ORDER BY b.updated_at DESC
  `).all() as Array<BoardRow & { task_count: number }>;

  return rows.map((row) => mapBoard(row, Number(row.task_count || 0)));
}

export function createBoard(input: { name: string; description?: string | null }): BoardRecord {
  const db = ensureTables();
  const name = String(input.name || "").trim();
  if (!name) {
    throw new Error("Board name is required");
  }

  const id = nanoid(12);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO boards (id, name, description, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(id, name, input.description ?? null, now, now);

  return listBoards().find((board) => board.id === id)!;
}

export function updateBoard(
  boardId: string,
  input: { name?: string; description?: string | null; isActive?: boolean },
): BoardRecord {
  const db = ensureTables();
  const existing = db.prepare("SELECT * FROM boards WHERE id = ?").get(boardId) as BoardRow | undefined;
  if (!existing) {
    throw new Error(`Board not found: ${boardId}`);
  }

  const now = new Date().toISOString();
  const nextName = input.name !== undefined ? String(input.name).trim() : existing.name;
  if (!nextName) {
    throw new Error("Board name is required");
  }

  db.prepare(`
    UPDATE boards
    SET name = ?, description = ?, is_active = ?, updated_at = ?
    WHERE id = ?
  `).run(
    nextName,
    input.description !== undefined ? input.description : existing.description,
    input.isActive !== undefined ? (input.isActive ? 1 : 0) : existing.is_active,
    now,
    boardId,
  );

  return listBoards().find((board) => board.id === boardId)!;
}

export function deleteBoard(boardId: string): void {
  const db = ensureTables();
  const taskIds = db.prepare("SELECT id FROM board_tasks WHERE board_id = ?").all(boardId) as Array<{ id: string }>;
  db.prepare("DELETE FROM board_tasks WHERE board_id = ?").run(boardId);
  db.prepare("DELETE FROM boards WHERE id = ?").run(boardId);
  for (const task of taskIds) {
    db.prepare("DELETE FROM tag_links WHERE target_type = 'task' AND target_id = ?").run(task.id);
  }
}

export function listBoardTasks(
  boardId?: string,
  filters?: {
    organizationId?: string | null;
    goalId?: string | null;
    assignedAgentId?: string | null;
    checkedOutByAgentId?: string | null;
  },
): BoardTaskRecord[] {
  const db = ensureTables();
  const rows = boardId
    ? (db.prepare(`
        SELECT t.*, b.name AS board_name,
          (SELECT COUNT(*) FROM board_tasks st WHERE st.parent_id = t.id) AS subtask_count
        FROM board_tasks t
        INNER JOIN boards b ON b.id = t.board_id
        WHERE t.board_id = ?
        ORDER BY t.updated_at DESC
      `).all(boardId) as BoardTaskRow[])
    : (db.prepare(`
        SELECT t.*, b.name AS board_name,
          (SELECT COUNT(*) FROM board_tasks st WHERE st.parent_id = t.id) AS subtask_count
        FROM board_tasks t
        INNER JOIN boards b ON b.id = t.board_id
        ORDER BY t.updated_at DESC
      `).all() as BoardTaskRow[]);

  const agentsById = new Map(listAgents().map((agent) => [agent.id, agent.name]));
  const boardNameById = new Map(listBoards().map((board) => [board.id, board.name]));
  const taskTagsById = listTagMapForTargets("task", rows.map((row) => row.id));
  const taskLabelsById = getLabelsForTasks(rows.map((row) => row.id));

  return rows
    .map((row) => mapTask(row, agentsById, boardNameById, taskTagsById, taskLabelsById))
    .filter((task) => (filters?.organizationId ? task.organizationId === filters.organizationId : true))
    .filter((task) => (filters?.goalId ? task.goalId === filters.goalId : true))
    .filter((task) => (filters?.assignedAgentId ? task.assignedAgentId === filters.assignedAgentId : true))
    .filter((task) => (filters?.checkedOutByAgentId ? task.checkedOutByAgentId === filters.checkedOutByAgentId : true));
}

export function getBoardTask(taskId: string): BoardTaskRecord | null {
  const db = ensureTables();
  const row = db.prepare(`
    SELECT t.*, b.name AS board_name,
      (SELECT COUNT(*) FROM board_tasks st WHERE st.parent_id = t.id) AS subtask_count
    FROM board_tasks t
    INNER JOIN boards b ON b.id = t.board_id
    WHERE t.id = ?
    LIMIT 1
  `).get(taskId) as BoardTaskRow | undefined;

  if (!row) return null;

  const agentsById = new Map(listAgents().map((agent) => [agent.id, agent.name]));
  const boardNameById = new Map(listBoards().map((board) => [board.id, board.name]));
  const taskTagsById = listTagMapForTargets("task", [row.id]);
  const taskLabelsById = getLabelsForTasks([row.id]);
  return mapTask(row, agentsById, boardNameById, taskTagsById, taskLabelsById);
}

export function createBoardTask(input: {
  boardId: string;
  organizationId?: string | null;
  goalId?: string | null;
  title: string;
  description?: string | null;
  workflowTemplateKey?: string | null;
  workflowId?: string | null;
  sourceType?: string | null;
  sourceRef?: string | null;
  linkedDocumentIds?: string[] | null;
  deliverables?: string[] | null;
  status?: BoardTaskStatus;
  priority?: BoardTaskPriority;
  assignedAgentId?: string | null;
  requesterAgentId?: string | null;
  parentId?: string | null;
  requestDepth?: number;
  /** Disp8chTeam-style dependency: list of task IDs this task depends on. Status set to 'blocked' until all blockers complete. */
  blockedBy?: string[] | null;
  tagIds?: string[];
}): BoardTaskRecord {
  const db = ensureTables();
  const boardId = String(input.boardId || "").trim();
  const title = String(input.title || "").trim();
  if (!boardId) throw new Error("boardId is required");
  if (!title) throw new Error("title is required");

  const board = db.prepare("SELECT id FROM boards WHERE id = ?").get(boardId) as { id: string } | undefined;
  if (!board) throw new Error(`Board not found: ${boardId}`);

  const { organizationId, goalId } = resolveGoalForTask({
    organizationId: input.organizationId,
    goalId: input.goalId,
  });
  const assignedAgentId = input.assignedAgentId ? String(input.assignedAgentId).trim() : null;
  if (
    assignedAgentId &&
    !canAgentAssignTarget({
      requesterAgentId: input.requesterAgentId,
      targetAgentId: assignedAgentId,
      organizationId,
    })
  ) {
    throw new Error("Assignment outside manager subtree is not allowed");
  }
  const now = new Date().toISOString();
  const id = nanoid(12);

  const parentId = input.parentId ? String(input.parentId).trim() : null;
  let requestDepth = 0;
  if (parentId) {
    const parentRow = db.prepare("SELECT request_depth FROM board_tasks WHERE id = ?").get(parentId) as { request_depth: number | null } | undefined;
    const parentDepth = parentRow?.request_depth ?? 0;
    requestDepth = Math.min(10, parentDepth + 1);
  }

  const blockedByIds = Array.isArray(input.blockedBy) ? input.blockedBy.filter(Boolean) : [];
  const blockedByJson = blockedByIds.length > 0 ? JSON.stringify(blockedByIds) : null;
  const linkedDocumentIds = deriveLinkedDocumentIds(input.linkedDocumentIds, input.sourceType, input.sourceRef);
  const deliverables = normalizeStringList(input.deliverables);
  // Auto-set status to blocked if blockers provided (overrides any explicit status)
  const effectiveStatus = blockedByIds.length > 0 ? "blocked" : normalizeStatus(input.status);

  db.prepare(`
    INSERT INTO board_tasks
      (id, board_id, organization_id, goal_id, title, description, workflow_template_key, workflow_id, source_type, source_ref, linked_document_ids, deliverables, status, priority, assigned_agent_id, parent_id, request_depth, blocked_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    boardId,
    organizationId,
    goalId,
    title,
    input.description ?? null,
    input.workflowTemplateKey ? String(input.workflowTemplateKey).trim() : null,
    input.workflowId ? String(input.workflowId).trim() : null,
    input.sourceType ? String(input.sourceType).trim() : null,
    input.sourceRef ? String(input.sourceRef).trim() : null,
    linkedDocumentIds.length > 0 ? JSON.stringify(linkedDocumentIds) : null,
    deliverables.length > 0 ? JSON.stringify(deliverables) : null,
    effectiveStatus,
    normalizePriority(input.priority),
    assignedAgentId,
    parentId,
    requestDepth,
    blockedByJson,
    now,
    now,
  );

  if (input.sourceType === "cron-generated") {
    pruneGeneratedScheduledBoardTasks(boardId);
  }

  if (Array.isArray(input.tagIds)) {
    setTagsForTarget("task", id, input.tagIds);
  }

  return listBoardTasks(boardId).find((task) => task.id === id)!;
}

export function updateBoardTask(
  taskId: string,
  input: {
    organizationId?: string | null;
    goalId?: string | null;
    title?: string;
    description?: string | null;
    workflowTemplateKey?: string | null;
    workflowId?: string | null;
    sourceType?: string | null;
    sourceRef?: string | null;
    linkedDocumentIds?: string[] | null;
    deliverables?: string[] | null;
    status?: BoardTaskStatus;
    priority?: BoardTaskPriority;
    assignedAgentId?: string | null;
    requesterAgentId?: string | null;
    checkedOutByAgentId?: string | null;
    checkedOutAt?: string | null;
    parentId?: string | null;
    blockedBy?: string[] | null;
    tagIds?: string[];
  },
): BoardTaskRecord {
  const db = ensureTables();
  const existing = db.prepare("SELECT * FROM board_tasks WHERE id = ?").get(taskId) as BoardTaskRow | undefined;
  if (!existing) throw new Error(`Task not found: ${taskId}`);

  const now = new Date().toISOString();
  const nextTitle = input.title !== undefined ? String(input.title).trim() : existing.title;
  if (!nextTitle) throw new Error("title is required");
  const { organizationId: nextOrganizationId, goalId: nextGoalId } =
    input.organizationId !== undefined || input.goalId !== undefined
      ? resolveGoalForTask({
          organizationId:
            input.organizationId !== undefined ? input.organizationId : existing.organization_id,
          goalId: input.goalId !== undefined ? input.goalId : existing.goal_id,
        })
      : { organizationId: existing.organization_id, goalId: existing.goal_id };
  const nextAssignedAgentId =
    input.assignedAgentId !== undefined
      ? (input.assignedAgentId ? String(input.assignedAgentId).trim() : null)
      : existing.assigned_agent_id;
  if (
    nextAssignedAgentId &&
    !canAgentAssignTarget({
      requesterAgentId: input.requesterAgentId,
      targetAgentId: nextAssignedAgentId,
      organizationId: nextOrganizationId,
    })
  ) {
    throw new Error("Assignment outside manager subtree is not allowed");
  }

  const nextParentId =
    input.parentId !== undefined
      ? (input.parentId ? String(input.parentId).trim() : null)
      : existing.parent_id ?? null;
  const nextBlockedBy =
    input.blockedBy !== undefined
      ? (Array.isArray(input.blockedBy) ? input.blockedBy.filter(Boolean) : [])
      : (() => {
          try {
            return existing.blocked_by ? (JSON.parse(existing.blocked_by) as string[]) : [];
          } catch {
            return [];
          }
        })();
  const nextBlockedByJson = nextBlockedBy.length > 0 ? JSON.stringify(nextBlockedBy) : null;
  const nextSourceType =
    input.sourceType !== undefined
      ? (input.sourceType ? String(input.sourceType).trim() : null)
      : existing.source_type;
  const nextSourceRef =
    input.sourceRef !== undefined
      ? (input.sourceRef ? String(input.sourceRef).trim() : null)
      : existing.source_ref;
  const nextLinkedDocumentIds =
    input.linkedDocumentIds !== undefined
      ? deriveLinkedDocumentIds(input.linkedDocumentIds, nextSourceType, nextSourceRef)
      : deriveLinkedDocumentIds(parseStoredStringList(existing.linked_document_ids), nextSourceType, nextSourceRef);
  const nextDeliverables =
    input.deliverables !== undefined
      ? normalizeStringList(input.deliverables)
      : parseStoredStringList(existing.deliverables);
  const nextStatus =
    nextBlockedBy.length > 0
      ? "blocked"
      : input.status !== undefined
        ? normalizeStatus(input.status)
        : normalizeStatus(existing.status);

  db.prepare(`
    UPDATE board_tasks
    SET organization_id = ?, goal_id = ?, title = ?, description = ?, workflow_template_key = ?, workflow_id = ?, source_type = ?, source_ref = ?, linked_document_ids = ?, deliverables = ?, status = ?, priority = ?, assigned_agent_id = ?, checked_out_by_agent_id = ?, checked_out_at = ?, parent_id = ?, blocked_by = ?, updated_at = ?
    WHERE id = ?
  `).run(
    nextOrganizationId,
    nextGoalId,
    nextTitle,
    input.description !== undefined ? input.description : existing.description,
    input.workflowTemplateKey !== undefined
      ? (input.workflowTemplateKey ? String(input.workflowTemplateKey).trim() : null)
      : existing.workflow_template_key,
    input.workflowId !== undefined
      ? (input.workflowId ? String(input.workflowId).trim() : null)
      : existing.workflow_id,
    nextSourceType,
    nextSourceRef,
    nextLinkedDocumentIds.length > 0 ? JSON.stringify(nextLinkedDocumentIds) : null,
    nextDeliverables.length > 0 ? JSON.stringify(nextDeliverables) : null,
    nextStatus,
    input.priority !== undefined ? normalizePriority(input.priority) : normalizePriority(existing.priority),
    nextAssignedAgentId,
    input.checkedOutByAgentId !== undefined
      ? (input.checkedOutByAgentId ? String(input.checkedOutByAgentId).trim() : null)
      : existing.checked_out_by_agent_id,
    input.checkedOutAt !== undefined ? input.checkedOutAt : existing.checked_out_at,
    nextParentId,
    nextBlockedByJson,
    now,
    taskId,
  );

  if (Array.isArray(input.tagIds)) {
    setTagsForTarget("task", taskId, input.tagIds);
  }

  // Auto-unblock: if this task just moved to 'done', scan for tasks blocked by it
  if (nextStatus === "done" && normalizeStatus(existing.status) !== "done") {
    const blockedTasks = db.prepare(
      "SELECT id, blocked_by FROM board_tasks WHERE status = 'blocked' AND blocked_by IS NOT NULL"
    ).all() as Array<{ id: string; blocked_by: string }>;
    for (const bt of blockedTasks) {
      try {
        const ids: string[] = JSON.parse(bt.blocked_by);
        const remaining = ids.filter((bid) => bid !== taskId);
        // Check if all remaining blockers are done
        const allDone = remaining.every((bid) => {
          const blocker = db.prepare("SELECT status FROM board_tasks WHERE id = ?").get(bid) as { status: string } | undefined;
          return !blocker || blocker.status === "done";
        });
        if (allDone) {
          const newBlockedBy = remaining.length > 0 ? JSON.stringify(remaining) : null;
          db.prepare("UPDATE board_tasks SET status = 'inbox', blocked_by = ?, updated_at = ? WHERE id = ?")
            .run(newBlockedBy, now, bt.id);
        }
      } catch { /* malformed blocked_by — skip */ }
    }
  }

  return listBoardTasks(existing.board_id).find((task) => task.id === taskId)!;
}

export function claimBoardTask(taskId: string, agentId: string): BoardTaskRecord {
  const task = getBoardTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.checkedOutByAgentId && task.checkedOutByAgentId !== agentId) {
    throw new Error(`Task is already checked out by ${task.checkedOutByAgentName || task.checkedOutByAgentId}`);
  }
  return updateBoardTask(taskId, {
    checkedOutByAgentId: agentId,
    checkedOutAt: task.checkedOutAt ?? new Date().toISOString(),
  });
}

export function releaseBoardTask(taskId: string, agentId?: string | null): BoardTaskRecord {
  const task = getBoardTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (agentId && task.checkedOutByAgentId && task.checkedOutByAgentId !== agentId) {
    throw new Error(`Task is checked out by ${task.checkedOutByAgentName || task.checkedOutByAgentId}`);
  }
  return updateBoardTask(taskId, {
    checkedOutByAgentId: null,
    checkedOutAt: null,
  });
}

export function deleteBoardTask(taskId: string): void {
  const db = ensureTables();
  const existing = db.prepare("SELECT workflow_id FROM board_tasks WHERE id = ?").get(taskId) as
    | { workflow_id: string | null }
    | undefined;
  if (!existing) {
    return;
  }

  if (existing.workflow_id) {
    const workflowRow = db
      .prepare("SELECT id, source_type, source_ref FROM workflows WHERE id = ?")
      .get(existing.workflow_id) as
      | { id: string; source_type: string | null; source_ref: string | null }
      | undefined;
    if (
      workflowRow &&
      String(workflowRow.source_type || "").trim().toLowerCase() === "board-task" &&
      String(workflowRow.source_ref || "").trim() === taskId
    ) {
      db.prepare("DELETE FROM workflows WHERE id = ?").run(workflowRow.id);
      db.prepare("DELETE FROM tag_links WHERE target_type = 'workflow' AND target_id = ?").run(workflowRow.id);
      unscheduleCronWorkflow(workflowRow.id);
    }
  }

  db.prepare("DELETE FROM board_tasks WHERE id = ?").run(taskId);
  db.prepare("DELETE FROM tag_links WHERE target_type = 'task' AND target_id = ?").run(taskId);
}

export function lockTaskForExecution(taskId: string, runId: string): BoardTaskRecord {
  const db = ensureTables();
  const existing = db.prepare("SELECT execution_locked_at, execution_run_id FROM board_tasks WHERE id = ?").get(taskId) as
    | { execution_locked_at: string | null; execution_run_id: string | null }
    | undefined;
  if (!existing) throw new Error(`Task not found: ${taskId}`);
  if (existing.execution_locked_at && existing.execution_run_id) {
    throw new Error(`Task ${taskId} is already locked by run ${existing.execution_run_id}`);
  }
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE board_tasks SET execution_locked_at = ?, execution_run_id = ?, updated_at = ? WHERE id = ?"
  ).run(now, runId, now, taskId);
  const task = getBoardTask(taskId);
  if (!task) throw new Error(`Task not found after lock: ${taskId}`);
  return task;
}

export function unlockTaskExecution(taskId: string, runId: string): void {
  const db = ensureTables();
  const existing = db.prepare("SELECT execution_run_id FROM board_tasks WHERE id = ?").get(taskId) as
    | { execution_run_id: string | null }
    | undefined;
  if (!existing) throw new Error(`Task not found: ${taskId}`);
  if (existing.execution_run_id && existing.execution_run_id !== runId) {
    throw new Error(`Task ${taskId} is locked by a different run: ${existing.execution_run_id}`);
  }
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE board_tasks SET execution_locked_at = NULL, execution_run_id = NULL, updated_at = ? WHERE id = ?"
  ).run(now, taskId);
}
