import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

const log = logger.child("governance:task-labels");

export type TaskLabel = {
  id: string;
  name: string;
  color: string;
  scope: string;
  createdAt: string;
};

export function listTaskLabels(): TaskLabel[] {
  initializeDatabase();
  const db = getSqlite();
  const rows = db.prepare("SELECT * FROM task_labels ORDER BY name").all() as Array<{
    id: string; name: string; color: string; scope: string; created_at: string;
  }>;
  return rows.map(r => ({ id: r.id, name: r.name, color: r.color, scope: r.scope, createdAt: r.created_at }));
}

export function createTaskLabel(params: { name: string; color?: string; scope?: string }): TaskLabel {
  initializeDatabase();
  const db = getSqlite();
  const label: TaskLabel = {
    id: nanoid(12),
    name: params.name.trim(),
    color: params.color ?? "#ff0000",
    scope: params.scope ?? "global",
    createdAt: new Date().toISOString(),
  };
  db.prepare("INSERT INTO task_labels (id, name, color, scope, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(label.id, label.name, label.color, label.scope, label.createdAt);
  log.info("Task label created", { id: label.id, name: label.name });
  return label;
}

export function deleteTaskLabel(labelId: string): void {
  initializeDatabase();
  const db = getSqlite();
  db.prepare("DELETE FROM task_label_assignments WHERE label_id = ?").run(labelId);
  db.prepare("DELETE FROM task_labels WHERE id = ?").run(labelId);
  log.info("Task label deleted", { id: labelId });
}

export function assignLabelToTask(taskId: string, labelId: string): void {
  initializeDatabase();
  const db = getSqlite();
  db.prepare("INSERT OR IGNORE INTO task_label_assignments (task_id, label_id) VALUES (?, ?)").run(taskId, labelId);
}

export function removeLabelFromTask(taskId: string, labelId: string): void {
  initializeDatabase();
  const db = getSqlite();
  db.prepare("DELETE FROM task_label_assignments WHERE task_id = ? AND label_id = ?").run(taskId, labelId);
}

export function getLabelsForTask(taskId: string): TaskLabel[] {
  initializeDatabase();
  const db = getSqlite();
  const rows = db.prepare(
    `SELECT l.* FROM task_labels l
     JOIN task_label_assignments a ON a.label_id = l.id
     WHERE a.task_id = ?
     ORDER BY l.name`
  ).all(taskId) as Array<{ id: string; name: string; color: string; scope: string; created_at: string }>;
  return rows.map(r => ({ id: r.id, name: r.name, color: r.color, scope: r.scope, createdAt: r.created_at }));
}

export function getLabelsForTasks(taskIds: string[]): Record<string, TaskLabel[]> {
  if (taskIds.length === 0) return {};
  initializeDatabase();
  const db = getSqlite();
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT a.task_id, l.* FROM task_labels l
     JOIN task_label_assignments a ON a.label_id = l.id
     WHERE a.task_id IN (${placeholders})
     ORDER BY l.name`
  ).all(...taskIds) as Array<{ task_id: string; id: string; name: string; color: string; scope: string; created_at: string }>;
  const result: Record<string, TaskLabel[]> = {};
  for (const r of rows) {
    if (!result[r.task_id]) result[r.task_id] = [];
    result[r.task_id].push({ id: r.id, name: r.name, color: r.color, scope: r.scope, createdAt: r.created_at });
  }
  return result;
}
