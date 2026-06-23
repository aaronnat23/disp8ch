import { NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import {
  getMcpCallApproval,
  listPendingMcpCallApprovals,
  resolveMcpCallApproval,
} from "@/lib/mcp/call-approval";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (id) {
      const record = getMcpCallApproval(id);
      if (!record) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
      return NextResponse.json({ success: true, data: record });
    }
    return NextResponse.json({ success: true, data: { pending: listPendingMcpCallApprovals() } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const body = (await request.json()) as { id?: string; decision?: "approve" | "deny"; reason?: string };
    const id = String(body.id ?? "").trim();
    const decision = body.decision;
    if (!id || (decision !== "approve" && decision !== "deny")) {
      return NextResponse.json(
        { success: false, error: "id and decision ('approve' | 'deny') are required" },
        { status: 400 },
      );
    }
    const result = await resolveMcpCallApproval(id, decision, body.reason);
    const httpStatus = result.ok ? 200 : result.status === "missing" ? 404 : 409;
    return NextResponse.json({ success: result.ok, ...result }, { status: httpStatus });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
