import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getEventsForRun } from "@/lib/dynamic-workflows/store";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || 50)));

    const events = getEventsForRun(params.id, limit);

    return NextResponse.json({
      success: true,
      data: { runId: params.id, limit, events },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
