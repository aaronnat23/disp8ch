import { NextRequest, NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const orgId = searchParams.get("orgId");

  try {
    const db = getSqlite();

    const org = orgId
      ? (db.prepare("SELECT * FROM hierarchy_organizations WHERE id = ?").get(orgId) as Record<string, unknown> | undefined)
      : (db.prepare("SELECT * FROM hierarchy_organizations ORDER BY is_active DESC, updated_at DESC LIMIT 1").get() as Record<string, unknown> | undefined);

    if (!org) {
      return NextResponse.json({ success: false, error: "No organization found" }, { status: 404 });
    }

    let agents: unknown[] = [];
    try {
      agents = JSON.parse(String(org.snapshot_json || "[]"));
    } catch { /* keep empty */ }

    let goals: Array<Record<string, unknown>> = [];
    try {
      goals = db.prepare("SELECT * FROM hierarchy_goals WHERE organization_id = ?").all(org.id) as Array<Record<string, unknown>>;
    } catch { /* goals table may not exist yet on clean DB */ }

    const pkg = {
      _disp8chExport: true,
      version: 1,
      exportedAt: new Date().toISOString(),
      organization: {
        name: org.name,
        description: String(org.description || ""),
        mission: String(org.mission || ""),
        agents,
      },
      goals: goals.map((g) => ({
        id: g.id,
        name: g.name,
        description: String(g.description || ""),
        status: String(g.status || "planned"),
        level: String(g.level || "objective"),
        parentGoalId: g.parent_goal_id || null,
        organizationId: g.organization_id || null,
        linkedDocumentIds: parseJsonArray(String(g.linked_document_ids || "")),
        deliverables: parseJsonArray(String(g.deliverables || "")),
      })),
    };

    return NextResponse.json({ success: true, data: pkg });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

function parseJsonArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return raw
      .split(/[\r\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
}
