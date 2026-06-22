// Server-only — do not import in client components.
import { getSqlite, withSqliteWriteRecovery } from "@/lib/db";
import { nanoid } from "nanoid";
import { logger } from "@/lib/utils/logger";
import {
  generateEmbedding,
  generateEmbeddingsBatch,
  cosineSimilarity,
  type EmbeddingModel,
  getEmbeddingProviderKey,
} from "./embedding-provider";
import {
  deleteMemoryVectorsBySourceRef,
  searchMemoryVectors,
  upsertMemoryVector,
} from "./sqlite-vec";

const log = logger.child("memory:session-indexer");

// Approximate 4 characters per token.
const CHARS_PER_TOKEN = 4;

export interface SessionChunk {
  id: string;
  sessionId: string;
  chunkText: string;
  chunkIndex: number;
  messageCount: number;
  score?: number;
}

/**
 * Split text into overlapping chunks by approximate token count.
 * Always returns at least one chunk.
 */
export function chunkText(
  text: string,
  chunkTokens = 400,
  overlapTokens = 80
): string[] {
  const chunkChars = chunkTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  if (text.length <= chunkChars) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkChars, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start += chunkChars - overlapChars;
  }
  return chunks;
}

/** Index a single session's messages into session_chunks + embeddings + FTS5. */
export async function indexSession(
  sessionId: string,
  model: EmbeddingModel | null,
  chunkTokens = 400,
  overlapTokens = 80,
  agentId = "default",
): Promise<number> {
  const db = getSqlite();

  const messages = db
    .prepare(
      "SELECT role, content FROM messages WHERE session_id = ? AND agent_id = ? ORDER BY created_at ASC"
    )
    .all(sessionId, agentId) as Array<{ role: string; content: string }>;

  if (!messages.length) return 0;

  // Build concatenated text: "role: content\n\n..."
  const fullText = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n\n");

  const chunks = chunkText(fullText, chunkTokens, overlapTokens);
  const now = new Date().toISOString();
  let indexed = 0;

  const existingChunks = db
    .prepare("SELECT id FROM session_chunks WHERE session_id = ? AND agent_id = ?")
    .all(sessionId, agentId) as Array<{ id: string }>;
  if (existingChunks.length) {
    const existingIds = existingChunks.map((row) => row.id);
    const placeholders = existingIds.map(() => "?").join(", ");
    withSqliteWriteRecovery("session-index-delete-existing", (database) => {
      database.prepare(`DELETE FROM memories_session_fts WHERE id IN (${placeholders})`).run(...existingIds);
      database.prepare(`DELETE FROM session_chunk_embeddings WHERE id IN (${placeholders})`).run(...existingIds);
      database.prepare("DELETE FROM session_chunks WHERE session_id = ? AND agent_id = ?").run(sessionId, agentId);
    });
    await deleteMemoryVectorsBySourceRef("session", existingIds, agentId);
  }

  const batchedEmbeddings = model
    ? await generateEmbeddingsBatch(chunks, model, 16)
    : [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkId = nanoid(12);
    const chunkText = chunks[i];
    const providerKey = model ? getEmbeddingProviderKey(model) : "";

    // Store chunk.
    withSqliteWriteRecovery("session-index-insert-chunk", (database) => {
      database.prepare(
        "INSERT OR REPLACE INTO session_chunks (id, session_id, agent_id, chunk_text, chunk_index, message_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(chunkId, sessionId, agentId, chunkText, i, messages.length, now);
    });

    // FTS5 index.
    try {
      db.prepare(
        "INSERT OR REPLACE INTO memories_session_fts (id, content) VALUES (?, ?)"
      ).run(chunkId, chunkText);
    } catch {
      // FTS may not be available in some edge cases
    }

    // Generate and store embedding.
    if (model) {
      try {
        const embedding = batchedEmbeddings[i] ?? await generateEmbedding(chunkText, model);
        if (embedding) {
          withSqliteWriteRecovery("session-index-insert-embedding", (database) => {
            database.prepare(
              "INSERT OR REPLACE INTO session_chunk_embeddings (id, agent_id, embedding, provider_id, provider_key, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
            ).run(chunkId, agentId, JSON.stringify(embedding), model.provider, providerKey, model.modelId, now);
          });
          await upsertMemoryVector("session", chunkId, embedding, model.modelId, agentId);
        }
      } catch (err) {
        log.warn("Failed to embed session chunk", { chunkId, sessionId, error: String(err) });
      }
    }

    indexed++;
  }

  log.info("Session indexed", { sessionId, chunks: indexed });
  return indexed;
}

/** Index all sessions from the messages table. */
export async function indexAllSessions(
  model: EmbeddingModel | null,
  chunkTokens = 400,
  overlapTokens = 80,
  agentId = "default",
): Promise<{ sessions: number; chunks: number }> {
  const db = getSqlite();
  const sessionRows = db
    .prepare("SELECT DISTINCT session_id FROM messages WHERE agent_id = ?")
    .all(agentId) as Array<{ session_id: string }>;

  let totalChunks = 0;
  for (const row of sessionRows) {
    try {
      const count = await indexSession(
        row.session_id,
        model,
        chunkTokens,
        overlapTokens,
        agentId,
      );
      totalChunks += count;
    } catch (err) {
      log.warn("Failed to index session", {
        sessionId: row.session_id,
        error: String(err),
      });
    }
  }

  return { sessions: sessionRows.length, chunks: totalChunks };
}

/** Hybrid search over indexed session chunks. */
export async function searchSessionChunks(
  query: string,
  queryEmbedding: number[] | null,
  limit: number,
  agentId = "default",
): Promise<SessionChunk[]> {
  const db = getSqlite();
  const scored = new Map<
    string,
    { chunk: SessionChunk; score: number }
  >();

  // BM25 text search via FTS5.
  try {
    const sanitized = query.replace(/["']/g, " ").trim();
    const ftsRows = db
      .prepare(
        "SELECT id, bm25(memories_session_fts) AS rank FROM memories_session_fts WHERE memories_session_fts MATCH ? ORDER BY rank LIMIT ?"
      )
      .all(sanitized, limit * 4) as Array<{ id: string; rank?: number }>;

    for (const row of ftsRows) {
      const chunkRow = db
        .prepare(
          "SELECT id, session_id, chunk_text, chunk_index, message_count FROM session_chunks WHERE id = ? AND agent_id = ?"
        )
        .get(row.id, agentId) as
        | { id: string; session_id: string; chunk_text: string; chunk_index: number; message_count: number }
        | undefined;
      if (!chunkRow) continue;

      const textScore = 1 / (1 + Math.abs(Number(row.rank) || 0));
      scored.set(row.id, {
        chunk: {
          id: chunkRow.id,
          sessionId: chunkRow.session_id,
          chunkText: chunkRow.chunk_text,
          chunkIndex: chunkRow.chunk_index,
          messageCount: chunkRow.message_count,
        },
        score: textScore,
      });
    }
  } catch {
    // FTS not available — vector-only mode
  }

  // Vector search over session chunk embeddings.
  if (queryEmbedding) {
    try {
      const vecMatches = await searchMemoryVectors(queryEmbedding, limit * 4, ["session"], agentId);
      const vecScored: Array<{ id: string; similarity: number }> = vecMatches.map((match) => ({
        id: match.refId,
        similarity: match.score,
      }));

      if (!vecScored.length) {
        const embRows = db
          .prepare("SELECT id, embedding FROM session_chunk_embeddings WHERE agent_id = ? LIMIT 1000")
          .all(agentId) as Array<{ id: string; embedding: string }>;
        for (const row of embRows) {
          const vec = JSON.parse(row.embedding) as number[];
          const sim = cosineSimilarity(queryEmbedding, vec);
          if (sim > 0) vecScored.push({ id: row.id, similarity: sim });
        }
      }

      const maxSim = Math.max(...vecScored.map((v) => v.similarity), 1e-9);

      for (const v of vecScored) {
        const chunkRow = db
          .prepare(
            "SELECT id, session_id, chunk_text, chunk_index, message_count FROM session_chunks WHERE id = ? AND agent_id = ?"
          )
          .get(v.id, agentId) as
          | { id: string; session_id: string; chunk_text: string; chunk_index: number; message_count: number }
          | undefined;
        if (!chunkRow) continue;

        const vecScore = v.similarity / maxSim;
        const existing = scored.get(v.id);
        if (existing) {
          existing.score = 0.7 * vecScore + 0.3 * existing.score;
        } else {
          scored.set(v.id, {
            chunk: {
              id: chunkRow.id,
              sessionId: chunkRow.session_id,
              chunkText: chunkRow.chunk_text,
              chunkIndex: chunkRow.chunk_index,
              messageCount: chunkRow.message_count,
            },
            score: 0.7 * vecScore,
          });
        }
      }
    } catch (err) {
      log.warn("Vector search over session chunks failed", { error: String(err) });
    }
  }

  return Array.from(scored.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => ({ ...item.chunk, score: item.score }));
}

/** Total count of indexed session chunks. */
export function getSessionChunkCount(agentId?: string): number {
  try {
    const row = agentId
      ? (getSqlite().prepare("SELECT COUNT(*) AS n FROM session_chunks WHERE agent_id = ?").get(agentId) as { n: number })
      : (getSqlite().prepare("SELECT COUNT(*) AS n FROM session_chunks").get() as { n: number });
    return row.n ?? 0;
  } catch {
    return 0;
  }
}

export function loadSessionChunkConfig(): {
  enabled: boolean;
  chunkTokens: number;
  overlapTokens: number;
} {
  try {
    const row = getSqlite()
      .prepare(
        "SELECT index_sessions, session_chunk_tokens, session_chunk_overlap FROM memory_config WHERE id = 'default'"
      )
      .get() as
      | {
          index_sessions?: number;
          session_chunk_tokens?: number;
          session_chunk_overlap?: number;
        }
      | undefined;
    return {
      enabled: (row?.index_sessions ?? 1) !== 0,
      chunkTokens: Math.max(100, Number(row?.session_chunk_tokens ?? 400) || 400),
      overlapTokens: Math.max(0, Number(row?.session_chunk_overlap ?? 80) || 80),
    };
  } catch {
    return { enabled: true, chunkTokens: 400, overlapTokens: 80 };
  }
}

type SessionIndexState = {
  lastMsgCount: number;
  lastIndexedAt: string;
};

function loadSessionState(sessionId: string, agentId: string): SessionIndexState {
  try {
    const row = getSqlite()
      .prepare("SELECT last_msg_count, last_indexed_at FROM session_index_state_v2 WHERE session_id = ? AND agent_id = ?")
      .get(sessionId, agentId) as { last_msg_count?: number; last_indexed_at?: string } | undefined;
    return {
      lastMsgCount: row?.last_msg_count ?? 0,
      lastIndexedAt: row?.last_indexed_at ?? new Date().toISOString(),
    };
  } catch {
    return { lastMsgCount: 0, lastIndexedAt: new Date().toISOString() };
  }
}

function saveSessionState(sessionId: string, agentId: string, lastMsgCount: number): void {
  try {
    getSqlite()
      .prepare(
        "INSERT OR REPLACE INTO session_index_state_v2 (agent_id, session_id, last_msg_count, last_indexed_at) VALUES (?, ?, ?, ?)"
      )
      .run(agentId, sessionId, lastMsgCount, new Date().toISOString());
  } catch (err) {
    log.warn("Failed to save session index state", {
      sessionId,
      agentId,
      error: String(err),
    });
  }
}

export function getSessionIndexStateSummary(agentId = "default"): {
  trackedSessions: number;
  lastIndexedAt: string | null;
} {
  try {
    const db = getSqlite();
    const countRow = db
      .prepare("SELECT COUNT(*) AS n FROM session_index_state_v2 WHERE agent_id = ?")
      .get(agentId) as { n?: number } | undefined;
    const lastRow = db
      .prepare("SELECT last_indexed_at FROM session_index_state_v2 WHERE agent_id = ? ORDER BY last_indexed_at DESC LIMIT 1")
      .get(agentId) as { last_indexed_at?: string } | undefined;
    return {
      trackedSessions: countRow?.n ?? 0,
      lastIndexedAt: lastRow?.last_indexed_at ?? null,
    };
  } catch {
    return {
      trackedSessions: 0,
      lastIndexedAt: null,
    };
  }
}

export async function indexSessionDelta(
  sessionId: string,
  model: EmbeddingModel | null,
  agentId = "default",
  chunkTokens?: number,
  overlapTokens?: number,
): Promise<{ newMessages: number; chunks: number }> {
  const config = loadSessionChunkConfig();
  if (!config.enabled) return { newMessages: 0, chunks: 0 };

  const resolvedChunkTokens = chunkTokens ?? config.chunkTokens;
  const resolvedOverlapTokens = overlapTokens ?? config.overlapTokens;
  const db = getSqlite();
  const state = loadSessionState(sessionId, agentId);
  const allMessages = db
    .prepare("SELECT role, content FROM messages WHERE session_id = ? AND agent_id = ? ORDER BY created_at ASC")
    .all(sessionId, agentId) as Array<{ role: string; content: string }>;

  if (allMessages.length <= state.lastMsgCount) {
    return { newMessages: 0, chunks: 0 };
  }

  const newMessages = allMessages.slice(state.lastMsgCount);
  const deltaText = newMessages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
  const chunks = chunkText(deltaText, resolvedChunkTokens, resolvedOverlapTokens);
  const existingChunkCount = db
    .prepare("SELECT COUNT(*) AS n FROM session_chunks WHERE session_id = ? AND agent_id = ?")
    .get(sessionId, agentId) as { n?: number } | undefined;
  const chunkOffset = existingChunkCount?.n ?? 0;
  const now = new Date().toISOString();
  const embeddings = model ? await generateEmbeddingsBatch(chunks, model, 16) : [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkId = nanoid(12);
    const chunkValue = chunks[i]!;
    const providerKey = model ? getEmbeddingProviderKey(model) : "";

    withSqliteWriteRecovery("session-delta-insert-chunk", (database) => {
      database.prepare(
        "INSERT OR REPLACE INTO session_chunks (id, session_id, agent_id, chunk_text, chunk_index, message_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(chunkId, sessionId, agentId, chunkValue, chunkOffset + i, allMessages.length, now);
    });

    try {
      db.prepare("INSERT OR REPLACE INTO memories_session_fts (id, content) VALUES (?, ?)").run(chunkId, chunkValue);
    } catch {
      // FTS may be unavailable in some test environments.
    }

    try {
      if (model) {
        const embedding = embeddings[i] ?? await generateEmbedding(chunkValue, model);
        if (embedding) {
          withSqliteWriteRecovery("session-delta-insert-embedding", (database) => {
            database.prepare(
              "INSERT OR REPLACE INTO session_chunk_embeddings (id, agent_id, embedding, provider_id, provider_key, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
            ).run(chunkId, agentId, JSON.stringify(embedding), model.provider, providerKey, model.modelId, now);
          });
          await upsertMemoryVector("session", chunkId, embedding, model.modelId, agentId);
        }
      }
    } catch (err) {
      log.warn("Failed to embed session delta chunk", {
        chunkId,
        sessionId,
        agentId,
        error: String(err),
      });
    }
  }

  saveSessionState(sessionId, agentId, allMessages.length);
  return { newMessages: newMessages.length, chunks: chunks.length };
}
