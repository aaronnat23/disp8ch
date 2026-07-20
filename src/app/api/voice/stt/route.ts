import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { transcribeLiveAudio } from "@/lib/live-sessions/stt";

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const formData = await request.formData();
    const audioFile = formData.get("audio") as File | null;
    const language = (formData.get("language") as string) || undefined;

    if (!audioFile) {
      return NextResponse.json({ success: false, error: "No audio file provided" }, { status: 400 });
    }

    const transcription = await transcribeLiveAudio(audioFile, language);
    return NextResponse.json({ success: true, data: { text: transcription.text } });
  } catch (error) {
    const message = String(error);
    const configurationError = /not configured|No callable|No speech-to-text API key/i.test(message);
    return NextResponse.json({ success: false, error: message }, { status: configurationError ? 400 : 500 });
  }
}
