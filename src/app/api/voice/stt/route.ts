import { NextRequest, NextResponse } from "next/server";
import { getSqlite, initializeDatabase } from "@/lib/db";
import OpenAI from "openai";
import { resolveModelApiKey } from "@/lib/agents/provider-auth";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";
import { requireOperatorAccess } from "@/lib/security/admin";

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();

    // Find active OpenAI model for API key
    const row = db
      .prepare("SELECT * FROM models WHERE provider = 'openai' AND is_active = 1 ORDER BY priority DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;

    if (!row) {
      return NextResponse.json(
        { success: false, error: "No OpenAI model configured. Add an OpenAI API key in Settings." },
        { status: 400 }
      );
    }

    const formData = await request.formData();
    const audioFile = formData.get("audio") as File | null;
    const language = (formData.get("language") as string) || undefined;

    if (!audioFile) {
      return NextResponse.json({ success: false, error: "No audio file provided" }, { status: 400 });
    }

    const auth = resolveModelApiKey({ provider: "openai", storedApiKey: row.api_key as string });
    if (!auth.apiKey) {
      return NextResponse.json(
        { success: false, error: "No OpenAI API key resolved. Configure OPENAI_API_KEY or set model api_key." },
        { status: 400 }
      );
    }

    const baseUrl = normalizeProviderBaseUrl("openai", (row.base_url as string | undefined) || undefined);
    const client = new OpenAI({
      apiKey: auth.apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });

    const transcription = await client.audio.transcriptions.create({
      model: "whisper-1",
      file: audioFile,
      ...(language ? { language } : {}),
    });

    return NextResponse.json({ success: true, data: { text: transcription.text } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
