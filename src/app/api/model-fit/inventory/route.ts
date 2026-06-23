import { NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getModelFitInventory } from "@/lib/model-fit/inventory";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ success: true, data: await getModelFitInventory() });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
