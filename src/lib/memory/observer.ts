import type { Message } from "./types";
import { callModel } from "@/lib/agents/multi-provider";
import { getSqlite } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import { resolveModelApiKey } from "@/lib/agents/provider-auth";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";

const log = logger.child("observer");

const TOKEN_THRESHOLD = 30000;
const CHARS_PER_TOKEN = 4;

function loadActiveModel() {
  try {
    const db = getSqlite();
    const row = db
      .prepare("SELECT * FROM models WHERE is_active = 1 ORDER BY priority DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;

    if (!row) return null;

    const provider = normalizeProviderId(row.provider as string) ?? String(row.provider);
    const auth = resolveModelApiKey({ provider, storedApiKey: row.api_key as string });

    return {
      provider,
      modelId: row.model_id as string,
      apiKey: auth.apiKey,
      baseUrl: normalizeProviderBaseUrl(provider, (row.base_url as string | undefined) || undefined),
      fastMode: row.fast_mode === 1,
    };
  } catch {
    return null;
  }
}

export async function compressConversation(
  messages: Message[]
): Promise<string | null> {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const estimatedTokens = totalChars / CHARS_PER_TOKEN;

  if (estimatedTokens < TOKEN_THRESHOLD) {
    return null;
  }

  log.info("Compressing conversation", { messageCount: messages.length, estimatedTokens });

  const model = loadActiveModel();
  if (!model) {
    log.warn("No active model configured for conversation compression");
    return null;
  }

  const conversationText = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n\n");

  try {
    const result = await callModel({
      provider: model.provider as Parameters<typeof callModel>[0]["provider"],
      modelId: model.modelId,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      fastMode: model.fastMode,
      systemPrompt: `You are a conversation summarizer. Create a concise dated observation summary of the conversation below. Focus on:
- Key facts and information shared
- Decisions made
- Preferences expressed
- Important context for future conversations

Format as a dated observation:

[${new Date().toISOString().split("T")[0]}] Observation:
<your summary>`,
      userMessage: conversationText,
      maxTokens: 512,
    });

    return result.response;
  } catch (error) {
    log.error("Compression failed", { error: String(error) });
    return null;
  }
}
