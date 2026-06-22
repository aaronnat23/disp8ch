import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getImageGenerationConfigStatus } from "@/lib/image-gen/registry";

export const dynamic = "force-dynamic";

/** Image provider availability + capability metadata (generation vs editing). */
export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ success: true, data: await getImageGenerationConfigStatus() });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
