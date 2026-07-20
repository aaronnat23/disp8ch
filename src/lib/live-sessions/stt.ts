import OpenAI from "openai";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { resolveModelApiKey } from "@/lib/agents/provider-auth";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";
import { resolveSecretValue } from "@/lib/secrets/store";

export async function transcribeLiveAudio(audioFile: File, language?: string | null): Promise<{
  text: string; provider: string; confidence: number | null; providerSegmentId: string | null;
}> {
  initializeDatabase();
  const db = getSqlite();
  const config = db.prepare("SELECT voice_stt_provider, voice_stt_api_key FROM app_config WHERE id = 'default' LIMIT 1").get() as Record<string, unknown> | undefined;
  const selectedProvider = String(config?.voice_stt_provider || "openai-whisper");
  const selectedKey = String(config?.voice_stt_api_key || "").trim();

  if (selectedProvider === "deepgram") {
    if (!selectedKey) throw new Error("Deepgram speech-to-text is selected but its API key is not configured.");
    const query = new URLSearchParams({ model: "nova-2", punctuate: "true" });
    if (language) query.set("language", language);
    const response = await fetch(`https://api.deepgram.com/v1/listen?${query}`, {
      method: "POST",
      headers: { Authorization: `Token ${selectedKey}`, "Content-Type": audioFile.type || "audio/webm" },
      body: Buffer.from(await audioFile.arrayBuffer()),
    });
    const json = await response.json() as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }> }> }; err_msg?: string };
    if (!response.ok) throw new Error(json.err_msg || "Deepgram speech-to-text failed.");
    const alternative = json.results?.channels?.[0]?.alternatives?.[0];
    return { text: alternative?.transcript || "", provider: "deepgram:nova-2", confidence: alternative?.confidence ?? null, providerSegmentId: null };
  }

  const row = db.prepare("SELECT * FROM models WHERE provider = 'openai' AND is_active = 1 ORDER BY priority DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  if (!row && !selectedKey && selectedProvider !== "local-whisper") throw new Error("No callable OpenAI-compatible speech-to-text provider is configured.");
  const auth = selectedProvider === "local-whisper"
    ? { apiKey: selectedKey || "local-whisper" }
    : selectedKey
      ? { apiKey: selectedKey }
      : resolveModelApiKey({ provider: "openai", storedApiKey: String(row?.api_key || "") });
  if (!auth.apiKey) throw new Error("No speech-to-text API key is resolved.");
  const baseUrl = selectedProvider === "local-whisper"
    ? "http://localhost:8080/v1"
    : normalizeProviderBaseUrl("openai", row?.base_url ? String(row.base_url) : undefined);
  const client = new OpenAI({ apiKey: auth.apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  const model = resolveSecretValue("VOICE_STT_MODEL") || process.env.VOICE_STT_MODEL || "whisper-1";
  const transcription = await client.audio.transcriptions.create({
    model,
    file: audioFile,
    ...(language ? { language } : {}),
  });
  return { text: transcription.text, provider: `${selectedProvider}:${model}`, confidence: null, providerSegmentId: null };
}
