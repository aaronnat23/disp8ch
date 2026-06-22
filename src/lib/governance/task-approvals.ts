import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

const log = logger.child("governance:task-approvals");

export type TaskApprovalStatus = "pending" | "approved" | "rejected" | "revision_requested";

export type TaskApproval = {
  id: string;
  taskId: string;
  approverType: "user" | "agent";
  approverId: string | null;
  status: TaskApprovalStatus;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export function createTaskApproval(params: {
  taskId: string;
  approverType?: "user" | "agent";
  approverId?: string | null;
}): TaskApproval {
  initializeDatabase();
  const db = getSqlite();
  const approval: TaskApproval = {
    id: nanoid(12),
    taskId: params.taskId,
    approverType: params.approverType ?? "user",
    approverId: params.approverId ?? null,
    status: "pending",
    decisionNote: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO task_approvals (id, task_id, approver_type, approver_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(approval.id, approval.taskId, approval.approverType, approval.approverId, approval.status, approval.createdAt);
  log.info("Task approval created", { id: approval.id, taskId: approval.taskId });
  return approval;
}

export function resolveTaskApproval(params: {
  id: string;
  decision: "approved" | "rejected" | "revision_requested";
  decisionNote?: string;
}): TaskApproval {
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE task_approvals SET status = ?, decision_note = ?, decided_at = ? WHERE id = ?`
  ).run(params.decision, params.decisionNote ?? null, now, params.id);
  const row = db.prepare("SELECT * FROM task_approvals WHERE id = ?").get(params.id) as {
    id: string; task_id: string; approver_type: string; approver_id: string | null;
    status: string; decision_note: string | null; decided_at: string | null; created_at: string;
  } | undefined;
  if (!row) throw new Error(`Approval ${params.id} not found`);
  log.info("Task approval resolved", { id: params.id, decision: params.decision });
  return mapApprovalRow(row);
}

export function listTaskApprovals(params?: {
  taskId?: string;
  status?: TaskApprovalStatus;
  limit?: number;
}): TaskApproval[] {
  initializeDatabase();
  const db = getSqlite();
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params?.taskId) { conditions.push("task_id = ?"); values.push(params.taskId); }
  if (params?.status) { conditions.push("status = ?"); values.push(params.status); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(params?.limit ?? 50, 200);
  const rows = db.prepare(
    `SELECT * FROM task_approvals ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...values, limit) as Array<{
    id: string; task_id: string; approver_type: string; approver_id: string | null;
    status: string; decision_note: string | null; decided_at: string | null; created_at: string;
  }>;
  return rows.map(mapApprovalRow);
}

export function getTaskApprovalGate(taskId: string): { requiresApproval: boolean; pending: TaskApproval | null; approved: boolean } {
  const approvals = listTaskApprovals({ taskId });
  const pending = approvals.find(a => a.status === "pending") ?? null;
  const approved = approvals.some(a => a.status === "approved");
  return { requiresApproval: approvals.length > 0, pending, approved };
}

function mapApprovalRow(r: {
  id: string; task_id: string; approver_type: string; approver_id: string | null;
  status: string; decision_note: string | null; decided_at: string | null; created_at: string;
}): TaskApproval {
  return {
    id: r.id, taskId: r.task_id, approverType: r.approver_type as "user" | "agent",
    approverId: r.approver_id, status: r.status as TaskApprovalStatus,
    decisionNote: r.decision_note, decidedAt: r.decided_at, createdAt: r.created_at,
  };
}
