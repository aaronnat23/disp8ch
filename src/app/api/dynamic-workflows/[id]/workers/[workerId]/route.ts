import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getDynamicWorkflowWorker, upsertDynamicWorkflowWorker } from "@/lib/dynamic-workflows/store";
import { restartWorker } from "@/lib/dynamic-workflows/runner";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; workerId: string } },
) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const body = await request.json() as { action?: string };
    const action = String(body.action ?? "").trim();

    if (action === "restart") {
      await restartWorker(params.id, params.workerId);
      const worker = getDynamicWorkflowWorker(params.workerId);
      if (!worker) {
        return NextResponse.json({ success: false, error: "Worker not found after restart" }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: worker });
    }

    if (action === "cancel") {
      const worker = getDynamicWorkflowWorker(params.workerId);
      if (!worker) {
        return NextResponse.json({ success: false, error: "Worker not found" }, { status: 404 });
      }

      const updated = upsertDynamicWorkflowWorker({
        ...worker,
        status: "cancelled",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      return NextResponse.json({ success: true, data: updated });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action || "(empty)"}` }, { status: 400 });
  } catch (error) {
    const message = String(error);
    if (message.includes("not found")) {
      return NextResponse.json({ success: false, error: message }, { status: 404 });
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
