import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getDepartment, getDepartmentWeeklyUsage } from "@/lib/research-department/store";

export const dynamic = "force-dynamic";

/** Real weekly token/cost rollup for a department's agents (Briefer usage line). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    if (!getDepartment(id)) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
    const { searchParams } = new URL(request.url);
    const windowDays = Math.max(1, Math.min(90, Number(searchParams.get("windowDays")) || 7));
    return NextResponse.json({ success: true, data: getDepartmentWeeklyUsage(id, windowDays) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
