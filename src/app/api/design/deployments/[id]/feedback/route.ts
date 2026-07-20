import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { createFeedbackBoardTask, getDeploymentFeedback, startFeedbackRevision, syncDeploymentFeedback } from "@/lib/publishing/feedback";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sync") }),
  z.object({ action: z.literal("create_task"), feedbackId: z.string().min(1), boardId: z.string().nullable().optional(), confirmed: z.literal(true) }),
  z.object({ action: z.literal("start_revision"), feedbackId: z.string().min(1), confirmed: z.literal(true) }),
]);

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try { return NextResponse.json({ success: true, data: getDeploymentFeedback(params.id) }); }
  catch (error) { return NextResponse.json({ success: false, error: String(error) }, { status: 400 }); }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const input = ActionSchema.parse(await request.json());
    const data = input.action === "sync"
      ? await syncDeploymentFeedback(params.id)
      : input.action === "start_revision"
        ? await startFeedbackRevision({ deploymentId: params.id, feedbackId: input.feedbackId })
        : createFeedbackBoardTask({ deploymentId: params.id, feedbackId: input.feedbackId, boardId: input.boardId });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof z.ZodError ? error.flatten() : String(error) }, { status: 400 });
  }
}
