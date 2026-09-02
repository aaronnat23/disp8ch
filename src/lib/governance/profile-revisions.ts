import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";

export type ProfileRevision = {
  id: string;
  agentId: string;
  fileName: string;
  beforeContent: string;
  afterContent: string;
  source: "edit" | "rollback";
  rolledBackFromRevisionId: string | null;
  createdAt: string;
};

export function profileContentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function recordProfileRevision(input: Omit<ProfileRevision, "id" | "createdAt">): ProfileRevision {
  initializeDatabase();
  const revision: ProfileRevision = {
    ...input,
    id: `profile_rev_${nanoid(12)}`,
    createdAt: new Date().toISOString(),
  };
  getSqlite().prepare(`
    INSERT INTO profile_file_revisions (
      id, agent_id, file_name, before_content, after_content, source,
      rolled_back_from_revision_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    revision.id,
    revision.agentId,
    revision.fileName,
    revision.beforeContent,
    revision.afterContent,
    revision.source,
    revision.rolledBackFromRevisionId,
    revision.createdAt,
  );
  return revision;
}

export function listProfileRevisions(agentId: string, fileName?: string | null, limit = 20): ProfileRevision[] {
  initializeDatabase();
  const db = getSqlite();
  const boundedLimit = Math.max(1, Math.min(100, limit));
  const rows = (fileName
    ? db.prepare("SELECT * FROM profile_file_revisions WHERE agent_id = ? AND file_name = ? ORDER BY created_at DESC LIMIT ?").all(agentId, fileName, boundedLimit)
    : db.prepare("SELECT * FROM profile_file_revisions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?").all(agentId, boundedLimit)) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    agentId: String(row.agent_id),
    fileName: String(row.file_name),
    beforeContent: String(row.before_content),
    afterContent: String(row.after_content),
    source: row.source === "rollback" ? "rollback" : "edit",
    rolledBackFromRevisionId: row.rolled_back_from_revision_id ? String(row.rolled_back_from_revision_id) : null,
    createdAt: String(row.created_at),
  }));
}

export function getProfileRevision(id: string): ProfileRevision | null {
  initializeDatabase();
  const row = getSqlite().prepare("SELECT * FROM profile_file_revisions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    fileName: String(row.file_name),
    beforeContent: String(row.before_content),
    afterContent: String(row.after_content),
    source: row.source === "rollback" ? "rollback" : "edit",
    rolledBackFromRevisionId: row.rolled_back_from_revision_id ? String(row.rolled_back_from_revision_id) : null,
    createdAt: String(row.created_at),
  };
}

export function deleteProfileRevision(id: string): void {
  initializeDatabase();
  getSqlite().prepare("DELETE FROM profile_file_revisions WHERE id = ?").run(id);
}
