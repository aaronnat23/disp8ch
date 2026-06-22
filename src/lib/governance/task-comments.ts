import { getSqlite, withSqliteWriteRecovery } from "@/lib/db";
import { randomUUID } from "node:crypto";

export type TaskComment = {
  id: string;
  taskId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export function addTaskComment(params: {
  taskId: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  body: string;
}): TaskComment {
  const id = `tc_${randomUUID()}`;
  const now = new Date().toISOString();
  withSqliteWriteRecovery("task comment add", (db) =>
    db
      .prepare(
        `INSERT INTO task_comments (id, task_id, author_agent_id, author_user_id, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.taskId,
        params.authorAgentId ?? null,
        params.authorUserId ?? null,
        params.body,
        now,
        now,
      ),
  );
  return {
    id,
    taskId: params.taskId,
    authorAgentId: params.authorAgentId ?? null,
    authorUserId: params.authorUserId ?? null,
    body: params.body,
    createdAt: now,
    updatedAt: now,
  };
}

export function listTaskComments(taskId: string): TaskComment[] {
  try {
    const db = getSqlite();
    const rows = db
      .prepare(
        `SELECT id, task_id, author_agent_id, author_user_id, body, created_at, updated_at
         FROM task_comments WHERE task_id = ? ORDER BY created_at ASC`,
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

export function deleteTaskComment(id: string): void {
  withSqliteWriteRecovery("task comment delete", (db) =>
    db.prepare(`DELETE FROM task_comments WHERE id = ?`).run(id),
  );
}

function mapRow(r: Record<string, unknown>): TaskComment {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    authorAgentId: r.author_agent_id != null ? String(r.author_agent_id) : null,
    authorUserId: r.author_user_id != null ? String(r.author_user_id) : null,
    body: String(r.body),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
