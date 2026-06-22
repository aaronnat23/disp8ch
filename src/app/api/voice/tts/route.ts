import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSqlite, initializeDatabase } from "@/lib/db";
import OpenAI from "openai";
import { resolveModelApiKey } from "@/lib/agents/provider-auth";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";
import { requireOperatorAccess } from "@/lib/security/admin";

const ttsSchema = z.object({
  text: z.string().min(1),
  voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).default("alloy"),
  model: z.string().default("tts-1"),
  speed: z.number().min(0.25).max(4).default(1.0),
});

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();

    const row = db
      .prepare("SELECT * FROM models WHERE provider = 'openai' AND is_active = 1 ORDER BY priority DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;

    if (!row) {
      return NextResponse.json(
        { success: false, error: "No OpenAI model configured." },
        { status: 400 }
      );
    }

    const body = await request.json();
    const parsed = ttsSchema.parse(body);

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

    const response = await client.audio.speech.create({
      model: parsed.model,
      voice: parsed.voice,
      input: parsed.text,
      speed: parsed.speed,
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(buffer.length),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
