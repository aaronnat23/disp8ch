import { NextRequest, NextResponse } from "next/server";
import { abortRunningExecution, listRunningExecutions } from "@/lib/engine/runtime-tracker";
import { listExecutionLaneSnapshots } from "@/lib/engine/execution-lanes";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const AbortExecutionSchema = z.object({
  executionId: z.string().min(1).max(120),
});

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    return NextResponse.json({
      success: true,
      data: listRunningExecutions(),
      lanes: listExecutionLaneSnapshots(),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = AbortExecutionSchema.parse(body);
    const aborted = abortRunningExecution(parsed.executionId);
    if (!aborted) {
      return NextResponse.json(
        { success: false, error: `Execution not running: ${parsed.executionId}` },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data: { executionId: parsed.executionId, aborted: true } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
