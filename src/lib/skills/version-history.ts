import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { getWorkspaceDir } from "@/lib/workspace/files";
import { scanSkillContent } from "@/lib/learning/skill-guard";

export type SkillFileRevision = { id: string; skillPath: string; content: string; source: "proposal" | "rollback"; proposalId: string | null; contentHash: string; createdAt: string };

export class SkillRevisionConflictError extends Error {
  constructor() {
    super("This skill changed after version history was opened. Reload the versions and review the newer content before restoring.");
    this.name = "SkillRevisionConflictError";
  }
}

const MAX_SKILL_CONTENT_BYTES = 1_000_000;

function revisionRoot(): string { return path.join(getWorkspaceDir(), "skill-revisions"); }
function keyForPath(skillPath: string): string { return crypto.createHash("sha256").update(path.resolve(skillPath)).digest("hex").slice(0, 20); }
export function skillContentHash(content: string): string { return crypto.createHash("sha256").update(content).digest("hex"); }

export function deleteSkillFileRevision(skillPath: string, revisionId: string): void {
  const cleanId = String(revisionId || "").trim();
  if (!/^skill_rev_[A-Za-z0-9_-]+$/.test(cleanId)) return;
  const revisionFile = path.join(revisionRoot(), keyForPath(skillPath), `${cleanId}.json`);
  try {
    if (fs.existsSync(revisionFile)) fs.unlinkSync(revisionFile);
  } catch {
    // Best-effort cleanup for a staged revision after a failed write.
  }
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${nanoid(8)}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, content, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

export function recordSkillFileRevision(input: { skillPath: string; content: string; source: SkillFileRevision["source"]; proposalId?: string | null }): SkillFileRevision {
  if (Buffer.byteLength(input.content, "utf8") > MAX_SKILL_CONTENT_BYTES) throw new Error("Skill content exceeds the 1 MB version-history limit");
  const revision: SkillFileRevision = { id: `skill_rev_${nanoid(12)}`, skillPath: path.resolve(input.skillPath), content: input.content, source: input.source, proposalId: input.proposalId ?? null, contentHash: skillContentHash(input.content), createdAt: new Date().toISOString() };
  const dir = path.join(revisionRoot(), keyForPath(revision.skillPath));
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, `${revision.id}.json`), `${JSON.stringify(revision, null, 2)}\n`);
  return revision;
}

export function listSkillFileRevisions(skillPath: string): SkillFileRevision[] {
  const dir = path.join(revisionRoot(), keyForPath(skillPath));
  if (!fs.existsSync(dir)) return [];
  const resolvedSkillPath = path.resolve(skillPath);
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).flatMap((name) => {
    try {
      const revisionPath = path.join(dir, name);
      const stat = fs.lstatSync(revisionPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_000_000) return [];
      const parsed = JSON.parse(fs.readFileSync(revisionPath, "utf8")) as Partial<SkillFileRevision>;
      if (
        typeof parsed.id !== "string"
        || !parsed.id.startsWith("skill_rev_")
        || typeof parsed.skillPath !== "string"
        || path.resolve(parsed.skillPath) !== resolvedSkillPath
        || typeof parsed.content !== "string"
        || typeof parsed.contentHash !== "string"
        || skillContentHash(parsed.content) !== parsed.contentHash
        || (parsed.source !== "proposal" && parsed.source !== "rollback")
        || typeof parsed.createdAt !== "string"
      ) return [];
      return [parsed as SkillFileRevision];
    } catch {
      return [];
    }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}

export function rollbackSkillFileRevision(input: { skillPath: string; revisionId: string; expectedContentHash: string }): SkillFileRevision {
  const target = listSkillFileRevisions(input.skillPath).find((revision) => revision.id === input.revisionId);
  if (!target || path.resolve(target.skillPath) !== path.resolve(input.skillPath)) throw new Error("Skill revision not found");
  const scan = scanSkillContent(target.content);
  if (!scan.safe) throw new Error(`Archived skill revision failed the current security scan: ${scan.threats.join(", ")}`);
  if (fs.existsSync(input.skillPath)) {
    const stat = fs.lstatSync(input.skillPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
      throw new Error("Skill rollback requires a regular, non-linked SKILL.md file");
    }
    if (stat.size > MAX_SKILL_CONTENT_BYTES) {
      throw new Error("Current skill content exceeds the 1 MB version-history limit");
    }
  }
  const current = fs.existsSync(input.skillPath) ? fs.readFileSync(input.skillPath, "utf8") : "";
  if (skillContentHash(current) !== input.expectedContentHash) throw new SkillRevisionConflictError();
  if (current === target.content) return target;
  const preserved = recordSkillFileRevision({ skillPath: input.skillPath, content: current, source: "rollback", proposalId: null });
  try {
    atomicWrite(input.skillPath, target.content);
  } catch (error) {
    deleteSkillFileRevision(input.skillPath, preserved.id);
    throw error;
  }
  return target;
}
