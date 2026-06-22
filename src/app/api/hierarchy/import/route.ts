import { NextRequest, NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body._disp8chExport) {
      return NextResponse.json({ success: false, error: "Not a valid disp8ch export" }, { status: 400 });
    }

    const db = getSqlite();
    const org = (body.organization || {}) as Record<string, unknown>;
    const goals = (body.goals || []) as Array<Record<string, unknown>>;

    const orgName = String(org.name || "Imported Org");
    const orgDescription = String(org.description || "");
    const orgMission = String(org.mission || "");
    const orgAgents = Array.isArray(org.agents) ? org.agents : [];
    const orgId = `org-${Date.now()}`;

    db.prepare(`
      INSERT INTO hierarchy_organizations (id, name, description, mission, snapshot_json, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
    `).run(orgId, orgName, orgDescription, orgMission, JSON.stringify(orgAgents));

    const idMap = new Map<string, string>();
    let goalsImported = 0;

    for (const goal of goals) {
      const goalId = String(goal.id || "");
      const newId = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      idMap.set(goalId, newId);

      const linkedDocumentIds = JSON.stringify(
        Array.isArray(goal.linkedDocumentIds) ? goal.linkedDocumentIds.filter(Boolean) : []
      );
      const deliverables = JSON.stringify(
        Array.isArray(goal.deliverables) ? goal.deliverables.filter(Boolean) : []
      );

      db.prepare(`
        INSERT INTO hierarchy_goals (id, organization_id, name, description, status, level, parent_goal_id, linked_document_ids, deliverables, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        newId,
        orgId,
        String(goal.name || "Untitled Goal"),
        String(goal.description || ""),
        String(goal.status || "planned"),
        String(goal.level || null),
        goal.parentGoalId ? idMap.get(String(goal.parentGoalId)) : null,
        linkedDocumentIds,
        deliverables,
      );
      goalsImported++;
    }

    // Deactivate all other orgs and activate the newly imported one
    db.prepare("UPDATE hierarchy_organizations SET is_active = 0 WHERE id != ?").run(orgId);
    db.prepare("UPDATE hierarchy_organizations SET is_active = 1 WHERE id = ?").run(orgId);
    db.prepare("UPDATE app_config SET active_organization_id = ?").run(orgId);

    return NextResponse.json({
      success: true,
      data: { organizationId: orgId, goalsImported },
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
