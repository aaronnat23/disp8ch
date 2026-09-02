import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getLiveSession, setLiveSessionStatus, updateLiveSegment } from "@/lib/live-sessions/store";
import { saveLiveSessionToNotebook } from "@/lib/live-sessions/intelligence";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["pause", "resume", "finalize", "error"]) }),
  z.object({ action: z.literal("update_segment"), segmentId: z.string().min(1), text: z.string().max(100_000).optional(), speakerLabel: z.string().max(100).nullable().optional() }),
  z.object({ action: z.literal("save_notebook"), confirmed: z.literal(true), notebookId: z.string().nullable().optional(), includeAnalysis: z.boolean().optional() }),
]);

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  const { id } = await params;
  const data = getLiveSession(id);
  return data ? NextResponse.json({ success: true, data }) : NextResponse.json({ success: false, error: "Live session not found." }, { status: 404 });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const input = ActionSchema.parse(await request.json());
    if (input.action === "update_segment") return NextResponse.json({ success: true, data: updateLiveSegment({ sessionId: id, ...input }) });
    if (input.action === "save_notebook") return NextResponse.json({ success: true, data: await saveLiveSessionToNotebook({ sessionId: id, notebookId: input.notebookId, includeAnalysis: input.includeAnalysis }) });
    const status = input.action === "pause" ? "paused" : input.action === "resume" ? "recording" : input.action === "error" ? "error" : "complete";
    return NextResponse.json({ success: true, data: setLiveSessionStatus(id, status) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof z.ZodError ? error.flatten() : String(error) }, { status: 400 });
  }
}
