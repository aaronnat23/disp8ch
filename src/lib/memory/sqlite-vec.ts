// Server-only — do not import in client components.
import Database from "better-sqlite3";
import { loadSqliteVecForDatabase } from "@/lib/db/sqlite-vec-loader";
import { logger } from "@/lib/utils/logger";
import path from "node:path";

const log = logger.child("memory:sqlite-vec");

export type MemoryVectorSource = "atomic" | "session" | "collection" | "document";

type VecMatch = {
  source: MemoryVectorSource;
  scopeId: string;
  refId: string;
  distance: number;
  score: number;
};

type VecStatus = {
  loaded: boolean;
  available: boolean;
  dimensions: number | null;
  error: string | null;
};

let loadPromise: Promise<boolean> | null = null;
let available = false;
let loadError: string | null = null;
let activeDimensions: number | null = null;
let legacyVecTableDropped = false;
let vectorDb: Database.Database | null = null;

const LEGACY_VEC_TABLE = "memory_vectors_vec";

function getVectorDb(): Database.Database {
  if (vectorDb) return vectorDb;
  const dbPath = path.resolve(process.env.MEMORY_VECTOR_DB_PATH || "./data/memory-vectors.db");
  const db = new Database(dbPath);
  db.pragma(process.platform === "win32" ? "journal_mode = DELETE" : "journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  vectorDb = db;
  return db;
}

function parseDimensions(sql: string | undefined): number | null {
  if (!sql) return null;
  const match = sql.match(/float\[(\d+)\]/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

async function loadExtension(): Promise<boolean> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const status = loadSqliteVecForDatabase(getVectorDb() as unknown as object);
      available = status.available;
      loadError = status.error;
      if (!status.available) {
        return false;
      }
      return true;
    } catch (error) {
      available = false;
      loadError = String(error);
      log.warn("sqlite-vec unavailable; falling back to JSON embeddings", {
        error: loadError,
      });
      return false;
    }
  })();
  return loadPromise;
}

function ensureMetadataTable(): void {
  const db = getVectorDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_vector_index (
      vector_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_memory_vector_index_dimensions ON memory_vector_index(dimensions)");
}

function normalizeDimensions(dimensions: number): number {
  return Math.max(1, Math.floor(dimensions));
}

function getVecTableName(dimensions: number): string {
  const normalized = normalizeDimensions(dimensions);
  return `memory_vectors_vec_${normalized}`;
}

function tableExists(name: string): boolean {
  const db = getVectorDb();
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function dropLegacyVecTable(): void {
  if (legacyVecTableDropped) return;
  ensureMetadataTable();
  const db = getVectorDb();
  if (tableExists(LEGACY_VEC_TABLE)) {
    db.exec(`DROP TABLE IF EXISTS ${LEGACY_VEC_TABLE}`);
    log.warn("Dropped legacy sqlite-vec table in favor of per-dimension tables", {
      table: LEGACY_VEC_TABLE,
    });
  }
  legacyVecTableDropped = true;
}

function repairDimensionTable(dimensions: number, error: unknown): void {
  const db = getVectorDb();
  const normalized = normalizeDimensions(dimensions);
  const tableName = getVecTableName(normalized);
  try {
    db.exec(`DROP TABLE IF EXISTS ${tableName}`);
  } catch {
    // Best-effort repair path.
  }
  try {
    db.prepare("DELETE FROM memory_vector_index WHERE dimensions = ?").run(normalized);
  } catch {
    // Best-effort repair path.
  }
  log.warn("Repaired sqlite-vec dimension table after failure", {
    tableName,
    dimensions: normalized,
    error: String(error),
  });
}

function isRecoverableVecError(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("vectors blob read error") ||
    message.includes("could not write vector blob") ||
    message.includes("Internal sqlite-vec error") ||
    message.includes("_vector_chunks") ||
    message.includes("database disk image is malformed") ||
    message.includes("SQLITE_CORRUPT")
  );
}

function ensureVecTable(dimensions: number): string {
  const normalized = normalizeDimensions(dimensions);
  ensureMetadataTable();
  dropLegacyVecTable();
  const db = getVectorDb();
  const tableName = getVecTableName(normalized);
  if (!tableExists(tableName)) {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(vector_key TEXT PRIMARY KEY, embedding float[${normalized}] distance_metric=cosine)`
    );
  }
  activeDimensions = normalized;
  return tableName;
}

function buildVectorKey(source: MemoryVectorSource, scopeId: string, refId: string): string {
  return `${source}:${scopeId}:${refId}`;
}

export async function isSqliteVecReady(): Promise<boolean> {
  return loadExtension();
}

export function getSqliteVecStatus(): VecStatus {
  return {
    loaded: loadPromise !== null,
    available,
    dimensions: activeDimensions,
    error: loadError,
  };
}

export async function upsertMemoryVector(
  source: MemoryVectorSource,
  refId: string,
  embedding: number[],
  modelId: string,
  scopeId = "default",
): Promise<boolean> {
  if (!embedding.length) return false;
  const ready = await loadExtension();
  if (!ready) return false;

  const db = getVectorDb();
  const dimensions = normalizeDimensions(embedding.length);
  const tableName = ensureVecTable(dimensions);
  const vectorKey = buildVectorKey(source, scopeId, refId);
  const now = new Date().toISOString();

  const vector = new Float32Array(embedding);
  const write = () => {
    const existing = db
      .prepare("SELECT dimensions FROM memory_vector_index WHERE vector_key = ?")
      .get(vectorKey) as { dimensions?: number } | undefined;
    const previousDimensions = existing?.dimensions ? normalizeDimensions(existing.dimensions) : null;
    if (previousDimensions && previousDimensions !== dimensions) {
      const previousTable = getVecTableName(previousDimensions);
      if (tableExists(previousTable)) {
        db.prepare(`DELETE FROM ${previousTable} WHERE vector_key = ?`).run(vectorKey);
      }
    }
    if (tableExists(LEGACY_VEC_TABLE)) {
      db.prepare(`DELETE FROM ${LEGACY_VEC_TABLE} WHERE vector_key = ?`).run(vectorKey);
    }
    // Keep sqlite-vec writes outside a wider SQL transaction. The virtual table
    // has been more stable on WSL/Windows-mounted workspaces when written directly.
    db.prepare(`DELETE FROM ${tableName} WHERE vector_key = ?`).run(vectorKey);
    db.prepare(`INSERT INTO ${tableName} (vector_key, embedding) VALUES (?, ?)`).run(vectorKey, vector);
    db.prepare(
      "INSERT OR REPLACE INTO memory_vector_index (vector_key, source, ref_id, model_id, dimensions, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(vectorKey, source, refId, modelId, dimensions, now);
  };

  try {
    write();
    return true;
  } catch (error) {
    if (!isRecoverableVecError(error)) throw error;
    repairDimensionTable(dimensions, error);
    try {
      ensureVecTable(dimensions);
      write();
      return true;
    } catch (retryError) {
      log.warn("sqlite-vec upsert failed after repair; keeping JSON fallback only", {
        vectorKey,
        dimensions,
        error: String(retryError),
      });
      return false;
    }
  }
}

export async function deleteMemoryVector(source: MemoryVectorSource, refId: string, scopeId = "default"): Promise<void> {
  const ready = await loadExtension();
  if (!ready) return;
  const db = getVectorDb();
  const vectorKey = buildVectorKey(source, scopeId, refId);
  try {
    const row = db
      .prepare("SELECT dimensions FROM memory_vector_index WHERE vector_key = ?")
      .get(vectorKey) as { dimensions?: number } | undefined;
    if (row?.dimensions) {
      const tableName = getVecTableName(row.dimensions);
      if (tableExists(tableName)) {
        db.prepare(`DELETE FROM ${tableName} WHERE vector_key = ?`).run(vectorKey);
      }
    }
    if (tableExists(LEGACY_VEC_TABLE)) {
      db.prepare(`DELETE FROM ${LEGACY_VEC_TABLE} WHERE vector_key = ?`).run(vectorKey);
    }
    db.prepare("DELETE FROM memory_vector_index WHERE vector_key = ?").run(vectorKey);
  } catch {
    // Non-fatal cleanup path.
  }
}

export async function deleteMemoryVectorsBySourceRef(source: MemoryVectorSource, refIds: string[], scopeId = "default"): Promise<void> {
  if (!refIds.length) return;
  const ready = await loadExtension();
  if (!ready) return;
  const db = getVectorDb();
  const keys = refIds.map((refId) => buildVectorKey(source, scopeId, refId));
  const placeholders = keys.map(() => "?").join(", ");
  try {
    const rows = db
      .prepare(`SELECT vector_key, dimensions FROM memory_vector_index WHERE vector_key IN (${placeholders})`)
      .all(...keys) as Array<{ vector_key: string; dimensions: number }>;
    const byDimensions = new Map<number, string[]>();
    for (const row of rows) {
      const dimension = normalizeDimensions(row.dimensions);
      const bucket = byDimensions.get(dimension);
      if (bucket) {
        bucket.push(row.vector_key);
      } else {
        byDimensions.set(dimension, [row.vector_key]);
      }
    }
    for (const [dimension, vectorKeys] of byDimensions) {
      const tableName = getVecTableName(dimension);
      if (!tableExists(tableName)) continue;
      const scopedPlaceholders = vectorKeys.map(() => "?").join(", ");
      db.prepare(`DELETE FROM ${tableName} WHERE vector_key IN (${scopedPlaceholders})`).run(...vectorKeys);
    }
    if (tableExists(LEGACY_VEC_TABLE)) {
      db.prepare(`DELETE FROM ${LEGACY_VEC_TABLE} WHERE vector_key IN (${placeholders})`).run(...keys);
    }
    db.prepare(`DELETE FROM memory_vector_index WHERE vector_key IN (${placeholders})`).run(...keys);
  } catch {
    // Non-fatal cleanup path.
  }
}

export async function searchMemoryVectors(
  embedding: number[],
  limit: number,
  sources?: MemoryVectorSource[],
  scopeId = "default",
): Promise<VecMatch[]> {
  if (!embedding.length) return [];
  const ready = await loadExtension();
  if (!ready) return [];
  const dimensions = normalizeDimensions(embedding.length);
  const tableName = ensureVecTable(dimensions);
  const db = getVectorDb();

  let rawMatches: Array<{ vector_key: string; distance: number }> = [];
  try {
    rawMatches = db.prepare(
      `SELECT vector_key, distance FROM ${tableName} WHERE embedding MATCH ? AND k = ?`
    ).all(new Float32Array(embedding), Math.max(1, limit)) as Array<{ vector_key: string; distance: number }>;
  } catch (error) {
    if (!isRecoverableVecError(error)) throw error;
    repairDimensionTable(dimensions, error);
    return [];
  }

  if (!rawMatches.length) return [];
  const filterSources = new Set(sources ?? []);

  return rawMatches
    .map((row) => {
      const sep = row.vector_key.indexOf(":");
      const secondSep = row.vector_key.indexOf(":", sep + 1);
      const source = row.vector_key.slice(0, sep) as MemoryVectorSource;
      const parsedScopeId = row.vector_key.slice(sep + 1, secondSep);
      const refId = row.vector_key.slice(secondSep + 1);
      return {
        source,
        scopeId: parsedScopeId,
        refId,
        distance: row.distance,
        score: 1 - row.distance,
      };
    })
    .filter((match) => (!filterSources.size || filterSources.has(match.source)) && match.scopeId === scopeId)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
