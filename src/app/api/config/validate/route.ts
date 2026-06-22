import { NextResponse } from "next/server";
import { runConfigValidation } from "@/lib/config/validator";
import { logger } from "@/lib/utils/logger";
import { requireOperatorAccess } from "@/lib/security/admin";

const log = logger.child("api:config:validate");

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const report = runConfigValidation();
    return NextResponse.json({ success: true, data: report });
  } catch (error) {
    log.error("GET /api/config/validate failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
