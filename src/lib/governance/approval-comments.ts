import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

const log = logger.child("governance:approval-comments");

export type ApprovalComment = {
  id: string;
  approvalId: string;
  authorType: "user" | "agent" | "system";
  authorId: string | null;
  comment: string;
  decision: string | null;
  createdAt: string;
};

export function addApprovalComment(params: {
  approvalId: string;
  authorType?: "user" | "agent" | "system";
  authorId?: string | null;
  comment: string;
  decision?: string | null;
}): ApprovalComment {
  initializeDatabase();
  const db = getSqlite();
  const entry: ApprovalComment = {
    id: nanoid(12),
    approvalId: params.approvalId,
    authorType: params.authorType ?? "user",
    authorId: params.authorId ?? null,
    comment: params.comment,
    decision: params.decision ?? null,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO approval_comments (id, approval_id, author_type, author_id, comment, decision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(entry.id, entry.approvalId, entry.authorType, entry.authorId, entry.comment, entry.decision, entry.createdAt);
  log.info("Approval comment added", { id: entry.id, approvalId: entry.approvalId });
  return entry;
}

export function listApprovalComments(approvalId: string): ApprovalComment[] {
  initializeDatabase();
  const db = getSqlite();
  const rows = db.prepare(
    "SELECT * FROM approval_comments WHERE approval_id = ? ORDER BY created_at ASC"
  ).all(approvalId) as Array<{
    id: string; approval_id: string; author_type: string; author_id: string | null;
    comment: string; decision: string | null; created_at: string;
  }>;
  return rows.map(r => ({
    id: r.id, approvalId: r.approval_id, authorType: r.author_type as "user" | "agent" | "system",
    authorId: r.author_id, comment: r.comment, decision: r.decision, createdAt: r.created_at,
  }));
}
