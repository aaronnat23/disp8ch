import { NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { dismissAttentionItem, getAttentionSummary } from "@/lib/attention/aggregate";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ success: true, data: getAttentionSummary() });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const body = (await request.json()) as { action?: string; sourceType?: string; sourceId?: string };
    if (body.action === "dismiss" && body.sourceType && body.sourceId) {
      dismissAttentionItem(String(body.sourceType), String(body.sourceId));
      return NextResponse.json({ success: true, data: getAttentionSummary() });
    }
    return NextResponse.json({ success: false, error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
