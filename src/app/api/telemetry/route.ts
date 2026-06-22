import { NextRequest, NextResponse } from "next/server";
import { initializeDatabase } from "@/lib/db";
import { readTelemetryRecent, readTelemetryStats } from "@/lib/telemetry";
import { requireOperatorAccess } from "@/lib/security/admin";

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "stats";

    if (action === "recent") {
      const limitRaw = parseInt(searchParams.get("limit") || "100", 10);
      const limit = Math.max(1, Math.min(1000, Number.isFinite(limitRaw) ? limitRaw : 100));
      return NextResponse.json({
        success: true,
        data: readTelemetryRecent(limit),
      });
    }

    const hoursRaw = parseInt(searchParams.get("hours") || "24", 10);
    const hours = Math.max(1, Math.min(24 * 30, Number.isFinite(hoursRaw) ? hoursRaw : 24));
    return NextResponse.json({
      success: true,
      data: readTelemetryStats(hours),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
