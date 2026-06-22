import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addTaskComment, listTaskComments, deleteTaskComment } from "@/lib/governance/task-comments";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const AddCommentSchema = z.object({
  taskId: z.string().min(1).max(128),
  authorAgentId: z.string().max(128).nullable().optional(),
  authorUserId: z.string().max(128).nullable().optional(),
  body: z.string().min(1).max(4096),
});

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get("taskId");
    if (!taskId) {
      return NextResponse.json({ success: false, error: "Missing taskId" }, { status: 400 });
    }
    return NextResponse.json({ success: true, data: listTaskComments(taskId) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = AddCommentSchema.parse(body);
    const comment = addTaskComment(parsed);
    return NextResponse.json({ success: true, data: comment }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, error: "Missing id" }, { status: 400 });
    }
    deleteTaskComment(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
