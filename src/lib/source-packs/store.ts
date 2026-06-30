/**
 * Source-pack persistence. Tables are created lazily (same migration pattern as
 * the boards manager) so this module can be used in isolation by tests and the
 * compiler. Only metadata + extracted text + chunk content is stored — never raw
 * binary blobs.
 */
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { sha256 } from "./extractors";
import type {
  SourcePack,
  SourcePackChunk,
  SourcePackCreatedBySurface,
  SourcePackItem,
  SourcePackItemKind,
  SourcePackOriginType,
  SourcePackStatus,
} from "./types";

function ensureTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_packs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      origin_type TEXT NOT NULL DEFAULT 'mixed',
      origin_refs_json TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_by_surface TEXT NOT NULL DEFAULT 'documents',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_pack_items (
      id TEXT PRIMARY KEY,
      source_pack_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      source_uri TEXT,
      mime_type TEXT,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      text_excerpt TEXT,
      skipped_reason TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_pack_chunks (
      id TEXT PRIMARY KEY,
      source_pack_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_source_pack_items_pack ON source_pack_items(source_pack_id);
    CREATE INDEX IF NOT EXISTS idx_source_pack_chunks_pack ON source_pack_chunks(source_pack_id);
    CREATE INDEX IF NOT EXISTS idx_source_pack_chunks_item ON source_pack_chunks(item_id);
  `);
  return db;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createSourcePack(input: {
  name: string;
  description?: string | null;
  originType: SourcePackOriginType;
  originRefs?: string[];
  createdBySurface?: SourcePackCreatedBySurface;
  status?: SourcePackStatus;
}): SourcePack {
  const db = ensureTables();
  const name = String(input.name || "").trim();
  if (!name) throw new Error("source pack name is required");
  const id = `sp_${nanoid(12)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO source_packs (id, name, description, origin_type, origin_refs_json, status, created_by_surface, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    input.description ?? null,
    input.originType,
    JSON.stringify(input.originRefs ?? []),
    input.status ?? "draft",
    input.createdBySurface ?? "documents",
    now,
    now,
  );
  return getSourcePack(id)!;
}

export function addSourcePackItem(input: {
  sourcePackId: string;
  kind: SourcePackItemKind;
  displayName: string;
  sourceUri?: string | null;
  mimeType?: string | null;
  text: string | null;
  sizeBytes?: number;
  skippedReason?: string | null;
  metadata?: Record<string, unknown>;
  chunkTokens?: number;
}): { item: SourcePackItem; chunks: SourcePackChunk[] } {
  const db = ensureTables();
  const now = new Date().toISOString();
  const itemId = `spi_${nanoid(12)}`;
  const text = input.text ?? null;
  const itemHash = sha256(text ?? `${input.displayName}:${input.skippedReason ?? "skipped"}`);
  const excerpt = text ? text.slice(0, 600) : null;
  db.prepare(
    `INSERT INTO source_pack_items (id, source_pack_id, kind, display_name, source_uri, mime_type, sha256, size_bytes, text_excerpt, skipped_reason, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    itemId,
    input.sourcePackId,
    input.kind,
    input.displayName,
    input.sourceUri ?? null,
    input.mimeType ?? null,
    itemHash,
    input.sizeBytes ?? (text ? Buffer.byteLength(text, "utf8") : 0),
    excerpt,
    input.skippedReason ?? null,
    JSON.stringify(input.metadata ?? {}),
    now,
  );

  const chunks: SourcePackChunk[] = [];
  if (text && !input.skippedReason) {
    // Lazy import to avoid pulling the embedding stack into deterministic tests.
    const { chunkText } = require("@/lib/memory/session-indexer") as {
      chunkText: (t: string, c?: number, o?: number) => string[];
    };
    const pieces = chunkText(text, input.chunkTokens ?? 400, 80);
    const insertChunk = db.prepare(
      `INSERT INTO source_pack_chunks (id, source_pack_id, item_id, chunk_index, content, token_estimate, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    pieces.forEach((content, index) => {
      const chunkId = `spc_${nanoid(12)}`;
      const chunkHash = sha256(content);
      const tokenEstimate = Math.ceil(content.length / 4);
      insertChunk.run(chunkId, input.sourcePackId, itemId, index, content, tokenEstimate, chunkHash);
      chunks.push({
        id: chunkId,
        sourcePackId: input.sourcePackId,
        itemId,
        chunkIndex: index,
        content,
        tokenEstimate,
        sha256: chunkHash,
      });
    });
  }

  db.prepare("UPDATE source_packs SET updated_at = ? WHERE id = ?").run(now, input.sourcePackId);
  return { item: getSourcePackItem(itemId)!, chunks };
}

export function setSourcePackStatus(id: string, status: SourcePackStatus): SourcePack {
  const db = ensureTables();
  db.prepare("UPDATE source_packs SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    new Date().toISOString(),
    id,
  );
  const pack = getSourcePack(id);
  if (!pack) throw new Error(`Source pack not found: ${id}`);
  return pack;
}

export function getSourcePack(id: string): SourcePack | null {
  const db = ensureTables();
  const row = db.prepare("SELECT * FROM source_packs WHERE id = ?").get(id) as
    | {
        id: string;
        name: string;
        description: string | null;
        origin_type: string;
        origin_refs_json: string | null;
        status: string;
        created_by_surface: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  const itemCount = (
    db.prepare("SELECT COUNT(*) AS c FROM source_pack_items WHERE source_pack_id = ?").get(id) as { c: number }
  ).c;
  const chunkCount = (
    db.prepare("SELECT COUNT(*) AS c FROM source_pack_chunks WHERE source_pack_id = ?").get(id) as { c: number }
  ).c;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    originType: row.origin_type as SourcePackOriginType,
    originRefs: parseJsonArray(row.origin_refs_json),
    status: row.status as SourcePackStatus,
    createdBySurface: row.created_by_surface as SourcePackCreatedBySurface,
    itemCount,
    chunkCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSourcePacks(limit = 100): SourcePack[] {
  const db = ensureTables();
  const rows = db
    .prepare("SELECT id FROM source_packs ORDER BY updated_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(500, limit))) as Array<{ id: string }>;
  return rows.map((r) => getSourcePack(r.id)).filter((p): p is SourcePack => Boolean(p));
}

export function getSourcePackItem(id: string): SourcePackItem | null {
  const db = ensureTables();
  const row = db.prepare("SELECT * FROM source_pack_items WHERE id = ?").get(id) as
    | {
        id: string;
        source_pack_id: string;
        kind: string;
        display_name: string;
        source_uri: string | null;
        mime_type: string | null;
        sha256: string;
        size_bytes: number;
        text_excerpt: string | null;
        skipped_reason: string | null;
        metadata_json: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    sourcePackId: row.source_pack_id,
    kind: row.kind as SourcePackItemKind,
    displayName: row.display_name,
    sourceUri: row.source_uri,
    mimeType: row.mime_type,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes ?? 0),
    textExcerpt: row.text_excerpt,
    skippedReason: row.skipped_reason,
    metadata: parseJsonObject(row.metadata_json),
  };
}

export function listSourcePackItems(sourcePackId: string): SourcePackItem[] {
  const db = ensureTables();
  const rows = db
    .prepare("SELECT id FROM source_pack_items WHERE source_pack_id = ? ORDER BY created_at ASC, display_name ASC")
    .all(sourcePackId) as Array<{ id: string }>;
  return rows.map((r) => getSourcePackItem(r.id)).filter((i): i is SourcePackItem => Boolean(i));
}

export function listSourcePackChunks(sourcePackId: string, limit = 400): SourcePackChunk[] {
  const db = ensureTables();
  const rows = db
    .prepare(
      "SELECT * FROM source_pack_chunks WHERE source_pack_id = ? ORDER BY item_id ASC, chunk_index ASC LIMIT ?",
    )
    .all(sourcePackId, Math.max(1, Math.min(2000, limit))) as Array<{
    id: string;
    source_pack_id: string;
    item_id: string;
    chunk_index: number;
    content: string;
    token_estimate: number;
    sha256: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    sourcePackId: row.source_pack_id,
    itemId: row.item_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    tokenEstimate: Number(row.token_estimate ?? 0),
    sha256: row.sha256,
  }));
}

export function deleteSourcePack(id: string): void {
  const db = ensureTables();
  db.prepare("DELETE FROM source_pack_chunks WHERE source_pack_id = ?").run(id);
  db.prepare("DELETE FROM source_pack_items WHERE source_pack_id = ?").run(id);
  db.prepare("DELETE FROM source_packs WHERE id = ?").run(id);
}
