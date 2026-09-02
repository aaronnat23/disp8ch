import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getWorkspaceDir } from "@/lib/workspace/files";
import fs from "node:fs";
import { listSkillFileRevisions, rollbackSkillFileRevision, skillContentHash, SkillRevisionConflictError } from "@/lib/skills/version-history";
import { assertCanonicalPathInsideRoot } from "@/lib/security/path-safety";

const RollbackSchema = z.object({ skillPath: z.string().min(1).max(4_096), revisionId: z.string().min(1).max(128), expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/i), confirmed: z.literal(true) });
function safeSkillPath(raw: string): string {
  const root = path.join(getWorkspaceDir(), "skills");
  const resolved = assertCanonicalPathInsideRoot(path.resolve(raw), root);
  if (path.basename(resolved) !== "SKILL.md") throw new Error("Only workspace SKILL.md files have version history");
  return resolved;
}
export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request); if (denied) return denied;
  try { const raw = new URL(request.url).searchParams.get("skillPath"); if (!raw) return NextResponse.json({ success: false, error: "Missing skillPath" }, { status: 400 }); const skillPath = safeSkillPath(raw); const current = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf8") : ""; return NextResponse.json({ success: true, data: listSkillFileRevisions(skillPath), currentContentHash: skillContentHash(current) }); }
  catch (error) { return NextResponse.json({ success: false, error: String(error) }, { status: 400 }); }
}
export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request); if (denied) return denied;
  try { const parsed = RollbackSchema.parse(await request.json()); return NextResponse.json({ success: true, data: rollbackSkillFileRevision({ skillPath: safeSkillPath(parsed.skillPath), revisionId: parsed.revisionId, expectedContentHash: parsed.expectedContentHash }) }); }
  catch (error) { return NextResponse.json({ success: false, error: String(error), code: error instanceof SkillRevisionConflictError ? "skill_revision_conflict" : undefined }, { status: error instanceof SkillRevisionConflictError ? 409 : 400 }); }
}
