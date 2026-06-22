import { getSqlite, initializeDatabase } from "@/lib/db";

export type WebChatContextMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  createdAt?: string;
};

export function loadRecentWebChatContext(params: {
  sessionId: string;
  limitMessages?: number;
  maxChars?: number;
  currentMessage?: string;
}): WebChatContextMessage[] {
  const sessionId = String(params.sessionId || "").trim();
  if (!sessionId) return [];

  initializeDatabase();
  const limitMessages = Math.max(1, Math.min(params.limitMessages ?? 12, 40));
  const maxChars = Math.max(500, Math.min(params.maxChars ?? 8000, 24000));
  const currentMessage = String(params.currentMessage || "").trim();
  const db = getSqlite();

  const rows = db.prepare(
    `SELECT role, content, created_at
     FROM messages
     WHERE session_id = ?
       AND role IN ('system', 'user', 'assistant')
       AND length(trim(content)) > 0
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(sessionId, limitMessages + 2) as Array<{
    role: string;
    content: string;
    created_at: string | null;
  }>;

  const chronological = rows.reverse();
  const dedupedCurrent = chronological.filter((row, index) => {
    if (!currentMessage || row.role !== "user") return true;
    const isLast = index === chronological.length - 1;
    return !(isLast && String(row.content || "").trim() === currentMessage);
  });

  let usedChars = 0;
  const selected: WebChatContextMessage[] = [];
  for (let i = dedupedCurrent.length - 1; i >= 0; i--) {
    const row = dedupedCurrent[i];
    const content = String(row.content || "").trim();
    if (!content) continue;
    if (usedChars + content.length > maxChars && selected.length > 0) break;
    selected.push({
      role: row.role as WebChatContextMessage["role"],
      content: content.slice(0, Math.max(0, maxChars - usedChars)),
      createdAt: row.created_at ?? undefined,
    });
    usedChars += content.length;
    if (selected.length >= limitMessages) break;
  }

  return selected.reverse();
}

export function buildContextualUserMessage(params: {
  recent: WebChatContextMessage[];
  currentMessage: string;
  instructions?: string[];
}): string {
  const parts: string[] = [];

  if (params.recent.length > 0) {
    parts.push("<recent-conversation>");
    for (const msg of params.recent) {
      parts.push(`${msg.role}: ${msg.content}`);
    }
    parts.push("</recent-conversation>");
  }

  if (params.instructions && params.instructions.length > 0) {
    parts.push("<instructions>");
    for (const inst of params.instructions) {
      parts.push(`- ${inst}`);
    }
    parts.push("</instructions>");
  }

  parts.push(params.currentMessage);

  return parts.join("\n");
}
