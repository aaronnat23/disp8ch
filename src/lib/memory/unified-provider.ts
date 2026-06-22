// Server-only — do not import in client components.
import type { MemoryProvider, Message } from "./types";
import type { MemoryEntry, MemoryStats } from "@/types/memory";
import { SimpleMemoryProvider, computeAtomicContentHash } from "./simple";
import { compressConversation } from "./observer";
import { callModel } from "@/lib/agents/multi-provider";
import { getSqlite } from "@/lib/db";
import { nanoid } from "nanoid";
import { logger } from "@/lib/utils/logger";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import { resolveModelApiKey } from "@/lib/agents/provider-auth";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";
import {
  deleteEmbedding,
  countEmbeddings,
  type EmbeddingModel,
} from "./embedding-provider";
import { mergeHybridResults, vectorSearch, indexMemoryEmbedding } from "./hybrid-search";
import { getSessionChunkCount } from "./session-indexer";
import { getMemorySearchManager, MemorySearchManager } from "./manager";

const log = logger.child("memory:unified");

interface UnifiedConfig {
  vectorWeight: number;
  textWeight: number;
}

function loadUnifiedConfig(): UnifiedConfig {
  try {
    const db = getSqlite();
    const row = db
      .prepare("SELECT vector_weight, text_weight FROM memory_config WHERE id = 'default'")
      .get() as { vector_weight?: number; text_weight?: number } | undefined;
    return {
      vectorWeight: Math.max(0, Math.min(1, Number(row?.vector_weight ?? 0.7))),
      textWeight: Math.max(0, Math.min(1, Number(row?.text_weight ?? 0.3))),
    };
  } catch {
    return { vectorWeight: 0.7, textWeight: 0.3 };
  }
}

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
      baseUrl: normalizeProviderBaseUrl(
        provider,
        (row.base_url as string | undefined) || undefined
      ),
      fastMode: row.fast_mode === 1,
    };
  } catch {
    return null;
  }
}

const SUPPORTED_MEMORY_TYPES = new Set<MemoryEntry["type"]>([
  "fact",
  "preference",
  "entity",
  "decision",
  "correction",
  "relationship",
  "skill",
  "observation",
  "profile",
  "event",
  "knowledge",
  "behavior",
  "tool",
]);

function normalizeExtractedType(raw: unknown): MemoryEntry["type"] {
  const value = String(raw || "fact").trim().toLowerCase() as MemoryEntry["type"];
  return SUPPORTED_MEMORY_TYPES.has(value) ? value : "fact";
}

function normalizeOptionalIso(raw: unknown): string | undefined {
  const value = String(raw || "").trim();
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function normalizeExtractedTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((tag) => String(tag || "").trim()).filter(Boolean).slice(0, 8);
}

/**
 * UnifiedMemoryProvider — replaces the old Simple/Thorough/Auto tier system.
 *
 * Search strategy (auto-detected):
 * - If an embedding model is configured and available: hybrid BM25 + vector search.
 * - Otherwise: FTS5-only (same as former SimpleMemoryProvider).
 *
 * Extraction: LLM-based when a model is configured; heuristic fallback.
 * Compression: delegates to compressConversation() from observer.ts.
 */
export class UnifiedMemoryProvider implements MemoryProvider {
  private simple: SimpleMemoryProvider;
  private embeddingModel: EmbeddingModel | null | undefined = undefined; // undefined = not loaded
  private embeddingModelLoaded = false;
  private readonly agentId: string;
  private readonly manager: MemorySearchManager;

  constructor(agentId = "default") {
    this.agentId = agentId;
    this.simple = new SimpleMemoryProvider(agentId);
    this.manager = getMemorySearchManager(agentId);
  }

  private async getEmbeddingModelCached(): Promise<EmbeddingModel | null> {
    if (this.embeddingModelLoaded) return this.embeddingModel ?? null;

    this.embeddingModel = await this.manager.getResolvedEmbeddingModel();
    this.embeddingModelLoaded = true;
    return this.embeddingModel ?? null;
  }

  async store(entry: MemoryEntry): Promise<MemoryEntry> {
    const stored = await this.simple.store(entry);
    // Fire-and-forget: generate embedding in background; never blocks write path.
    this.getEmbeddingModelCached()
      .then((model) => {
        if (model) return indexMemoryEmbedding(stored, model, this.agentId);
      })
      .catch((err) =>
        log.warn("Background embedding failed", { id: stored.id, error: String(err) })
      );
    return stored;
  }

  async search(query: string, limit = 10): Promise<MemoryEntry[]> {
    if (!query.trim()) return [];
    const config = loadUnifiedConfig();
    const model = await this.getEmbeddingModelCached();

    if (!model) {
      // FTS5-only path — identical to former SimpleMemoryProvider.
      return this.simple.search(query, limit);
    }

    // Hybrid path: BM25 candidates + vector re-score.
    const candidateCount = Math.max(limit * 4, 20);
    const bm25Results = await this.simple.search(query, candidateCount);

    // Embed the query once; gracefully degrade to BM25-only on failure.
    const queryEmbedding = (await this.manager.embedQueryWithFallback(query)).embedding;
    if (!queryEmbedding) {
      return bm25Results.slice(0, limit);
    }

    // Vector-score all entries that have cached embeddings (cache-only; no live API).
    const allEntries = await this.simple.getAll();
    const vectorResults = await vectorSearch(queryEmbedding, allEntries, candidateCount, this.agentId);

    const merged = mergeHybridResults(
      bm25Results.map((e) => ({ ...e, score: undefined })),
      vectorResults,
      config.vectorWeight,
      config.textWeight,
      limit
    );

    return merged;
  }

  async getAll(): Promise<MemoryEntry[]> {
    return this.simple.getAll();
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.simple.get(id);
  }

  async update(id: string, content: string): Promise<void> {
    await this.simple.update(id, content);
    // Invalidate stale embedding and regenerate.
    deleteEmbedding(id, this.agentId);
    this.getEmbeddingModelCached()
      .then(async (model) => {
        if (!model) return;
        const updated = await this.simple.get(id);
        if (updated) await indexMemoryEmbedding(updated, model, this.agentId);
      })
      .catch((err) =>
        log.warn("Background embedding update failed", { id, error: String(err) })
      );
  }

  async delete(id: string): Promise<void> {
    await this.simple.delete(id);
    deleteEmbedding(id, this.agentId);
  }

  async extract(messages: Message[]): Promise<MemoryEntry[]> {
    const now = new Date().toISOString();
    const model = loadActiveModel();

    if (model) {
      try {
        const conversationText = messages
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n\n");

        const result = await callModel({
          provider: model.provider as Parameters<typeof callModel>[0]["provider"],
          modelId: model.modelId,
          apiKey: model.apiKey,
          baseUrl: model.baseUrl,
          fastMode: model.fastMode,
          systemPrompt: `Extract durable long-term memories from the conversation.
Return JSON only with {"memories":[...]}.

Each memory object may include:
- "content": string, concise and durable, max 200 chars
- "type": one of "fact" | "preference" | "entity" | "decision" | "skill" | "observation" | "profile" | "event" | "knowledge" | "behavior" | "tool" | "relationship" | "correction"
- "confidence": number from 0 to 1
- "tags": optional string[]
- "whenToUse": optional short string, only for tool memories
- "happenedAt": optional ISO date/time if the conversation explicitly gives an event date/time
- "metadata": optional object with compact structured facts

Extraction rules:
- Prefer profile, event, behavior, tool, knowledge, and decision memories over generic facts.
- Tool memories should capture reusable tool-selection guidance.
- Event memories should include happenedAt only when the timing is explicit.
- Skip greetings, filler, transient commands, and anything not useful in a later session.
- Avoid duplicates and keep wording self-contained.
Return only JSON.`,
          userMessage: conversationText,
          maxTokens: 1024,
        });

        const jsonMatch = result.response.trim().match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const extractedPayload = JSON.parse(jsonMatch[0]) as {
            memories?: Array<{
              content?: string;
              type?: string;
              confidence?: number;
              tags?: unknown;
              whenToUse?: unknown;
              happenedAt?: unknown;
              metadata?: unknown;
            }>;
          };
          const extracted = Array.isArray(extractedPayload.memories) ? extractedPayload.memories : [];

          const entries: MemoryEntry[] = [];
          for (const item of extracted) {
            if (!item.content || typeof item.content !== "string") continue;
            const type = normalizeExtractedType(item.type);
            const entry: MemoryEntry = {
              id: `mem_${nanoid(8)}`,
              type,
              content: item.content.slice(0, 500),
              confidence: Math.min(1, Math.max(0, item.confidence ?? 0.7)),
              source: "conversation",
              tags: normalizeExtractedTags(item.tags),
              created: now,
              updated: now,
              whenToUse: type === "tool" ? String(item.whenToUse || "").trim() || undefined : undefined,
              happenedAt: type === "event" ? normalizeOptionalIso(item.happenedAt) : undefined,
              metadata:
                item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
                  ? (item.metadata as Record<string, unknown>)
                  : undefined,
            };
            entries.push(entry);
            await this.store(entry);
          }
          return entries;
        }
      } catch (err) {
        log.warn("LLM extraction failed, using heuristic fallback", { error: String(err) });
      }
    }

    // Heuristic fallback: store long user messages as facts.
    const entries: MemoryEntry[] = [];
    for (const msg of messages) {
      if (msg.role === "user" && msg.content.length > 20) {
        const lower = msg.content.toLowerCase();
        const inferredType: MemoryEntry["type"] =
          lower.includes("when should i use") || lower.includes("use this tool")
            ? "tool"
            : /\b(today|yesterday|tomorrow|\d{4}-\d{2}-\d{2})\b/.test(lower)
              ? "event"
              : "fact";
        const entry: MemoryEntry = {
          id: `mem_${nanoid(8)}`,
          type: inferredType,
          content: msg.content,
          confidence: 0.7,
          source: "conversation",
          tags: [],
          created: now,
          updated: now,
          whenToUse: inferredType === "tool" ? "Use when the same task or tool choice comes up again." : undefined,
        };
        entries.push(entry);
        await this.store(entry);
      }
    }
    return entries;
  }

  async compress(messages: Message[]): Promise<string | null> {
    const summary = await compressConversation(messages);
    if (summary) {
      const entry: MemoryEntry = {
        id: `mem_${nanoid(8)}`,
        type: "observation",
        content: summary,
        confidence: 0.9,
        source: "compression",
        tags: ["observation"],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      await this.store(entry);
    }
    return summary;
  }

  async getStats(): Promise<MemoryStats> {
    const baseStats = await this.simple.getStats();
    const model = await this.getEmbeddingModelCached();

    return {
      totalMemories: baseStats.totalMemories,
      storageBytes: baseStats.storageBytes,
      tier: "unified",
      currentMode: "unified",
      autoThreshold: 50,
      embeddingModel: model?.modelId ?? null,
      vectorIndexed: countEmbeddings(this.agentId),
      sessionChunks: getSessionChunkCount(this.agentId),
    };
  }
}
