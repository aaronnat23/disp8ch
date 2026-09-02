import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { createTeachWorkflowDraft } from "@/lib/computer-use/teach-workflow";

const Schema = z.object({ name: z.string().min(1).max(160).optional(), successCriteria: z.string().max(1000).optional(), confirmed: z.literal(true) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = Schema.parse(await request.json());
    return NextResponse.json({ success: true, data: createTeachWorkflowDraft({ sessionId: id, name: body.name, successCriteria: body.successCriteria }) }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    const status = String(error).includes("not found") ? 404 : 400;
    return NextResponse.json({ success: false, error: String(error) }, { status });
  }
}
