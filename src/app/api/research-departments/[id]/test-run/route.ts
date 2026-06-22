import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getDepartment } from "@/lib/research-department/store";
import { computeVaultPaths } from "@/lib/research-department/vault";
import {
  archiveBrief,
  deterministicBrief,
  deterministicSynthesize,
  preflightInbox,
  writeFinding,
} from "@/lib/research-department/runtime";

export const dynamic = "force-dynamic";

/**
 * Deterministic, model-free test run that proves the full file pipeline:
 * seed a Scout finding -> Analyst synthesis (wiki note + processed move) ->
 * Briefer archive. Makes zero model calls so it is safe for default install
 * tests and needs no credentials.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const dept = getDepartment(id);
    if (!dept) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const seed = body?.seed !== false; // default true
    const paths = computeVaultPaths(dept.vaultRoot);

    const findings: string[] = [];
    if (seed) {
      const keyword = dept.keywords[0] || dept.focusArea.split(/\s+/)[0] || "topic";
      const findingPath = writeFinding(paths, {
        sourceUrl: "https://example.com/test-run-item",
        sourceType: "test",
        title: `Test-run signal for ${dept.focusArea}`,
        body: `Captured during a test run for the "${dept.name}" research department.`,
        keyword,
      });
      findings.push(findingPath);
    }

    const preflight = preflightInbox(paths);
    const synthesis = deterministicSynthesize(paths, dept.focusArea);
    const brief = deterministicBrief(paths);
    const briefPath = archiveBrief(paths, { content: brief });

    return NextResponse.json({
      success: true,
      data: {
        departmentId: id,
        modelCalls: 0,
        seededFinding: findings[0] ?? null,
        inboxPreflight: preflight,
        wikiNote: synthesis?.wikiNotePath ?? null,
        processedMoved: synthesis?.movedFiles ?? [],
        briefPath,
        brief,
        vaultRoot: paths.root,
        briefExists: fs.existsSync(briefPath),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
