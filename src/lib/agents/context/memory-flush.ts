import { logger } from "@/lib/utils/logger";
import { markSessionMemoryFlush } from "./session-compaction";
import type { CompactOpts } from "./types";

const log = logger.child("agents:context:memory-flush");

const MEMORY_FLUSH_PROMPT = [
  "IMPORTANT: Context compaction is about to run. This is your last chance to save important information from this conversation before older messages are lost.",
  "Review the conversation and extract anything worth keeping permanently: facts, preferences, decisions, patterns, or workflows that shaped how this session went.",
  "Output one item per line. Prefix each with its type: [fact], [preference], [decision], [workflow], [skill], [entity], [observation], or [correction].",
  "Examples:",
  "[preference] User prefers concise bullet-point responses over prose.",
  "[workflow] To deploy: run pnpm build then push to main.",
  "[decision] Chose SQLite over Postgres for local-first simplicity.",
  "If there is nothing new to remember that is not already in your workspace memory files, output exactly: NOTHING",
].join(" ");

const MEMORY_FLUSH_SYSTEM = [
  "You are extracting durable long-term memories immediately before a context window compaction.",
  "The agent is about to lose access to older messages. Your job is to surface the most important facts, user preferences, and decisions from this session.",
  "Be concise and specific. Only include genuinely new information not already in prior sessions.",
  "Do not include tool call details, intermediate steps, error messages, or transient debugging data.",
  "Prioritise: user preferences, important decisions, reusable workflows, and key facts about the project or environment.",
].join(" ");

type MemoryType =
  | "fact" | "preference" | "decision" | "skill" | "entity"
  | "observation" | "correction" | "relationship" | "knowledge" | "behavior" | "tool";

const KNOWN_TYPES = new Set<MemoryType>([
  "fact", "preference", "decision", "skill", "entity",
  "observation", "correction", "relationship", "knowledge", "behavior", "tool",
]);

function parseFlushType(prefix: string): MemoryType {
  const lower = prefix.toLowerCase() as MemoryType;
  return KNOWN_TYPES.has(lower) ? lower : "fact";
}

export async function runMemoryFlush(
  recentMessages: string,
  opts: CompactOpts,
  tokensBefore?: number,
  _triggerTokens?: number,
): Promise<void> {
  try {
    const { callModel } = await import("@/lib/agents/multi-provider");
    const result = await callModel({
      provider: opts.provider as Parameters<typeof callModel>[0]["provider"],
      modelId: opts.modelId,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      fastMode: opts.fastMode,
      systemPrompt: MEMORY_FLUSH_SYSTEM,
      userMessage: `${recentMessages}\n\n${MEMORY_FLUSH_PROMPT}`,
      maxTokens: 600,
    });

    const text = result.response.trim();
    if (!text || /^nothing$/i.test(text)) return;

    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const port = process.env.PORT ?? 3100;

    for (const line of lines) {
      if (/^nothing$/i.test(line)) continue;
      const match = line.match(/^\[([\w]+)\]\s*/i);
      const type: MemoryType = match ? parseFlushType(match[1]) : "fact";
      const content = match ? line.slice(match[0].length).trim() : line;
      if (content.length < 8) continue;

      await fetch(`http://localhost:${port}/api/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          type,
          source: "compaction-flush",
          tags: ["auto", "pre-compaction"],
          extractMode: "manual",
          confidence: 0.75,
        }),
      }).catch(() => { /* non-fatal */ });
    }

    log.info("Memory flush completed before compaction", { lines: lines.length });
    if (opts.sessionId) {
      markSessionMemoryFlush({
        sessionId: opts.sessionId,
        agentId: opts.agentId,
        tokensBefore,
      });
    }
  } catch (error) {
    log.warn("Memory flush failed (non-fatal)", { error: String(error) });
  }
}
