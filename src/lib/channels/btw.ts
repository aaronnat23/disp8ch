import { getSqlite, initializeDatabase } from "@/lib/db";
import { callModel } from "@/lib/agents/multi-provider";
import { getModelConfig } from "@/lib/agents/model-router";

type SessionMessageRow = {
  role: string;
  content: string;
  created_at: string;
};

export function extractByTheWayQuestion(rawMessage: string): string | null {
  const raw = String(rawMessage || "").trim();
  if (!raw) return null;
  const match =
    raw.match(/^\/?btw(?:\s+|:\s*)(.+)$/i) ||
    raw.match(/^by\s+the\s+way(?:\s+|:\s*)(.+)$/i);
  const question = String(match?.[1] || "").trim();
  return question || null;
}

function loadSessionExcerpt(sessionId: string, maxMessages = 10): string {
  initializeDatabase();
  const db = getSqlite();
  const rows = db
    .prepare(`
      SELECT role, content, created_at
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(sessionId, maxMessages) as SessionMessageRow[];

  return rows
    .reverse()
    .map((row) => {
      const role = String(row.role || "message").toUpperCase();
      const content = String(row.content || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 600);
      return `${role}: ${content}`;
    })
    .join("\n");
}

export async function runByTheWayQuestion(params: {
  rawMessage: string;
  sessionId?: string | null;
  agentId?: string | null;
  onToken?: (token: string) => void;
}): Promise<{ question: string; response: string } | null> {
  const question = extractByTheWayQuestion(params.rawMessage);
  if (!question) return null;

  const sessionId = String(params.sessionId || "").trim();
  const sessionExcerpt = sessionId ? loadSessionExcerpt(sessionId) : "";
  const model = getModelConfig({
    agentId: params.agentId || undefined,
    sessionId: sessionId || undefined,
  });

  const systemPrompt = [
    "You are answering a side question about the current conversation.",
    "This /btw mode is ephemeral: do not ask to save memory, do not claim the question will affect future turns, and do not suggest state changes unless the user explicitly asks.",
    "Do not use tools. Answer directly and concisely.",
    "If the session excerpt is insufficient, say so plainly and answer with the best limited inference.",
  ].join("\n");

  const userMessage = [
    sessionExcerpt ? `Current session excerpt:\n${sessionExcerpt}` : "Current session excerpt: (none available)",
    `Side question: ${question}`,
  ].join("\n\n");

  const result = await callModel({
    provider: model.provider,
    modelId: model.modelId,
    apiKey: model.apiKey,
    baseUrl: model.baseUrl,
    fastMode: model.fastMode,
    temperature: model.temperature,
    systemPrompt,
    userMessage,
    maxTokens: Math.min(model.maxTokens ?? 480, 480),
  });
  if (params.onToken && result.response) {
    params.onToken(result.response);
  }

  return {
    question,
    response: result.response.trim(),
  };
}
