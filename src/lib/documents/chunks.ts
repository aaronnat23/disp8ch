// Server-only document chunking and retrieval.
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { chunkText } from "@/lib/memory/session-indexer";
import {
  cosineSimilarity,
  generateEmbedding,
  generateEmbeddingsBatch,
  getConfiguredEmbeddingModelId,
  getEmbeddingModel,
  getEmbeddingProviderKey,
  type EmbeddingModel,
} from "@/lib/memory/embedding-provider";
import {
  deleteMemoryVectorsBySourceRef,
  searchMemoryVectors,
  upsertMemoryVector,
} from "@/lib/memory/sqlite-vec";
import { logger } from "@/lib/utils/logger";

const log = logger.child("documents:chunks");
const DEFAULT_CHUNK_TOKENS = 450;
const DEFAULT_OVERLAP_TOKENS = 80;

export type DocumentChunkRecord = {
  id: string;
  documentId: string;
  documentName: string;
  ord: number;
  text: string;
  charStart: number;
  charEnd: number;
  embeddingStatus: "pending" | "embedded" | "unavailable" | "error";
  score?: number;
  citation: string;
};

type ChunkRow = {
  id: string;
  document_id: string;
  ord: number;
  text: string;
  char_start: number;
  char_end: number;
  embedding_status: string;
};

type SearchOptions = {
  notebookId?: string;
  documentIds?: string[];
  limit?: number;
};

function ensureChunkTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      ord INTEGER NOT NULL,
      text TEXT NOT NULL,
      char_start INTEGER NOT NULL DEFAULT 0,
      char_end INTEGER NOT NULL DEFAULT 0,
      embedding_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_document_chunks_document_ord ON document_chunks(document_id, ord);
    CREATE INDEX IF NOT EXISTS idx_document_chunks_status ON document_chunks(embedding_status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS document_chunk_embeddings (
      id TEXT PRIMARY KEY,
      embedding TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT 'unknown',
      provider_key TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
      id,
      document_id,
      content,
      tokenize = 'unicode61'
    );
  `);
  return db;
}

function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/["']/g, " ")
    .replace(/[^\p{L}\p{N}_@.\-:/\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 16)
    .join(" ");
}

function normalizeContextMode(value: unknown): "off" | "summary" | "full" {
  const mode = String(value || "summary").toLowerCase();
  return mode === "off" || mode === "full" ? mode : "summary";
}

function makeChunksWithOffsets(text: string): Array<{ text: string; start: number; end: number }> {
  const chunks = chunkText(text, DEFAULT_CHUNK_TOKENS, DEFAULT_OVERLAP_TOKENS);
  const out: Array<{ text: string; start: number; end: number }> = [];
  let searchFrom = 0;
  for (const chunk of chunks) {
    const needle = chunk.slice(0, Math.min(chunk.length, 80));
    const found = needle ? text.indexOf(needle, searchFrom) : -1;
    const start = found >= 0 ? found : searchFrom;
    const end = Math.min(text.length, start + chunk.length);
    out.push({ text: chunk, start, end });
    searchFrom = Math.max(start + 1, end - DEFAULT_OVERLAP_TOKENS * 4);
  }
  return out;
}

function mapChunkRow(row: ChunkRow, documentName: string, score?: number): DocumentChunkRecord {
  const ord = Number(row.ord || 0);
  return {
    id: row.id,
    documentId: row.document_id,
    documentName,
    ord,
    text: row.text,
    charStart: Number(row.char_start || 0),
    charEnd: Number(row.char_end || 0),
    embeddingStatus: normalizeEmbeddingStatus(row.embedding_status),
    score,
    citation: `${documentName} §${ord + 1}`,
  };
}

function normalizeEmbeddingStatus(value: string): DocumentChunkRecord["embeddingStatus"] {
  return value === "embedded" || value === "unavailable" || value === "error" ? value : "pending";
}

function getAllowedDocumentIds(options: SearchOptions): Set<string> | null {
  const explicitIds = (options.documentIds || []).map((id) => String(id || "").trim()).filter(Boolean);
  if (explicitIds.length) return new Set(explicitIds);
  if (!options.notebookId) return null;
  const db = ensureChunkTables();
  const rows = db
    .prepare(
      "SELECT document_id, context_mode FROM notebook_documents WHERE notebook_id = ?",
    )
    .all(options.notebookId) as Array<{ document_id: string; context_mode: string }>;
  return new Set(
    rows
      .filter((row) => normalizeContextMode(row.context_mode) !== "off")
      .map((row) => row.document_id),
  );
}

async function deleteChunkVectors(chunkIds: string[]) {
  try {
    await deleteMemoryVectorsBySourceRef("document", chunkIds, "default");
  } catch (error) {
    log.warn("Failed to delete document vectors", { error: String(error) });
  }
}

export async function deleteDocumentChunks(documentId: string): Promise<void> {
  const db = ensureChunkTables();
  const rows = db
    .prepare("SELECT id FROM document_chunks WHERE document_id = ?")
    .all(documentId) as Array<{ id: string }>;
  const ids = rows.map((row) => row.id);
  withSqliteWriteRecovery("document-chunks-delete", (database) => {
    database.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(documentId);
    database.prepare("DELETE FROM document_chunks_fts WHERE document_id = ?").run(documentId);
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      database.prepare(`DELETE FROM document_chunk_embeddings WHERE id IN (${placeholders})`).run(...ids);
    }
  });
  await deleteChunkVectors(ids);
}

export async function indexDocumentChunks(params: {
  documentId: string;
  text: string;
  embeddingModelId?: string;
}): Promise<{ chunks: number; embedded: number; embeddingStatus: string }> {
  const db = ensureChunkTables();
  await deleteDocumentChunks(params.documentId);

  const now = new Date().toISOString();
  const chunks = makeChunksWithOffsets(params.text || "");
  const modelId = params.embeddingModelId || getConfiguredEmbeddingModelId();
  const model = modelId === "disabled" ? null : getEmbeddingModel(modelId);
  const embeddings = model ? await generateEmbeddingsBatch(chunks.map((chunk) => chunk.text), model, 12) : [];
  let embedded = 0;

  withSqliteWriteRecovery("document-chunks-insert", (database) => {
    const insertChunk = database.prepare(
      `INSERT INTO document_chunks
        (id, document_id, ord, text, char_start, char_end, embedding_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = database.prepare(
      "INSERT OR REPLACE INTO document_chunks_fts (id, document_id, content) VALUES (?, ?, ?)",
    );
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? null;
      const status = model ? (embedding ? "embedded" : "error") : "unavailable";
      const chunkId = nanoid(12);
      insertChunk.run(chunkId, params.documentId, i, chunk.text, chunk.start, chunk.end, status, now, now);
      insertFts.run(chunkId, params.documentId, chunk.text);
      chunks[i] = { ...chunk, text: `${chunkId}\n${chunk.text}` };
    }
  });

  if (model) {
    const rows = db
      .prepare("SELECT id, text FROM document_chunks WHERE document_id = ? ORDER BY ord ASC")
      .all(params.documentId) as Array<{ id: string; text: string }>;
    for (let i = 0; i < rows.length; i++) {
      const embedding = embeddings[i] ?? null;
      if (!embedding) continue;
      await storeChunkEmbedding(rows[i].id, embedding, model);
      embedded += 1;
    }
  }

  return {
    chunks: chunks.length,
    embedded,
    embeddingStatus: model ? (embedded > 0 ? "embedded" : "error") : "unavailable",
  };
}

async function storeChunkEmbedding(chunkId: string, embedding: number[], model: EmbeddingModel) {
  const db = ensureChunkTables();
  const now = new Date().toISOString();
  const providerKey = getEmbeddingProviderKey(model);
  withSqliteWriteRecovery("document-chunk-embedding-insert", (database) => {
    database.prepare(
      `INSERT OR REPLACE INTO document_chunk_embeddings
        (id, embedding, provider_id, provider_key, model_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(chunkId, JSON.stringify(embedding), model.provider, providerKey, model.modelId, now);
    database.prepare("UPDATE document_chunks SET embedding_status = 'embedded', updated_at = ? WHERE id = ?").run(now, chunkId);
  });
  await upsertMemoryVector("document", chunkId, embedding, model.modelId, "default");
}

export async function rebuildDocumentEmbeddings(documentIds?: string[]): Promise<{
  documents: number;
  chunks: number;
  embedded: number;
}> {
  const db = ensureChunkTables();
  const rows = documentIds?.length
    ? db.prepare(`SELECT id, extracted_text FROM documents WHERE id IN (${documentIds.map(() => "?").join(",")})`).all(...documentIds)
    : db.prepare("SELECT id, extracted_text FROM documents ORDER BY created_at DESC").all();
  let chunks = 0;
  let embedded = 0;
  for (const row of rows as Array<{ id: string; extracted_text: string }>) {
    const result = await indexDocumentChunks({ documentId: row.id, text: row.extracted_text });
    chunks += result.chunks;
    embedded += result.embedded;
  }
  return { documents: (rows as unknown[]).length, chunks, embedded };
}

export async function searchDocumentsSemantic(
  query: string,
  options: SearchOptions = {},
): Promise<DocumentChunkRecord[]> {
  const db = ensureChunkTables();
  const trimmed = query.trim();
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 10));
  if (!trimmed) return [];

  const allowedIds = getAllowedDocumentIds(options);
  if (allowedIds && allowedIds.size === 0) return [];

  const scored = new Map<string, { row: ChunkRow; score: number }>();
  const addScore = (row: ChunkRow, score: number) => {
    if (allowedIds && !allowedIds.has(row.document_id)) return;
    const existing = scored.get(row.id);
    scored.set(row.id, { row, score: (existing?.score || 0) + score });
  };

  const ftsQuery = sanitizeFtsQuery(trimmed);
  if (ftsQuery) {
    try {
      const ftsRows = db
        .prepare(
          `SELECT c.*, bm25(document_chunks_fts) AS rank
             FROM document_chunks_fts f
             JOIN document_chunks c ON c.id = f.id
            WHERE document_chunks_fts MATCH ?
            ORDER BY rank
            LIMIT ?`,
        )
        .all(ftsQuery, limit * 6) as Array<ChunkRow & { rank?: number }>;
      ftsRows.forEach((row, index) => {
        const bm25Score = 1 / (1 + Math.abs(Number(row.rank) || 0));
        addScore(row, bm25Score + 1 / (index + 1));
      });
      if (ftsRows.length === 0) {
        addTokenOverlapFallback(db, trimmed, limit * 4, addScore);
      }
    } catch {
      addTokenOverlapFallback(db, trimmed, limit * 4, addScore);
    }
  }

  const model = getEmbeddingModel(getConfiguredEmbeddingModelId());
  const queryEmbedding = model ? await generateEmbedding(trimmed, model) : null;
  if (queryEmbedding) {
    const vecMatches = await searchMemoryVectors(queryEmbedding, limit * 6, ["document"], "default");
    for (let index = 0; index < vecMatches.length; index++) {
      const match = vecMatches[index];
      const row = db
        .prepare("SELECT * FROM document_chunks WHERE id = ?")
        .get(match.refId) as ChunkRow | undefined;
      if (row) addScore(row, Math.max(0, match.score) + 1 / (index + 1));
    }

    if (vecMatches.length === 0) {
      const embRows = db
        .prepare("SELECT id, embedding FROM document_chunk_embeddings LIMIT 1000")
        .all() as Array<{ id: string; embedding: string }>;
      for (const embRow of embRows) {
        try {
          const row = db.prepare("SELECT * FROM document_chunks WHERE id = ?").get(embRow.id) as ChunkRow | undefined;
          if (!row) continue;
          const similarity = cosineSimilarity(queryEmbedding, JSON.parse(embRow.embedding) as number[]);
          if (similarity > 0) addScore(row, similarity);
        } catch {
          // Skip malformed embeddings.
        }
      }
    }
  }

  const docIds = Array.from(new Set(Array.from(scored.values()).map((item) => item.row.document_id)));
  const names = new Map<string, string>();
  if (docIds.length) {
    const rows = db
      .prepare(`SELECT id, name FROM documents WHERE id IN (${docIds.map(() => "?").join(",")})`)
      .all(...docIds) as Array<{ id: string; name: string }>;
    rows.forEach((row) => names.set(row.id, row.name));
  }

  return Array.from(scored.values())
    .sort((a, b) => b.score - a.score || a.row.ord - b.row.ord)
    .slice(0, limit)
    .map((item) => mapChunkRow(item.row, names.get(item.row.document_id) || item.row.document_id, item.score));
}

function addTokenOverlapFallback(
  db: ReturnType<typeof getSqlite>,
  query: string,
  limit: number,
  addScore: (row: ChunkRow, score: number) => void,
) {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .slice(0, 8);
  if (!tokens.length) return;
  const clauses = tokens.map(() => "LOWER(text) LIKE ?").join(" OR ");
  const rows = db
    .prepare(`SELECT * FROM document_chunks WHERE ${clauses} ORDER BY updated_at DESC LIMIT ?`)
    .all(...tokens.map((token) => `%${token}%`), limit) as ChunkRow[];
  rows.forEach((row, index) => {
    const lower = row.text.toLowerCase();
    const overlap = tokens.filter((token) => lower.includes(token)).length;
    addScore(row, overlap + 1 / (index + 2));
  });
}
