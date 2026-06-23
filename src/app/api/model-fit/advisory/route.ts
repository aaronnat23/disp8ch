import { NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { listModelAdvisories, updateAdvisoryPreference } from "@/lib/model-fit/advisory";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  const modelRowId = new URL(request.url).searchParams.get("modelRowId") || undefined;
  return NextResponse.json({ success: true, data: listModelAdvisories(modelRowId) });
}

export async function PATCH(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const body = await request.json() as { advisoryId?: string; action?: string };
    if (!["dismiss", "remind", "disable"].includes(String(body.action))) {
      return NextResponse.json({ success: false, error: "Invalid advisory action" }, { status: 400 });
    }
    updateAdvisoryPreference({
      advisoryId: body.advisoryId,
      action: body.action as "dismiss" | "remind" | "disable",
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
