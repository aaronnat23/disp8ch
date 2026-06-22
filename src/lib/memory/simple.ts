import type { MemoryProvider, Message } from "./types";
import type { MemoryEntry, MemoryStats } from "@/types/memory";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { getSqlite } from "@/lib/db";
import { markIdentifierObservationsDeleted, recordIdentifierObservation } from "./identifier-index";

const MEMORY_PATH = process.env.MEMORY_PATH || "./data/memories";

function resolveAtomicMemoryBaseDir(): string {
  const resolved = path.resolve(MEMORY_PATH);
  const basename = path.basename(resolved).toLowerCase();
  if (basename === "memory.md" || path.extname(resolved).toLowerCase() === ".md") {
    return path.join(path.dirname(resolved), "memories");
  }
  return resolved;
}

export function resolveAtomicMemoryDir(agentId = "default"): string {
  const baseDir = resolveAtomicMemoryBaseDir();
  return agentId === "default"
    ? baseDir
    : path.resolve(path.join(baseDir, "agents", agentId));
}

function readAtomicScopeAgent(id: string): string {
  try {
    const row = getSqlite()
      .prepare("SELECT agent_id FROM memory_atomic_scope WHERE id = ?")
      .get(id) as { agent_id?: string } | undefined;
    return String(row?.agent_id || "default");
  } catch {
    return "default";
  }
}

type DecayConfig = { enabled: boolean; halfLifeDays: number };

function loadDecayConfig(): DecayConfig {
  try {
    const db = getSqlite();
    const row = db
      .prepare("SELECT decay_enabled, decay_half_life_days FROM memory_config WHERE id = 'default'")
      .get() as { decay_enabled?: number; decay_half_life_days?: number } | undefined;
    return {
      enabled: (row?.decay_enabled ?? 1) !== 0,
      halfLifeDays: Math.max(1, Number(row?.decay_half_life_days) || 30),
    };
  } catch {
    return { enabled: true, halfLifeDays: 30 };
  }
}

function normalizeMemoryContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseIsoDate(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = new Date(raw).getTime();
  return Number.isFinite(value) ? value : null;
}

function recencyFactor(dateIso?: string, decay?: DecayConfig): number {
  const cfg = decay ?? loadDecayConfig();
  if (!cfg.enabled) return 1;
  const ts = parseIsoDate(dateIso);
  if (!ts) return 0.8;
  const now = Date.now();
  const days = Math.max(0, (now - ts) / (1000 * 60 * 60 * 24));
  return Math.exp((-Math.log(2) * days) / cfg.halfLifeDays);
}

function reinforcementFactor(count?: number): number {
  const c = Math.max(1, Math.floor(Number(count) || 1));
  return 1 + Math.log1p(c - 1) * 0.25;
}

// ── Collision deduplication helpers ──────────────────────────────────────────
// When many near-identical facts (e.g. successive test-run tokens) exist in the
// atomic store, BM25+salience scores tie completely. The top-N slice then returns
// an arbitrary subset, often missing the newest entry.  Grouping by a stripped
// subject key and keeping only the newest per group before slicing fixes this.

const ATOMIC_IDENTIFIER_RE = /\b[A-Z0-9]+(?:-[A-Z0-9]+){2,}\b/g;
const ATOMIC_LONG_NUMBER_RE = /\b\d{8,}\b/g;

function atomicHasIdentifierToken(content: string): boolean {
  return ATOMIC_IDENTIFIER_RE.test(content);
}

function atomicCollisionSubjectKey(content: string): string {
  return content
    .replace(ATOMIC_IDENTIFIER_RE, " ")
    .replace(ATOMIC_LONG_NUMBER_RE, " ")
    .replace(/\b(?:updated|stored|saved|recorded|release|gate|token|exact|newest|latest|current|test)\b/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function computeSalienceScore(entry: MemoryEntry, lexicalScore = 0.5, decayCfg?: DecayConfig): number {
  const base = Math.max(0.05, Math.min(1, Number(entry.confidence) || 0.7));
  const lexical = Math.max(0, Math.min(1, lexicalScore));
  // MEMORY.md entries are evergreen — no temporal decay applied.
  const isEvergreen = entry.source === "MEMORY.md";
  const temporalAnchor =
    entry.type === "event"
      ? entry.happenedAt || entry.lastReinforcedAt || entry.updated || entry.created
      : entry.lastReinforcedAt || entry.updated || entry.created;
  const decay = isEvergreen ? 1 : recencyFactor(temporalAnchor, decayCfg);
  const reinforced = reinforcementFactor(entry.reinforcementCount);
  return (base * 0.7 + lexical * 0.3) * decay * reinforced;
}

function sanitizeFtsQuery(query: string): string {
  return query.replace(/["']/g, " ").trim();
}

function lexicalScoreFromBm25(raw: unknown): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0.5;
  return 1 / (1 + Math.abs(v));
}

function lexicalScoreFromText(content: string, query: string): number {
  const lower = content.toLowerCase();
  const phrase = query.toLowerCase().trim();
  if (!phrase) return 0;
  const tokens = phrase.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  let matched = 0;
  for (const token of tokens) {
    if (token && lower.includes(token)) matched += 1;
  }
  const tokenScore = matched / tokens.length;
  const phraseBonus = lower.includes(phrase) ? 0.3 : 0;
  return Math.max(0, Math.min(1, tokenScore + phraseBonus));
}

function sortByUpdatedDesc(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.sort((a, b) => {
    const aTs = parseIsoDate(a.updated) || parseIsoDate(a.created) || 0;
    const bTs = parseIsoDate(b.updated) || parseIsoDate(b.created) || 0;
    return bTs - aTs;
  });
}

function augmentMemoryTags(entry: MemoryEntry): string[] {
  const tags = new Set((entry.tags || []).map((tag) => String(tag).trim()).filter(Boolean));
  const content = String(entry.content || "");
  if (/\b(?:collision test|regression|synthetic memory|test seed)\b/i.test(content)) {
    tags.add("scope:test");
  }
  return Array.from(tags);
}

function augmentMemoryMetadata(entry: MemoryEntry): Record<string, unknown> | undefined {
  const base = entry.metadata ? { ...entry.metadata } : {};
  const tags = augmentMemoryTags(entry);
  const isTestScoped = tags.includes("scope:test");
  if (isTestScoped) {
    base.scope = "test";
    base.lane = "ephemeral_test";
    if (!base.suite) {
      const content = String(entry.content || "").toLowerCase();
      if (content.includes("collision")) base.suite = "memory-recall-collision";
      else if (content.includes("regression")) base.suite = "regression";
      else base.suite = "synthetic-test";
    }
    if (!base.expiresAt) {
      base.expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    }
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

export function computeAtomicContentHash(content: string, type: MemoryEntry["type"]): string {
  const normalized = normalizeMemoryContent(content);
  const payload = `${String(type || "fact").toLowerCase()}:${normalized}`;
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

export class SimpleMemoryProvider implements MemoryProvider {
  private memDir: string;
  readonly agentId: string;

  constructor(agentId = "default") {
    this.agentId = agentId;
    this.memDir = resolveAtomicMemoryDir(agentId);
    fs.mkdirSync(this.memDir, { recursive: true });
  }

  async store(entry: MemoryEntry): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const normalized: MemoryEntry = {
      ...entry,
      id: entry.id || `mem_${nanoid(8)}`,
      type: entry.type || "fact",
      content: String(entry.content || "").trim(),
      confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0.8,
      source: String(entry.source || "unknown"),
      tags: augmentMemoryTags({
        ...entry,
        tags: Array.isArray(entry.tags) ? entry.tags.map((t) => String(t).trim()).filter(Boolean) : [],
      } as MemoryEntry),
      created: entry.created || now,
      updated: now,
      contentHash: entry.contentHash || computeAtomicContentHash(String(entry.content || ""), entry.type || "fact"),
      reinforcementCount: Math.max(1, Math.floor(Number(entry.reinforcementCount) || 1)),
      lastReinforcedAt: entry.lastReinforcedAt || now,
      whenToUse: entry.whenToUse,
      happenedAt: entry.happenedAt,
      metadata: augmentMemoryMetadata(entry),
    };

    const duplicate = await this.findByContentHash(normalized.contentHash || "", normalized.type, normalized.id);
    if (duplicate) {
      const merged: MemoryEntry = {
        ...duplicate,
        confidence: Math.max(Number(duplicate.confidence) || 0.7, normalized.confidence),
        tags: Array.from(new Set([...(duplicate.tags || []), ...(normalized.tags || [])])),
        updated: now,
        reinforcementCount: Math.max(1, Math.floor(Number(duplicate.reinforcementCount) || 1) + 1),
        lastReinforcedAt: now,
        source: duplicate.source || normalized.source,
        happenedAt: duplicate.happenedAt || normalized.happenedAt,
      };
      merged.metadata = augmentMemoryMetadata(merged);
      return this.writeEntry(merged);
    }

    return this.writeEntry(normalized);
  }

  async search(query: string, limit = 10): Promise<MemoryEntry[]> {
    if (!query.trim()) {
      return [];
    }

    const targetLimit = Math.max(1, limit);
    const scored: Array<{ entry: MemoryEntry; score: number }> = [];
    const seen = new Set<string>();
    // Load decay config once per search to avoid per-entry DB calls.
    const decayCfg = loadDecayConfig();

    try {
      const db = getSqlite();
      const rows = db
        .prepare("SELECT id, bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?")
        .all(sanitizeFtsQuery(query), targetLimit * 4) as Array<{ id: string; rank?: number }>;

      for (const row of rows) {
        if (readAtomicScopeAgent(row.id) !== this.agentId) continue;
        const entry = this.readFile(row.id);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        const lexical = lexicalScoreFromBm25(row.rank);
        scored.push({ entry, score: computeSalienceScore(entry, lexical, decayCfg) });
      }
    } catch {
      // Fall back below.
    }

    // Fallback/augment with file scan.
    const all = await this.getAll();
    for (const entry of all) {
      if (seen.has(entry.id)) continue;
      const lexical = lexicalScoreFromText(entry.content, query);
      if (lexical <= 0) continue;
      scored.push({ entry, score: computeSalienceScore(entry, lexical, decayCfg) });
    }

    // Collision deduplication: group entries with identifier tokens by stripped
    // subject key and keep only the newest from each group.  Without this, 30+
    // near-identical-scoring entries from prior runs swamp the top-N slice so
    // the current run's newly-stored entry never makes it into search results.
    if (scored.length >= 2) {
      const identifierBuckets = new Map<string, Array<{ entry: MemoryEntry; score: number }>>();
      const plain: Array<{ entry: MemoryEntry; score: number }> = [];
      for (const item of scored) {
        ATOMIC_IDENTIFIER_RE.lastIndex = 0; // reset stateful regex
        if (!atomicHasIdentifierToken(item.entry.content)) {
          plain.push(item);
          continue;
        }
        const key = atomicCollisionSubjectKey(item.entry.content);
        if (!key || key.replace(/\s/g, "").length < 3) {
          plain.push(item);
          continue;
        }
        const bucket = identifierBuckets.get(key);
        if (bucket) bucket.push(item);
        else identifierBuckets.set(key, [item]);
      }
      if (identifierBuckets.size > 0) {
        const winners: Array<{ entry: MemoryEntry; score: number }> = [];
        for (const bucket of identifierBuckets.values()) {
          if (bucket.length === 1) {
            winners.push(bucket[0]!);
          } else {
            // Keep only the entry with the most recent timestamp.
            const newest = bucket.reduce((best, item) => {
              const bTs = parseIsoDate(best.entry.lastReinforcedAt) || parseIsoDate(best.entry.updated) || 0;
              const iTs = parseIsoDate(item.entry.lastReinforcedAt) || parseIsoDate(item.entry.updated) || 0;
              return iTs > bTs ? item : best;
            });
            winners.push(newest);
          }
        }
        scored.length = 0;
        scored.push(...winners, ...plain);
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, targetLimit)
      .map((item) => item.entry);
  }

  async getAll(): Promise<MemoryEntry[]> {
    if (!fs.existsSync(this.memDir)) return [];
    const files = fs.readdirSync(this.memDir).filter((f) => f.endsWith(".md"));
    const entries = files
      .map((f) => this.readFile(f.replace(".md", "")))
      .filter((m): m is MemoryEntry => m !== null);
    return sortByUpdatedDesc(entries);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.readFile(id);
  }

  async update(id: string, content: string): Promise<void> {
    const existing = this.readFile(id);
    if (!existing) return;

    const now = new Date().toISOString();
    const updated: MemoryEntry = {
      ...existing,
      content: String(content).trim(),
      updated: now,
      lastReinforcedAt: now,
      contentHash: computeAtomicContentHash(String(content), existing.type),
      happenedAt: existing.happenedAt,
    };

    const duplicate = await this.findByContentHash(updated.contentHash || "", updated.type, updated.id);
    if (duplicate) {
      const merged: MemoryEntry = {
        ...duplicate,
        confidence: Math.max(Number(duplicate.confidence) || 0.7, Number(updated.confidence) || 0.7),
        tags: Array.from(new Set([...(duplicate.tags || []), ...(updated.tags || [])])),
        reinforcementCount:
          Math.max(1, Math.floor(Number(duplicate.reinforcementCount) || 1)) +
          Math.max(1, Math.floor(Number(updated.reinforcementCount) || 1)),
        lastReinforcedAt: now,
        updated: now,
        happenedAt: duplicate.happenedAt || updated.happenedAt,
      };
      this.writeEntry(merged);
      this.removeById(id);
      return;
    }

    this.writeEntry(updated);
  }

  async delete(id: string): Promise<void> {
    this.removeById(id);
  }

  async extract(_messages: Message[]): Promise<MemoryEntry[]> {
    // Simple tier: no auto-extraction
    return [];
  }

  async compress(_messages: Message[]): Promise<string | null> {
    // Simple tier: no compression
    return null;
  }

  async getStats(): Promise<MemoryStats> {
    const files = fs.existsSync(this.memDir)
      ? fs.readdirSync(this.memDir).filter((f) => f.endsWith(".md"))
      : [];

    let totalBytes = 0;
    for (const f of files) {
      const stat = fs.statSync(path.join(this.memDir, f));
      totalBytes += stat.size;
    }

    return {
      totalMemories: files.length,
      storageBytes: totalBytes,
      tier: "unified",
      currentMode: "unified",
      autoThreshold: 50,
      embeddingModel: null,
      vectorIndexed: 0,
      sessionChunks: 0,
    };
  }

  private removeById(id: string): void {
    const filePath = path.join(this.memDir, `${id}.md`);
    const existing = this.readFile(id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    try {
      const db = getSqlite();
      db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
      db.prepare("DELETE FROM memory_atomic_scope WHERE id = ?").run(id);
    } catch {
      // FTS may not be available
    }
    if (existing) {
      markIdentifierObservationsDeleted({
        agentId: this.agentId,
        memoryEntryId: existing.id,
        sourcePath: filePath,
      });
    }
  }

  private writeEntry(entry: MemoryEntry): MemoryEntry {
    const normalized: MemoryEntry = {
      ...entry,
      id: entry.id || `mem_${nanoid(8)}`,
      type: entry.type || "fact",
      content: String(entry.content || "").trim(),
      confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0.8,
      source: String(entry.source || "unknown"),
      tags: Array.isArray(entry.tags) ? entry.tags.map((t) => String(t).trim()).filter(Boolean) : [],
      created: entry.created || new Date().toISOString(),
      updated: entry.updated || new Date().toISOString(),
      contentHash: entry.contentHash || computeAtomicContentHash(String(entry.content || ""), entry.type || "fact"),
      reinforcementCount: Math.max(1, Math.floor(Number(entry.reinforcementCount) || 1)),
      lastReinforcedAt: entry.lastReinforcedAt || entry.updated || entry.created || new Date().toISOString(),
      whenToUse: entry.whenToUse,
      happenedAt: entry.happenedAt,
      metadata: entry.metadata,
    };

    const filePath = path.join(this.memDir, `${normalized.id}.md`);
    const content = [
      "---",
      `id: ${normalized.id}`,
      `type: ${normalized.type}`,
      `confidence: ${normalized.confidence}`,
      `source: ${normalized.source}`,
      `tags: [${normalized.tags.join(", ")}]`,
      `created: ${normalized.created}`,
      `updated: ${normalized.updated}`,
      `content_hash: ${normalized.contentHash}`,
      `reinforcement_count: ${normalized.reinforcementCount}`,
      `last_reinforced_at: ${normalized.lastReinforcedAt}`,
      `when_to_use: ${normalized.whenToUse ? JSON.stringify(String(normalized.whenToUse)) : "\"\""}`,
      `happened_at: ${normalized.happenedAt ? JSON.stringify(String(normalized.happenedAt)) : "\"\""}`,
      `metadata: ${normalized.metadata ? JSON.stringify(normalized.metadata) : "{}"}`,
      "---",
      normalized.content,
    ].join("\n");

    fs.writeFileSync(filePath, content, "utf-8");

    // Index in FTS5
    try {
      const db = getSqlite();
      db.prepare(
        "INSERT OR REPLACE INTO memories_fts (id, content, tags, type) VALUES (?, ?, ?, ?)"
      ).run(normalized.id, normalized.content, normalized.tags.join(", "), normalized.type);
      db.prepare(
        "INSERT OR REPLACE INTO memory_atomic_scope (id, agent_id, updated_at) VALUES (?, ?, ?)"
      ).run(normalized.id, this.agentId, normalized.updated);
    } catch {
      // FTS may not be available
    }

    recordIdentifierObservation({
      agentId: this.agentId,
      content: normalized.content,
      sessionId: typeof normalized.metadata?.sessionId === "string" ? String(normalized.metadata.sessionId) : null,
      sourcePath: filePath,
      memoryEntryId: normalized.id,
      createdAt: normalized.created,
      updatedAt: normalized.updated,
      metadata: normalized.metadata,
    });

    return normalized;
  }

  private async findByContentHash(
    contentHash: string,
    type: MemoryEntry["type"],
    excludeId?: string,
  ): Promise<MemoryEntry | null> {
    if (!contentHash) return null;
    const all = await this.getAll();
    for (const entry of all) {
      if (excludeId && entry.id === excludeId) continue;
      const entryHash = entry.contentHash || computeAtomicContentHash(entry.content, entry.type);
      if (entryHash === contentHash && entry.type === type) {
        return entry;
      }
    }
    return null;
  }

  private readFile(id: string): MemoryEntry | null {
    const filePath = path.join(this.memDir, `${id}.md`);
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, "utf-8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatter = match[1];
    const body = match[2].trim();
    const meta: Record<string, unknown> = {};

    for (const line of frontmatter.split("\n")) {
      const colonIdx = line.indexOf(": ");
      if (colonIdx === -1) continue;
      const key = line.substring(0, colonIdx);
      const value = line.substring(colonIdx + 2).trim();

      if (key === "tags") {
        meta[key] = value.replace(/[\[\]]/g, "").split(",").map((t) => t.trim()).filter(Boolean);
      } else if (key === "confidence") {
        meta[key] = parseFloat(value);
      } else if (key === "reinforcement_count") {
        meta[key] = parseInt(value, 10);
      } else if (key === "when_to_use") {
        try {
          meta[key] = JSON.parse(value);
        } catch {
          meta[key] = value;
        }
      } else if (key === "happened_at") {
        try {
          meta[key] = JSON.parse(value);
        } catch {
          meta[key] = value;
        }
      } else if (key === "metadata") {
        try {
          meta[key] = JSON.parse(value);
        } catch {
          meta[key] = {};
        }
      } else {
        meta[key] = value;
      }
    }

    return {
      id: (meta.id as string) || id,
      type: (meta.type as MemoryEntry["type"]) || "fact",
      content: body,
      confidence: Number.isFinite(Number(meta.confidence)) ? Number(meta.confidence) : 0.8,
      source: (meta.source as string) || "unknown",
      tags: (meta.tags as string[]) || [],
      created: (meta.created as string) || new Date().toISOString(),
      updated: (meta.updated as string) || new Date().toISOString(),
      contentHash:
        (meta.content_hash as string) ||
        computeAtomicContentHash(body, (meta.type as MemoryEntry["type"]) || "fact"),
      reinforcementCount: Number.isFinite(Number(meta.reinforcement_count))
        ? Number(meta.reinforcement_count)
        : 1,
      lastReinforcedAt: (meta.last_reinforced_at as string) || (meta.updated as string) || (meta.created as string),
      whenToUse:
        typeof meta.when_to_use === "string" && meta.when_to_use.trim()
          ? (meta.when_to_use as string)
          : undefined,
      happenedAt:
        typeof meta.happened_at === "string" && meta.happened_at.trim()
          ? (meta.happened_at as string)
          : undefined,
      metadata: typeof meta.metadata === "object" && meta.metadata !== null
        ? (meta.metadata as Record<string, unknown>)
        : undefined,
    };
  }
}
