import { NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { runSecurityAudit } from "@/lib/security/audit";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

const log = logger.child("api:security");

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const report = runSecurityAudit();
    return NextResponse.json({ success: true, data: report });
  } catch (error) {
    log.error("GET /api/security failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
