import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";

export type SessionTodoItem = {
  id: string;
  sessionId: string;
  content: string;
  isDone: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type SessionTodoRow = {
  id: string;
  session_id: string;
  content: string;
  is_done: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function rowToItem(row: SessionTodoRow): SessionTodoItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    content: row.content,
    isDone: row.is_done === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export function listSessionTodos(sessionIdRaw: string): SessionTodoItem[] {
  initializeDatabase();
  const sessionId = String(sessionIdRaw || "").trim();
  if (!sessionId) return [];
  const rows = getSqlite()
    .prepare(`
      SELECT id, session_id, content, is_done, sort_order, created_at, updated_at
      FROM session_todos
      WHERE session_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `)
    .all(sessionId) as SessionTodoRow[];
  return rows.map(rowToItem);
}

export function createSessionTodo(sessionIdRaw: string, contentRaw: string): SessionTodoItem {
  initializeDatabase();
  const sessionId = String(sessionIdRaw || "").trim();
  const content = String(contentRaw || "").trim();
  if (!sessionId) throw new Error("sessionId is required");
  if (!content) throw new Error("content is required");
  const db = getSqlite();
  const now = nowIso();
  const nextSortOrderRow = db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order FROM session_todos WHERE session_id = ?")
    .get(sessionId) as { max_sort_order?: number } | undefined;
  const item: SessionTodoItem = {
    id: nanoid(10),
    sessionId,
    content,
    isDone: false,
    sortOrder: Number(nextSortOrderRow?.max_sort_order ?? -1) + 1,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(`
    INSERT INTO session_todos (id, session_id, content, is_done, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?)
  `).run(item.id, item.sessionId, item.content, item.sortOrder, item.createdAt, item.updatedAt);
  return item;
}

export function updateSessionTodo(params: {
  sessionId: string;
  todoId: string;
  content?: string | null;
  isDone?: boolean | null;
  sortOrder?: number | null;
}): SessionTodoItem | null {
  initializeDatabase();
  const sessionId = String(params.sessionId || "").trim();
  const todoId = String(params.todoId || "").trim();
  if (!sessionId || !todoId) return null;
  const existing = getSqlite()
    .prepare(`
      SELECT id, session_id, content, is_done, sort_order, created_at, updated_at
      FROM session_todos
      WHERE session_id = ? AND id = ?
      LIMIT 1
    `)
    .get(sessionId, todoId) as SessionTodoRow | undefined;
  if (!existing) return null;
  const nextContent = params.content === undefined || params.content === null
    ? existing.content
    : String(params.content).trim();
  if (!nextContent) throw new Error("content cannot be empty");
  const nextIsDone = params.isDone === undefined || params.isDone === null
    ? existing.is_done === 1
    : params.isDone;
  const nextSortOrder = params.sortOrder === undefined || params.sortOrder === null
    ? existing.sort_order
    : Math.max(0, Math.floor(params.sortOrder));
  const now = nowIso();
  getSqlite()
    .prepare(`
      UPDATE session_todos
      SET content = ?, is_done = ?, sort_order = ?, updated_at = ?
      WHERE session_id = ? AND id = ?
    `)
    .run(nextContent, nextIsDone ? 1 : 0, nextSortOrder, now, sessionId, todoId);
  return listSessionTodos(sessionId).find((item) => item.id === todoId) ?? null;
}

export function deleteSessionTodo(sessionIdRaw: string, todoIdRaw: string): boolean {
  initializeDatabase();
  const sessionId = String(sessionIdRaw || "").trim();
  const todoId = String(todoIdRaw || "").trim();
  if (!sessionId || !todoId) return false;
  const result = getSqlite()
    .prepare("DELETE FROM session_todos WHERE session_id = ? AND id = ?")
    .run(sessionId, todoId);
  return result.changes > 0;
}

export function clearCompletedSessionTodos(sessionIdRaw: string): number {
  initializeDatabase();
  const sessionId = String(sessionIdRaw || "").trim();
  if (!sessionId) return 0;
  const result = getSqlite()
    .prepare("DELETE FROM session_todos WHERE session_id = ? AND is_done = 1")
    .run(sessionId);
  return result.changes;
}
