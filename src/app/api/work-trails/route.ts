import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getWorkTrail, getWorkTrailsForObject, listWorkTrails } from "@/lib/work-trails/work-trails";
import { getSqlite } from "@/lib/db";

export const dynamic = "force-dynamic";

function enrichObjectState(event: { surface: string | null; objectType: string | null; objectId: string | null }) {
  if (!event.objectId || !event.surface) return { ...event, objectAvailable: null, objectState: null };
  const table = event.surface === "files" ? "connected_projects"
    : event.surface === "sources" ? "notebooks"
      : event.surface === "workflows" ? (event.objectType === "dynamic-run" ? "dynamic_workflow_runs" : "workflows")
        : event.surface === "design" ? "design_artifacts"
          : event.surface === "deployments" ? "design_deployments"
            : event.surface === "boards" ? "board_tasks"
              : event.surface === "council" ? "council_sessions"
                : event.surface === "sessions" ? "live_sessions"
                  : event.surface === "hierarchy" ? "hierarchy_organizations"
                    : null;
  if (!table) return { ...event, objectAvailable: null, objectState: null };
  const db = getSqlite();
  const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(table) as { ok: number } | undefined;
  if (!exists) return { ...event, objectAvailable: false, objectState: "missing" };
  const columns = table === "design_deployments" ? ", status" : "";
  const row = db.prepare(`SELECT id${columns} FROM ${table} WHERE id = ?`).get(event.objectId) as { id: string; status?: string } | undefined;
  return { ...event, objectAvailable: Boolean(row), objectState: row?.status || (row ? "available" : "missing") };
}

/**
 * Read-only access to cross-tab work trails.
 *   GET /api/work-trails                                      -> recent trails (optionally ?sessionId=)
 *   GET /api/work-trails?id=trail-x                           -> a single trail with its events
 *   GET /api/work-trails?surface=x&objectType=y&objectId=z    -> related trails for an app object
 */
export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (id) {
      const trail = getWorkTrail(id);
      if (!trail) {
        return NextResponse.json({ success: false, error: "Work trail not found" }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: { ...trail, events: trail.events.map(enrichObjectState) } });
    }
    const surface = searchParams.get("surface");
    const objectType = searchParams.get("objectType");
    const objectId = searchParams.get("objectId");
    if (surface && objectId) {
      const trails = getWorkTrailsForObject(surface, objectType || "", objectId, Number(searchParams.get("limit") || "5"));
      return NextResponse.json({ success: true, data: { trails } });
    }
    const sessionId = searchParams.get("sessionId");
    const limit = Number(searchParams.get("limit") || "50");
    const trails = listWorkTrails({ sessionId: sessionId || undefined, limit });
    return NextResponse.json({ success: true, data: trails });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
