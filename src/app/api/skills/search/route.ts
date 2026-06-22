import { NextRequest, NextResponse } from "next/server";
import { searchSkillMarketplaces } from "@/lib/extensions/skill-marketplace";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q") || searchParams.get("query") || "";
    const limit = Number(searchParams.get("limit") || "25");
    const data = searchSkillMarketplaces(q, Number.isFinite(limit) ? limit : 25);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = (await request.json()) as { query?: string; q?: string; limit?: number };
    const data = searchSkillMarketplaces(String(body.query || body.q || ""), body.limit ?? 25);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
