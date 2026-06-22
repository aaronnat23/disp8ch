import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getWorkTrail, getWorkTrailsForObject, listWorkTrails } from "@/lib/work-trails/work-trails";

export const dynamic = "force-dynamic";

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
      return NextResponse.json({ success: true, data: trail });
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
