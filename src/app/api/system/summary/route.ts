import { NextRequest, NextResponse } from "next/server";
import { getMachineSpecs } from "@/lib/system/specs";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  return NextResponse.json({
    success: true,
    data: {
      machine: getMachineSpecs(),
      generatedAt: new Date().toISOString(),
    },
  });
}
