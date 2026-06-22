// Server-only — do not import in client components.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
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
import { chunkText } from "./session-indexer";
import {
  deleteMemoryVectorsBySourceRef,
  searchMemoryVectors,
  upsertMemoryVector,
} from "./sqlite-vec";
import { getPathContextForFile, scorePathContextBoost } from "./path-contexts";
import { resolveAtomicMemoryDir } from "./simple";

const log = logger.child("memory:collection-indexer");

export interface CollectionResult {
  id: string;
  fileId: string;
  filePath: string;
  chunkText: string;
  chunkIndex: number;
  score?: number;
  contextText?: string;
}

function encodeScopedFilePath(filePath: string, agentId: string): string {
  return agentId === "default" ? filePath : `${agentId}::${filePath}`;
}

function decodeScopedFilePath(filePath: string): string {
  const separator = filePath.indexOf("::");
  return separator >= 0 ? filePath.slice(separator + 2) : filePath;
}

function isLeakedAgentMemoryPath(filePath: string, agentId: string): boolean {
  if (agentId !== "default") return false;
  return filePath.replace(/\\/g, "/").includes("/data/memories/agents/");
}

function normalizeFsPath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, "/").toLowerCase();
}

function isAtomicMemoryPath(filePath: string): boolean {
  const normalized = normalizeFsPath(filePath);
  const defaultMemoryDir = normalizeFsPath(resolveAtomicMemoryDir("default"));
  const agentMemoryDir = normalizeFsPath(resolveAtomicMemoryDir("agent-scope-probe")).replace(/\/agent-scope-probe$/, "");
  return normalized === defaultMemoryDir
    || normalized.startsWith(`${defaultMemoryDir}/`)
    || normalized === agentMemoryDir
    || normalized.startsWith(`${agentMemoryDir}/`);
}

async function removeCollectionFileById(fileId: string, agentId: string): Promise<void> {
  const db = getSqlite();
  const oldChunks = db
    .prepare("SELECT id FROM collection_chunks WHERE file_id = ?")
    .all(fileId) as Array<{ id: string }>;
  const oldChunkIds = oldChunks.map((chunk) => chunk.id);
  for (const chunk of oldChunks) {
    try { db.prepare("DELETE FROM memories_collection_fts WHERE id = ?").run(chunk.id); } catch { /* ok */ }
    try {
      withSqliteWriteRecovery("collection-remove-excluded-embedding", (database) => {
        database.prepare("DELETE FROM collection_chunk_embeddings WHERE id = ?").run(chunk.id);
      });
    } catch { /* ok */ }
  }
  withSqliteWriteRecovery("collection-remove-excluded-chunks", (database) => {
    database.prepare("DELETE FROM collection_chunks WHERE file_id = ?").run(fileId);
    database.prepare("DELETE FROM collection_files WHERE id = ?").run(fileId);
  });
  await deleteMemoryVectorsBySourceRef("collection", oldChunkIds, agentId);
}

async function purgeExcludedCollectionFiles(agentId: string): Promise<void> {
  const db = getSqlite();
  const rows = db
    .prepare("SELECT id, file_path FROM collection_files")
    .all() as Array<{ id: string; file_path: string }>;
  for (const row of rows) {
    const decodedPath = decodeScopedFilePath(row.file_path);
    const isWrongScope = agentId !== "default" && row.file_path !== encodeScopedFilePath(decodedPath, agentId);
    const isDefaultScopedLeak = agentId === "default" && row.file_path.includes("::");
    if (isWrongScope || isDefaultScopedLeak || isAtomicMemoryPath(decodedPath) || isLeakedAgentMemoryPath(decodedPath, agentId)) {
      await removeCollectionFileById(row.id, agentId);
    }
  }
}

/** Expand comma-separated path list: resolve ~/ and relative paths. */
export function resolvePaths(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const expanded = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
      return path.resolve(expanded);
    });
}

/** Read extra_collection_paths from DB and resolve them. */
export function getConfiguredPaths(): string[] {
  try {
    const db = getSqlite();
    const row = db
      .prepare("SELECT extra_collection_paths FROM memory_config WHERE id = 'default'")
      .get() as { extra_collection_paths?: string | null } | undefined;
    const raw = row?.extra_collection_paths;
    if (!raw || !raw.trim()) return [];
    return resolvePaths(raw);
  } catch {
    return [];
  }
}

/** Recursively list all .md files under dir. Skips non-existent paths silently. */
export function scanMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanMarkdownFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  } catch (err) {
    log.warn("Cannot scan directory", { dir, error: String(err) });
  }
  return results;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);
}

function isRecoverableCollectionEmbeddingError(error: unknown): boolean {
  const message = String(error);
  return message.includes("database disk image is malformed") || message.includes("SQLITE_CORRUPT");
}

function repairCollectionEmbeddingCache(reason: unknown): void {
  const db = getSqlite();
  try {
    db.exec("DROP TABLE IF EXISTS collection_chunk_embeddings");
    db.exec(`
      CREATE TABLE IF NOT EXISTS collection_chunk_embeddings (
        id TEXT PRIMARY KEY,
        embedding TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT 'unknown',
        provider_key TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    log.warn("Repaired collection embedding cache table after corruption", {
      error: String(reason),
    });
  } catch (repairError) {
    log.warn("Failed to repair collection embedding cache table", {
      error: String(repairError),
      original: String(reason),
    });
  }
}

/** Index all .md files in configured extra_collection_paths. */
export async function indexCollections(model: EmbeddingModel | null, agentId = "default"): Promise<{ indexed: number }> {
  const dirs = getConfiguredPaths();
  await purgeExcludedCollectionFiles(agentId);
  if (dirs.length === 0) return { indexed: 0 };

  const db = getSqlite();
  const now = new Date().toISOString();
  let indexed = 0;

  for (const dir of dirs) {
    const files = scanMarkdownFiles(dir);
    for (const filePath of files) {
      if (isAtomicMemoryPath(filePath)) {
        continue;
      }
      try {
        const scopedPath = encodeScopedFilePath(filePath, agentId);
        const stat = fs.statSync(filePath);
        const mtime = Math.floor(stat.mtimeMs);
        const content = fs.readFileSync(filePath, "utf-8");
        const contentHash = sha256(content);

        // Check if file is already indexed and unchanged
        const existing = db
          .prepare("SELECT id, mtime, content_hash FROM collection_files WHERE file_path = ?")
          .get(scopedPath) as { id: string; mtime: number; content_hash: string } | undefined;

        if (existing && existing.mtime === mtime && existing.content_hash === contentHash) {
          continue; // unchanged
        }

        const fileId = existing?.id ?? nanoid(12);

        // Delete old chunks for changed file
        if (existing) {
          const oldChunks = db
            .prepare("SELECT id FROM collection_chunks WHERE file_id = ?")
            .all(fileId) as Array<{ id: string }>;
          const oldChunkIds = oldChunks.map((chunk) => chunk.id);
          for (const chunk of oldChunks) {
            try { db.prepare("DELETE FROM memories_collection_fts WHERE id = ?").run(chunk.id); } catch { /* ok */ }
            try { withSqliteWriteRecovery("collection-index-delete-old-embedding", (database) => { database.prepare("DELETE FROM collection_chunk_embeddings WHERE id = ?").run(chunk.id); }); } catch { /* ok */ }
          }
          withSqliteWriteRecovery("collection-index-delete-old-chunks", (database) => {
            database.prepare("DELETE FROM collection_chunks WHERE file_id = ?").run(fileId);
          });
          await deleteMemoryVectorsBySourceRef("collection", oldChunkIds, agentId);
          withSqliteWriteRecovery("collection-index-update-file", (database) => {
            database.prepare("UPDATE collection_files SET mtime = ?, content_hash = ? WHERE id = ?")
              .run(mtime, contentHash, fileId);
          });
        } else {
          withSqliteWriteRecovery("collection-index-insert-file", (database) => {
            database.prepare(
              "INSERT INTO collection_files (id, file_path, mtime, content_hash, created_at) VALUES (?, ?, ?, ?, ?)"
            ).run(fileId, scopedPath, mtime, contentHash, now);
          });
        }

        const chunks = chunkText(content);
        const batchedEmbeddings = model ? await generateEmbeddingsBatch(chunks, model, 16) : [];
        for (let i = 0; i < chunks.length; i++) {
          const chunkId = nanoid(12);
          const text = chunks[i];
          const providerKey = model ? getEmbeddingProviderKey(model) : "";

          withSqliteWriteRecovery("collection-index-insert-chunk", (database) => {
            database.prepare(
              "INSERT OR REPLACE INTO collection_chunks (id, file_id, chunk_text, chunk_index, created_at) VALUES (?, ?, ?, ?, ?)"
            ).run(chunkId, fileId, text, i, now);
          });

          try {
            db.prepare(
              "INSERT OR REPLACE INTO memories_collection_fts (id, content) VALUES (?, ?)"
            ).run(chunkId, text);
          } catch { /* FTS may not be available */ }

          if (model) {
            try {
              const embedding = batchedEmbeddings[i] ?? await generateEmbedding(text, model);
              if (embedding) {
                try {
                  withSqliteWriteRecovery("collection-index-insert-embedding", (database) => {
                    database.prepare(
                      "INSERT OR REPLACE INTO collection_chunk_embeddings (id, embedding, provider_id, provider_key, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
                    ).run(chunkId, JSON.stringify(embedding), model.provider, providerKey, model.modelId, now);
                  });
                } catch (cacheError) {
                  log.warn("Collection embedding cache write failed; continuing with sqlite-vec", {
                    chunkId,
                    filePath,
                    error: String(cacheError),
                  });
                }
                await upsertMemoryVector("collection", chunkId, embedding, model.modelId, agentId);
              }
            } catch (err) {
              log.warn("Failed to embed collection chunk", { chunkId, filePath, error: String(err) });
            }
          }

          indexed++;
        }
      } catch (err) {
        log.warn("Failed to index collection file", { filePath, error: String(err) });
      }
    }
  }

  log.info("Collection indexing complete", { indexed });
  return { indexed };
}

/**
 * Index (or re-index) a single .md file. Used by the workspace file watcher.
 * Silently skips if the file hasn't changed (mtime + content hash match).
 */
export async function indexSingleFile(
  filePath: string,
  model: EmbeddingModel | null,
  agentId = "default",
  options?: { forceReindex?: boolean },
): Promise<boolean> {
  if (!fs.existsSync(filePath) || !filePath.endsWith(".md")) return false;
  const db = getSqlite();
  const now = new Date().toISOString();

  try {
    const scopedPath = encodeScopedFilePath(filePath, agentId);
    const stat = fs.statSync(filePath);
    const mtime = Math.floor(stat.mtimeMs);
    const content = fs.readFileSync(filePath, "utf-8");
    const contentHash = sha256(content);

    const existing = db
      .prepare("SELECT id, mtime, content_hash FROM collection_files WHERE file_path = ?")
      .get(scopedPath) as { id: string; mtime: number; content_hash: string } | undefined;

    if (
      existing &&
      existing.mtime === mtime &&
      existing.content_hash === contentHash &&
      !options?.forceReindex
    ) {
      return false; // unchanged
    }

    const fileId = existing?.id ?? nanoid(12);

    if (existing) {
      const oldChunks = db
        .prepare("SELECT id FROM collection_chunks WHERE file_id = ?")
        .all(fileId) as Array<{ id: string }>;
      const oldChunkIds = oldChunks.map((chunk) => chunk.id);
      for (const chunk of oldChunks) {
        try { db.prepare("DELETE FROM memories_collection_fts WHERE id = ?").run(chunk.id); } catch { /* ok */ }
        try { withSqliteWriteRecovery("collection-file-delete-old-embedding", (database) => { database.prepare("DELETE FROM collection_chunk_embeddings WHERE id = ?").run(chunk.id); }); } catch { /* ok */ }
      }
      withSqliteWriteRecovery("collection-file-delete-old-chunks", (database) => {
        database.prepare("DELETE FROM collection_chunks WHERE file_id = ?").run(fileId);
      });
      await deleteMemoryVectorsBySourceRef("collection", oldChunkIds, agentId);
      withSqliteWriteRecovery("collection-file-update-file", (database) => {
        database.prepare("UPDATE collection_files SET mtime = ?, content_hash = ? WHERE id = ?")
          .run(mtime, contentHash, fileId);
      });
    } else {
      withSqliteWriteRecovery("collection-file-insert-file", (database) => {
        database.prepare(
          "INSERT INTO collection_files (id, file_path, mtime, content_hash, created_at) VALUES (?, ?, ?, ?, ?)"
        ).run(fileId, scopedPath, mtime, contentHash, now);
      });
    }

    const chunks = chunkText(content);
    const batchedEmbeddings = model ? await generateEmbeddingsBatch(chunks, model, 16) : [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = nanoid(12);
      const text = chunks[i];
      const providerKey = model ? getEmbeddingProviderKey(model) : "";
      withSqliteWriteRecovery("collection-file-insert-chunk", (database) => {
        database.prepare(
          "INSERT OR REPLACE INTO collection_chunks (id, file_id, chunk_text, chunk_index, created_at) VALUES (?, ?, ?, ?, ?)"
        ).run(chunkId, fileId, text, i, now);
      });
      try {
        db.prepare("INSERT OR REPLACE INTO memories_collection_fts (id, content) VALUES (?, ?)").run(chunkId, text);
      } catch { /* ok */ }
      if (model) {
        try {
          const embedding = batchedEmbeddings[i] ?? await generateEmbedding(text, model);
          if (embedding) {
            try {
              withSqliteWriteRecovery("collection-file-insert-embedding", (database) => {
                database.prepare(
                  "INSERT OR REPLACE INTO collection_chunk_embeddings (id, embedding, provider_id, provider_key, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
                ).run(chunkId, JSON.stringify(embedding), model.provider, providerKey, model.modelId, now);
              });
            } catch (cacheError) {
              log.warn("Collection embedding cache write failed; continuing with sqlite-vec", {
                chunkId,
                filePath,
                error: String(cacheError),
              });
            }
            await upsertMemoryVector("collection", chunkId, embedding, model.modelId, agentId);
          }
        } catch { /* ok */ }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Hybrid FTS5 + vector search over collection chunks. */
export async function searchCollectionChunks(
  query: string,
  queryEmbedding: number[] | null,
  limit: number,
  agentId = "default",
): Promise<CollectionResult[]> {
  await purgeExcludedCollectionFiles(agentId);
  const db = getSqlite();
  const scored = new Map<string, { result: CollectionResult; score: number }>();

  // BM25 text search via FTS5.
  try {
    const sanitized = query.replace(/["']/g, " ").trim();
    const ftsRows = db
      .prepare(
        "SELECT id, bm25(memories_collection_fts) AS rank FROM memories_collection_fts WHERE memories_collection_fts MATCH ? ORDER BY rank LIMIT ?"
      )
      .all(sanitized, limit * 4) as Array<{ id: string; rank?: number }>;

    for (const row of ftsRows) {
      const chunkRow = db
        .prepare(
          "SELECT cc.id, cc.file_id, cc.chunk_text, cc.chunk_index, cf.file_path FROM collection_chunks cc JOIN collection_files cf ON cc.file_id = cf.id WHERE cc.id = ?"
        )
        .get(row.id) as { id: string; file_id: string; chunk_text: string; chunk_index: number; file_path: string } | undefined;
      if (!chunkRow) continue;
      const decodedPath = decodeScopedFilePath(chunkRow.file_path);
      if (agentId !== "default" && chunkRow.file_path !== encodeScopedFilePath(decodedPath, agentId)) continue;
      if (agentId === "default" && chunkRow.file_path.includes("::")) continue;
      if (isLeakedAgentMemoryPath(decodedPath, agentId)) continue;
      if (isAtomicMemoryPath(decodedPath)) continue;

      const textScore = 1 / (1 + Math.abs(Number(row.rank) || 0));
      scored.set(row.id, {
        result: {
          id: chunkRow.id,
          fileId: chunkRow.file_id,
          filePath: decodedPath,
          chunkText: chunkRow.chunk_text,
          chunkIndex: chunkRow.chunk_index,
        },
        score: textScore + scorePathContextBoost(query, getPathContextForFile(decodedPath, agentId)?.contextText ?? ""),
      });
    }
  } catch { /* FTS not available */ }

  // Vector search over collection chunk embeddings.
  if (queryEmbedding) {
    try {
      const vecMatches = await searchMemoryVectors(queryEmbedding, limit * 4, ["collection"], agentId);
      const vecScored: Array<{ id: string; similarity: number }> = vecMatches.map((match) => ({
        id: match.refId,
        similarity: match.score,
      }));

      if (!vecScored.length) {
        let embRows: Array<{ id: string; embedding: string }> = [];
        try {
          embRows = db
            .prepare("SELECT id, embedding FROM collection_chunk_embeddings LIMIT 1000")
            .all() as Array<{ id: string; embedding: string }>;
        } catch (error) {
          if (isRecoverableCollectionEmbeddingError(error)) {
            repairCollectionEmbeddingCache(error);
          } else {
            throw error;
          }
        }
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
            "SELECT cc.id, cc.file_id, cc.chunk_text, cc.chunk_index, cf.file_path FROM collection_chunks cc JOIN collection_files cf ON cc.file_id = cf.id WHERE cc.id = ?"
          )
          .get(v.id) as { id: string; file_id: string; chunk_text: string; chunk_index: number; file_path: string } | undefined;
        if (!chunkRow) continue;
        const decodedPath = decodeScopedFilePath(chunkRow.file_path);
        if (agentId !== "default" && chunkRow.file_path !== encodeScopedFilePath(decodedPath, agentId)) continue;
        if (agentId === "default" && chunkRow.file_path.includes("::")) continue;
        if (isLeakedAgentMemoryPath(decodedPath, agentId)) continue;
        if (isAtomicMemoryPath(decodedPath)) continue;

        const vecScore = v.similarity / maxSim;
        const existing = scored.get(v.id);
        const contextText = getPathContextForFile(decodedPath, agentId)?.contextText;
        const boostedVecScore = vecScore + scorePathContextBoost(query, contextText ?? "");
        if (existing) {
          existing.score = 0.7 * boostedVecScore + 0.3 * existing.score;
          existing.result.contextText = contextText;
        } else {
          scored.set(v.id, {
            result: {
              id: chunkRow.id,
              fileId: chunkRow.file_id,
              filePath: decodedPath,
              chunkText: chunkRow.chunk_text,
              chunkIndex: chunkRow.chunk_index,
              contextText,
            },
            score: 0.7 * boostedVecScore,
          });
        }
      }
    } catch (err) {
      log.warn("Vector search over collection chunks failed", { error: String(err) });
    }
  }

  return Array.from(scored.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => ({ ...item.result, score: item.score }));
}

/** Total count of indexed collection chunks. */
export function getCollectionChunkCount(agentId?: string): number {
  try {
    const row = getSqlite()
      .prepare("SELECT COUNT(*) AS n FROM collection_chunks")
      .get() as { n: number };
    if (!agentId) return row.n ?? 0;
    const prefix = `${agentId}::%`;
    const scopedRow = getSqlite()
      .prepare("SELECT COUNT(*) AS n FROM collection_chunks WHERE file_id IN (SELECT id FROM collection_files WHERE file_path LIKE ?)")
      .get(prefix) as { n: number };
    return scopedRow.n ?? 0;
  } catch {
    return 0;
  }
}

/** Clear all collection tables (used by memoryClearCmd). */
export function clearCollections(): void {
  const db = getSqlite();
  try { db.exec("DELETE FROM memories_collection_fts"); } catch { /* ok */ }
  try { db.exec("DELETE FROM collection_chunk_embeddings"); } catch { /* ok */ }
  try { db.exec("DELETE FROM collection_chunks"); } catch { /* ok */ }
  try { db.exec("DELETE FROM collection_files"); } catch { /* ok */ }
}
