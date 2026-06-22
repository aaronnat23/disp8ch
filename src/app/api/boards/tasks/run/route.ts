import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runWorkflowBackedBoardTask } from "@/lib/boards/task-runner";
import { requireOperatorAccess } from "@/lib/security/admin";

const RunTaskSchema = z.object({
  id: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = RunTaskSchema.parse(body);
    const result = await runWorkflowBackedBoardTask(parsed.id);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    const message = String(error);
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
