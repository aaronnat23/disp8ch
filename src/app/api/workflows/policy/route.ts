import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getWorkflowPolicyState } from "@/lib/engine/workflow-policy";

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  const workflowId = String(new URL(request.url).searchParams.get("workflowId") || "").trim();
  if (!workflowId) {
    return NextResponse.json({ success: false, error: "Missing workflowId" }, { status: 400 });
  }
  return NextResponse.json({ success: true, data: getWorkflowPolicyState(workflowId) });
}
