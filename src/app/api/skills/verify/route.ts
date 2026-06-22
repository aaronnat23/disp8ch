import { NextRequest, NextResponse } from "next/server";
import { verifySkill } from "@/lib/skills/skill-verify";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = (await request.json()) as { skillId?: string; outputOverride?: string };
    const skillId = String(body.skillId || "").trim();
    if (!skillId) {
      return NextResponse.json({ success: false, error: "skillId is required" }, { status: 400 });
    }
    const result = await verifySkill(skillId, {
      outputOverride: typeof body.outputOverride === "string" ? body.outputOverride : undefined,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
