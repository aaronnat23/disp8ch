import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { beginLiveSegment, completeLiveSegment, failLiveSegment, getLiveSession } from "@/lib/live-sessions/store";
import { transcribeLiveAudio } from "@/lib/live-sessions/stt";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  let segmentId = "";
  try {
    const { id } = await params;
    const session = getLiveSession(id);
    if (!session) return NextResponse.json({ success: false, error: "Live session not found." }, { status: 404 });
    if (session.status !== "recording" && session.status !== "paused") return NextResponse.json({ success: false, error: "Live session is not accepting chunks." }, { status: 409 });
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) return NextResponse.json({ success: false, error: "Audio chunk required." }, { status: 400 });
    if (audio.size < 1 || audio.size > 20_000_000) return NextResponse.json({ success: false, error: "Audio chunk must be between 1 byte and 20 MB." }, { status: 413 });
    const sequence = Number(form.get("sequence"));
    const startMs = Number(form.get("startMs"));
    const endMs = Number(form.get("endMs"));
    const claimedSha = String(form.get("sha256") || "").toLowerCase();
    const bytes = Buffer.from(await audio.arrayBuffer());
    const actualSha = crypto.createHash("sha256").update(bytes).digest("hex");
    if (claimedSha !== actualSha) return NextResponse.json({ success: false, error: "Audio chunk hash mismatch." }, { status: 400 });
    const segment = beginLiveSegment({ sessionId: id, sequence, startMs, endMs, audioSha256: actualSha });
    segmentId = segment.id;
    if (segment.status === "complete") return NextResponse.json({ success: true, data: segment, deduplicated: true });
    const transcription = await transcribeLiveAudio(audio, session.language);
    const data = completeLiveSegment({ segmentId: segment.id, ...transcription });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (segmentId) failLiveSegment(segmentId);
    return NextResponse.json({ success: false, error: String(error), retryable: /429|timeout|network|fetch|5\d\d/i.test(String(error)) }, { status: 502 });
  }
}
