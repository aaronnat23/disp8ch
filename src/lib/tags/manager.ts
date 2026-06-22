import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";

export type TagScope = "general" | "workflow" | "agent" | "task" | "template";
export type TagTargetType = "workflow" | "agent" | "task";

export type TagRecord = {
  id: string;
  name: string;
  color: string;
  scope: TagScope;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  usageCount: number;
};

interface TagRow {
  id: string;
  name: string;
  color: string;
  scope: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const ALLOWED_SCOPES: TagScope[] = ["general", "workflow", "agent", "task", "template"];
const ALLOWED_TARGET_TYPES: TagTargetType[] = ["workflow", "agent", "task"];

function ensureTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#64748b',
      scope TEXT NOT NULL DEFAULT 'general',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tag_links (
      id TEXT PRIMARY KEY,
      tag_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(tag_id, target_type, target_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tag_links_target ON tag_links(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_tag_links_tag ON tag_links(tag_id);
  `);
  return db;
}

function normalizeScope(value: unknown): TagScope {
  const scope = String(value ?? "general").trim().toLowerCase();
  if (ALLOWED_SCOPES.includes(scope as TagScope)) {
    return scope as TagScope;
  }
  return "general";
}

function normalizeColor(value: unknown): string {
  const color = String(value ?? "#64748b").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  return "#64748b";
}

function normalizeTargetType(value: unknown): TagTargetType {
  const targetType = String(value ?? "").trim().toLowerCase();
  if (!ALLOWED_TARGET_TYPES.includes(targetType as TagTargetType)) {
    throw new Error(`Unsupported tag target type: ${targetType}`);
  }
  return targetType as TagTargetType;
}

function mapTag(row: TagRow, usageCount: number): TagRecord {
  return {
    id: row.id,
    name: row.name,
    color: normalizeColor(row.color),
    scope: normalizeScope(row.scope),
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    usageCount,
  };
}

export function listTags(): TagRecord[] {
  const db = ensureTables();
  const rows = db.prepare(`
    SELECT t.*, COUNT(l.id) AS usage_count
    FROM tags t
    LEFT JOIN tag_links l ON l.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.sort_order ASC, t.name ASC
  `).all() as Array<TagRow & { usage_count: number }>;

  return rows.map((row) => mapTag(row, Number(row.usage_count || 0)));
}

export function createTag(input: {
  name: string;
  color?: string;
  scope?: TagScope;
  sortOrder?: number;
}): TagRecord {
  const db = ensureTables();
  const now = new Date().toISOString();
  const id = nanoid(10);
  const name = String(input.name || "").trim();
  if (!name) {
    throw new Error("Tag name is required");
  }

  db.prepare(`
    INSERT INTO tags (id, name, color, scope, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    normalizeColor(input.color),
    normalizeScope(input.scope),
    Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0,
    now,
    now,
  );

  return listTags().find((tag) => tag.id === id)!;
}

export function updateTag(
  tagId: string,
  input: {
    name?: string;
    color?: string;
    scope?: TagScope;
    sortOrder?: number;
  },
): TagRecord {
  const db = ensureTables();
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM tags WHERE id = ?").get(tagId) as TagRow | undefined;
  if (!existing) {
    throw new Error(`Tag not found: ${tagId}`);
  }

  const name = input.name !== undefined ? String(input.name).trim() : existing.name;
  if (!name) {
    throw new Error("Tag name is required");
  }

  db.prepare(`
    UPDATE tags
    SET name = ?, color = ?, scope = ?, sort_order = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name,
    input.color !== undefined ? normalizeColor(input.color) : normalizeColor(existing.color),
    input.scope !== undefined ? normalizeScope(input.scope) : normalizeScope(existing.scope),
    input.sortOrder !== undefined && Number.isFinite(input.sortOrder)
      ? Number(input.sortOrder)
      : Number(existing.sort_order || 0),
    now,
    tagId,
  );

  return listTags().find((tag) => tag.id === tagId)!;
}

export function deleteTag(tagId: string): void {
  const db = ensureTables();
  db.prepare("DELETE FROM tag_links WHERE tag_id = ?").run(tagId);
  db.prepare("DELETE FROM tags WHERE id = ?").run(tagId);
}

export function listTagsForTarget(targetType: TagTargetType, targetId: string): TagRecord[] {
  const db = ensureTables();
  const normalizedType = normalizeTargetType(targetType);
  const links = db.prepare(`
    SELECT t.*
    FROM tags t
    INNER JOIN tag_links l ON l.tag_id = t.id
    WHERE l.target_type = ? AND l.target_id = ?
    ORDER BY t.sort_order ASC, t.name ASC
  `).all(normalizedType, targetId) as TagRow[];

  return links.map((row) => mapTag(row, 0));
}

export function listTagMapForTargets(
  targetType: TagTargetType,
  targetIds: string[],
): Record<string, TagRecord[]> {
  const normalizedType = normalizeTargetType(targetType);
  const cleaned = targetIds.map((value) => String(value || "").trim()).filter(Boolean);
  if (cleaned.length === 0) return {};

  const db = ensureTables();
  const placeholders = cleaned.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT l.target_id, t.*
    FROM tag_links l
    INNER JOIN tags t ON t.id = l.tag_id
    WHERE l.target_type = ? AND l.target_id IN (${placeholders})
    ORDER BY t.sort_order ASC, t.name ASC
  `).all(normalizedType, ...cleaned) as Array<TagRow & { target_id: string }>;

  const out: Record<string, TagRecord[]> = {};
  for (const id of cleaned) out[id] = [];

  for (const row of rows) {
    const list = out[row.target_id] || [];
    list.push(mapTag(row, 0));
    out[row.target_id] = list;
  }

  return out;
}

export function setTagsForTarget(
  targetType: TagTargetType,
  targetId: string,
  tagIds: string[],
): TagRecord[] {
  const normalizedType = normalizeTargetType(targetType);
  const normalizedTargetId = String(targetId || "").trim();
  if (!normalizedTargetId) {
    throw new Error("targetId is required");
  }

  const normalizedTagIds = Array.from(
    new Set(tagIds.map((value) => String(value || "").trim()).filter(Boolean)),
  );

  const db = ensureTables();
  const now = new Date().toISOString();

  // Keep only valid tag ids.
  const validTagIds = (() => {
    if (normalizedTagIds.length === 0) return [] as string[];
    const placeholders = normalizedTagIds.map(() => "?").join(",");
    const existing = db.prepare(`SELECT id FROM tags WHERE id IN (${placeholders})`).all(
      ...normalizedTagIds,
    ) as Array<{ id: string }>;
    return existing.map((entry) => entry.id);
  })();

  db.prepare("DELETE FROM tag_links WHERE target_type = ? AND target_id = ?").run(normalizedType, normalizedTargetId);

  const insert = db.prepare(`
    INSERT INTO tag_links (id, tag_id, target_type, target_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const tagId of validTagIds) {
    insert.run(nanoid(12), tagId, normalizedType, normalizedTargetId, now);
  }

  return listTagsForTarget(normalizedType, normalizedTargetId);
}
