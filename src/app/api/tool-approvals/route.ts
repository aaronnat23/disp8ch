import { NextRequest, NextResponse } from "next/server";
import { listPendingApprovals, resolvePendingApproval } from "@/lib/engine/tools";
import { requireOperatorAccess } from "@/lib/security/admin";

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const data = listPendingApprovals();
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json() as {
      id?: string;
      decision?: "approve" | "deny";
    };
    const id = String(body.id ?? "").trim();
    const decision = body.decision;
    if (!id || (decision !== "approve" && decision !== "deny")) {
      return NextResponse.json(
        { success: false, error: "id and decision ('approve' | 'deny') are required" },
        { status: 400 },
      );
    }

    const result = await resolvePendingApproval({ id, decision });
    if (!result.success && result.status === "missing") {
      return NextResponse.json(result, { status: 404 });
    }
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
