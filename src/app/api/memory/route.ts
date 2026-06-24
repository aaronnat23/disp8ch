import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import path from "node:path";
import fs from "node:fs";
import { callModel } from "@/lib/agents/multi-provider";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { resolveMemoryScope } from "@/lib/memory/scope-resolver";
import { createMemoryProvider } from "@/lib/memory/provider";
import { applyMemoryOperations, MemoryBatchValidationError, type MemoryOperation } from "@/lib/memory/atomic-operations";
import { buildSearchVisibility, buildWriteVisibility, normalizeMemoryAccess } from "@/lib/memory/workflow-scope";
import { resolveAtomicVisibility } from "@/lib/memory/visibility-filter";
import { getMemorySearchManager } from "@/lib/memory/manager";
import type { MemoryEntry } from "@/types/memory";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import { resolveModelApiKey } from "@/lib/agents/provider-auth";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";
import {
  appendDailyMemoryNote,
  appendMainMemoryNote,
  ensureWorkspaceScaffold,
  getStartupFileHygieneReport,
  getWorkspaceDir,
  listWorkspaceMemoryFiles,
  markMainMemoryEntryDeleted,
  readWorkspaceMemorySlice,
  resolveWorkspaceMemoryReadPath,
  searchWorkspaceMemories,
} from "@/lib/workspace/files";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { runHooks } from "@/lib/hooks";
import {
  getEmbeddingModel,
  getConfiguredEmbeddingModelId,
  getOrGenerateEmbedding,
  countEmbeddings,
  generateEmbedding,
  generateEmbeddingsBatch,
  storeEmbedding,
} from "@/lib/memory/embedding-provider";
import { indexMemoryEmbedding } from "@/lib/memory/hybrid-search";
import {
  getSessionChunkCount,
  getSessionIndexStateSummary,
  loadSessionChunkConfig,
  searchSessionChunks,
} from "@/lib/memory/session-indexer";
import {
  searchCollectionChunks,
  getCollectionChunkCount,
} from "@/lib/memory/collection-indexer";
import { deletePathContext, listPathContexts, upsertPathContext } from "@/lib/memory/path-contexts";
import { getSqliteVecStatus, isSqliteVecReady } from "@/lib/memory/sqlite-vec";
import { computeAtomicContentHash, resolveAtomicMemoryDir } from "@/lib/memory/simple";
import { buildMemoryRollups } from "@/lib/memory/rollups";
import { getMemoryCoreStatus } from "@/lib/memory/core";
import {
  clearStagedMemoryPromotionEvents,
  listMemoryPromotionEvents,
  recordMemoryPromotionEvent,
} from "@/lib/memory/promotion-events";
import { requireOperatorAccess } from "@/lib/security/admin";

type SearchMode = "search" | "gpt";
type ExtractMode = "manual" | "auto";

type SearchResult = {
  id?: string;
  path: string;
  type?: string;
  content: string;
  score: number;
  source: "atomic" | "workspace" | "session" | "collection";
  confidence?: number;
  reinforcementCount?: number;
  lastReinforcedAt?: string;
  startLine?: number;
  endLine?: number;
  contextText?: string;
};

type SearchDiagnostics = {
  query: string;
  strongSignal: boolean;
  rewrittenQuery?: string | null;
  expandedQueries: string[];
  candidateCount: number;
  sourceCounts: Record<string, number>;
  vectorBackend: {
    kind: "sqlite-vec" | "json-cosine-fallback";
    available: boolean;
    loaded: boolean;
    dimensions: number | null;
    error: string | null;
  };
  providerPlan?: {
    configured: string;
    mode: "hybrid" | "fts5-only";
    actualMode: "hybrid" | "fts5-only";
    active: { provider: string; modelId: string } | null;
    candidates: Array<{ provider: string; modelId: string; source: string }>;
    selected: { provider: string; modelId: string; source: string } | null;
    fallbackCount: number;
    unavailableReason: string | null;
  };
  searchPolicy?: {
    backend: "builtin" | "qmd-like";
    rerankStrategy: "auto" | "mmr" | "local" | "model" | "off";
    queryExpansionEnabled: boolean;
    strongSignalEnabled: boolean;
    rerankCandidateLimit: number;
  };
  rerankStrategy?: "mmr" | "local" | "model" | "off";
  rerankModel?: { provider: string; modelId: string } | null;
  queryEmbeddingProvider?: string | null;
  agentId: string;
  memoryAgentId?: string;
  workspacePath: string;
  timingsMs?: {
    embed: number;
    primarySearch: number;
    queryExpansion: number;
    rerank: number;
    total: number;
  };
  explain?: {
    searchBackend: "builtin" | "qmd-like";
    fusedListCount: number;
    preFilterCandidates: number;
    postFilterCandidates: number;
    rrfK: number;
    chunkedRerank: boolean;
    positionAwareBlend: boolean;
    rerankCandidateLimit: number;
    backendDefaultRerank: "mmr" | "local" | "model" | "off";
    autoResolvedStrategy: "mmr" | "local" | "model" | "off";
    expansionSkipped: boolean;
  };
  runtime?: unknown;
};

type DailyJournalItem = {
  path: string;
  date: string;
  bytes: number;
  words: number;
  entries: number;
  updatedAtMs: number;
  preview: string;
};

type SessionRecallMatch = {
  score: number;
  chunkIndex: number;
  preview: string;
};

type SessionRecallSession = {
  sessionId: string;
  score: number;
  matchCount: number;
  messageCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  participants: string[];
  summary: string;
  summaryMode: "llm" | "extractive";
  matches: SessionRecallMatch[];
};

function getProvider(agentId = "default") {
  return createMemoryProvider(undefined, agentId);
}

// Shared scope resolver (also used by the visual memory nodes) lives in
// scope-resolver.ts so writes and searches use the same agent key.


function collapseWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value: string, maxChars = 180): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildSessionRecallPreview(chunkText: string, query: string): string {
  const collapsed = collapseWhitespace(chunkText);
  if (!collapsed) return "";

  const queryTerms = Array.from(
    new Set(
      collapseWhitespace(query)
        .toLowerCase()
        .split(/\s+/)
        .map((term) => term.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ""))
        .filter((term) => term.length >= 4),
    ),
  );

  let start = 0;
  const lowered = collapsed.toLowerCase();
  for (const term of queryTerms) {
    const index = lowered.indexOf(term);
    if (index >= 0) {
      start = Math.max(0, index - 80);
      break;
    }
  }

  const end = Math.min(collapsed.length, start + 220);
  const snippet = collapsed.slice(start, end).trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < collapsed.length ? "…" : "";
  return `${prefix}${snippet}${suffix}`;
}

function extractRecallTerms(query: string): string[] {
  return Array.from(
    new Set(
      collapseWhitespace(query)
        .toLowerCase()
        .split(/\s+/)
        .map((term) => term.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ""))
        .filter((term) => term.length >= 3),
    ),
  );
}

function countRecallTermCoverage(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lowered = collapseWhitespace(text).toLowerCase();
  let covered = 0;
  for (const term of terms) {
    if (lowered.includes(term)) {
      covered += 1;
    }
  }
  return covered;
}

function appendSessionRecallMatch(
  entry: {
    sessionId: string;
    score: number;
    matchCount: number;
    exactQueryMatch: boolean;
    termCoverage: number;
    matches: SessionRecallMatch[];
  },
  match: SessionRecallMatch,
): void {
  if (!match.preview) return;
  if (entry.matches.some((existing) => existing.preview === match.preview)) return;
  entry.matches.push(match);
  entry.matches.sort((left, right) => right.score - left.score);
  entry.matches = entry.matches.slice(0, 3);
}

function searchSessionMessagesLexical(params: {
  agentId: string;
  query: string;
  limit: number;
}): Array<{ sessionId: string; preview: string; score: number }> {
  const query = collapseWhitespace(params.query);
  if (!query) return [];
  const db = getSqlite();
  const lowered = query.toLowerCase();
  try {
    const rows = db
      .prepare(
        `
          SELECT session_id, content
          FROM messages
          WHERE agent_id = ?
            AND content IS NOT NULL
            AND lower(content) LIKE ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(params.agentId, `%${lowered}%`, Math.max(params.limit * 6, 12)) as Array<{
      session_id: string;
      content: string | null;
    }>;

    const out: Array<{ sessionId: string; preview: string; score: number }> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const sessionId = String(row.session_id || "").trim();
      const preview = buildSessionRecallPreview(String(row.content || ""), query);
      if (!sessionId || !preview) continue;
      const key = `${sessionId}:${preview}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        sessionId,
        preview,
        score: 1.1,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function serializeVectorBackendStatus() {
  const status = getSqliteVecStatus();
  return {
    kind: status.available ? "sqlite-vec" as const : "json-cosine-fallback" as const,
    available: status.available,
    loaded: status.loaded,
    dimensions: status.dimensions,
    error: status.error,
  };
}

// ── Display config cache ──────────────────────────────────────────────────────

let displayConfigCache: { maxSnippetChars: number; maxInjectedChars: number; citationsMode: string } | null = null;
let displayConfigCacheAt = 0;
const DISPLAY_CONFIG_TTL_MS = 60_000;

function loadMemoryDisplayConfig() {
  const now = Date.now();
  if (displayConfigCache && now - displayConfigCacheAt < DISPLAY_CONFIG_TTL_MS) {
    return displayConfigCache;
  }
  try {
    const db = getSqlite();
    const row = db
      .prepare("SELECT max_snippet_chars, max_injected_chars, citations_mode FROM memory_config WHERE id = 'default'")
      .get() as { max_snippet_chars?: number; max_injected_chars?: number; citations_mode?: string } | undefined;
    displayConfigCache = {
      maxSnippetChars: row?.max_snippet_chars ?? 700,
      maxInjectedChars: row?.max_injected_chars ?? 4000,
      citationsMode: row?.citations_mode ?? "on",
    };
    displayConfigCacheAt = now;
  } catch {
    displayConfigCache = { maxSnippetChars: 700, maxInjectedChars: 4000, citationsMode: "on" };
    displayConfigCacheAt = now;
  }
  return displayConfigCache;
}

// ── Source diversification ────────────────────────────────────────────────────

function diversifyBySource(results: SearchResult[], limit: number): SearchResult[] {
  if (results.length <= limit) return results;

  const groups = new Map<string, SearchResult[]>();
  for (const r of results) {
    const bucket = groups.get(r.source) ?? [];
    bucket.push(r);
    groups.set(r.source, bucket);
  }
  // Each group is already sorted by score (results came in sorted).
  const indices = new Map<string, number>();
  for (const key of groups.keys()) indices.set(key, 0);
  const preferredOrder = ["atomic", "workspace", "collection", "session"];
  const orderedSources = [
    ...preferredOrder.filter((source) => groups.has(source)),
    ...Array.from(groups.keys()).filter((source) => !preferredOrder.includes(source)),
  ];

  const interleaved: SearchResult[] = [];
  while (interleaved.length < limit) {
    let added = false;
    for (const source of orderedSources) {
      const items = groups.get(source);
      if (!items) continue;
      const idx = indices.get(source) ?? 0;
      if (idx < items.length) {
        interleaved.push(items[idx]);
        indices.set(source, idx + 1);
        added = true;
        if (interleaved.length >= limit) break;
      }
    }
    if (!added) break;
  }
  return interleaved;
}

// ── Injected char budget ──────────────────────────────────────────────────────

function clampByInjectedChars(results: SearchResult[], budget: number): SearchResult[] {
  const out: SearchResult[] = [];
  let remaining = budget;
  for (const r of results) {
    const len = r.content.length;
    if (len <= remaining) {
      out.push(r);
      remaining -= len;
    } else if (remaining > 0) {
      out.push({ ...r, content: r.content.slice(0, remaining) });
      remaining = 0;
      break;
    } else {
      break;
    }
  }
  return out;
}

function buildSessionScopeRuntime<T extends {
  runtime?: {
    sessions?: {
      pending?: string[];
      warmCount?: number;
      trackedCount?: number;
      lastIndexedAt?: string | null;
    };
  };
  sessionChunks?: number;
}>(payload: T, sessionAgentId: string, sessionChunks: number): T {
  const sessionState = getSessionIndexStateSummary(sessionAgentId);
  return {
    ...payload,
    sessionChunks,
    runtime: payload.runtime
      ? {
          ...payload.runtime,
          sessions: payload.runtime.sessions
            ? {
                ...payload.runtime.sessions,
                trackedCount: sessionState.trackedSessions,
                lastIndexedAt: sessionState.lastIndexedAt,
              }
            : {
                pending: [],
                warmCount: 0,
                trackedCount: sessionState.trackedSessions,
                lastIndexedAt: sessionState.lastIndexedAt,
              },
        }
      : payload.runtime,
  };
}

// ── Legacy atomic path resolver ───────────────────────────────────────────────

function resolveLegacyAtomicReadPath(rawPath: string): string | null {
  const relPath = rawPath.trim().replace(/^[/\\]+/, "").replace(/\\/g, "/");
  if (!/^mem_[A-Za-z0-9_-]+\.md$/i.test(relPath)) {
    return null;
  }

  const memDir = resolveAtomicMemoryDir("default");
  const absPath = path.resolve(memDir, relPath);
  const normalized = memDir + path.sep;
  if (absPath !== memDir && !absPath.startsWith(normalized)) return null;
  return absPath;
}

function readLegacyAtomicSlice(params: { relPath: string; from?: number; lines?: number }) {
  const absPath = resolveLegacyAtomicReadPath(params.relPath);
  if (!absPath) {
    throw new Error("Invalid memory path.");
  }
  if (!fs.existsSync(absPath)) {
    return { path: params.relPath, text: "" };
  }
  const raw = fs.readFileSync(absPath, "utf-8");

  // Parse frontmatter and body — return a clean human-readable view instead of raw YAML.
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  let text: string;
  if (fmMatch) {
    const fm = fmMatch[1];
    const body = fmMatch[2].trim();
    const meta: Record<string, string> = {};
    for (const line of fm.split("\n")) {
      const idx = line.indexOf(": ");
      if (idx !== -1) meta[line.slice(0, idx)] = line.slice(idx + 2).trim();
    }
    const lines: string[] = [
      `id: ${meta.id ?? "?"}`,
      `type: ${meta.type ?? "?"}  confidence: ${meta.confidence ?? "?"}  reinforced: ${meta.reinforcement_count ?? 1}x`,
      `tags: ${meta.tags ?? ""}`,
      `updated: ${meta.updated ?? meta.created ?? "?"}`,
      `when_to_use: ${meta.when_to_use ?? ""}`,
      `---`,
      body,
    ];
    text = lines.join("\n");
  } else {
    text = raw;
  }

  const from = Number.isFinite(params.from) ? Math.max(1, Math.floor(params.from as number)) : undefined;
  const lineCount = Number.isFinite(params.lines) ? Math.max(1, Math.floor(params.lines as number)) : undefined;
  if (!from && !lineCount) {
    return { path: params.relPath, text };
  }
  const split = text.split("\n");
  const start = from ?? 1;
  const count = lineCount ?? split.length;
  return { path: params.relPath, text: split.slice(start - 1, start - 1 + count).join("\n"), from: start, lines: count };
}

function scoreAtomicEntry(entry: MemoryEntry): number {
  const created = new Date(entry.lastReinforcedAt || entry.created).getTime();
  const now = Date.now();
  const daysSince = Number.isFinite(created) ? Math.max(0, (now - created) / (1000 * 60 * 60 * 24)) : 0;
  const recency = Math.exp((-Math.log(2) * daysSince) / 30);
  const reinforced = 1 + Math.log1p(Math.max(1, Number(entry.reinforcementCount) || 1) - 1) * 0.25;
  return (entry.confidence || 0.7) * recency * reinforced;
}

function prepareSearchResults(options: {
  atomic: MemoryEntry[];
  workspace: ReturnType<typeof searchWorkspaceMemories>;
  sessions?: Awaited<ReturnType<typeof searchSessionChunks>>;
  collections?: Awaited<ReturnType<typeof searchCollectionChunks>>;
}): SearchResult[] {
  const byKey = new Map<string, SearchResult>();

  for (const entry of options.atomic) {
    const result: SearchResult = {
      id: entry.id,
      path: `${entry.id}.md`,
      type: entry.type,
      content: entry.content,
      confidence: entry.confidence,
      reinforcementCount: entry.reinforcementCount,
      lastReinforcedAt: entry.lastReinforcedAt,
      score: scoreAtomicEntry(entry),
      source: "atomic",
    };
    byKey.set(`atomic:${entry.id}`, result);
  }

  for (const item of options.workspace) {
    const result: SearchResult = {
      path: item.path,
      content: item.content,
      score: item.score + (item.path === "MEMORY.md" ? 0.3 : 0),
      source: "workspace",
      startLine: item.startLine,
      endLine: item.endLine,
    };
    byKey.set(`workspace:${item.path}:${item.startLine}`, result);
  }

  for (const item of options.sessions ?? []) {
    const result: SearchResult = {
      path: `session:${item.sessionId}#chunk-${item.chunkIndex + 1}`,
      content: item.chunkText,
      score: item.score ?? 0.5,
      source: "session",
    };
    byKey.set(`session:${item.id}`, result);
  }

  for (const item of options.collections ?? []) {
    const normalizedPath = item.filePath.replace(/\\/g, "/");
    const isDailyJournal = /(^|\/)memory\/\d{4}-\d{2}-\d{2}\.md$/i.test(normalizedPath);
    if (isDailyJournal) {
      continue;
    }
    const result: SearchResult = {
      path: item.filePath,
      content: item.chunkText,
      score: item.score ?? 0.5,
      source: "collection",
      contextText: item.contextText,
    };
    byKey.set(`collection:${item.id}`, result);
  }

  return Array.from(byKey.values()).sort((a, b) => b.score - a.score);
}

function detectSearchMode(raw: string | null): SearchMode {
  return raw?.toLowerCase() === "gpt" ? "gpt" : "search";
}

function trimForToolView(results: SearchResult[], limit: number): SearchResult[] {
  return results.slice(0, Math.max(1, limit)).map((item) => ({
    ...item,
    content: item.content.slice(0, 1200),
  }));
}

function reciprocalRankFusion(lists: SearchResult[][], limit: number, k = 60): SearchResult[] {
  const merged = new Map<string, SearchResult & { fusedScore: number }>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const key = `${item.source}:${item.path}:${item.content.slice(0, 120)}`;
      const contribution = 1 / (k + index + 1);
      const existing = merged.get(key);
      if (existing) {
        existing.fusedScore += contribution;
        existing.score = Math.max(existing.score, item.score);
      } else {
        merged.set(key, { ...item, fusedScore: contribution });
      }
    });
  }
  return Array.from(merged.values())
    .sort((a, b) => {
      if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore;
      return b.score - a.score;
    })
    .slice(0, limit)
    .map(({ fusedScore: _fusedScore, ...item }) => item);
}

function readDailyJournalItems(scope?: { workspacePath: string }): DailyJournalItem[] {
  const workspaceDir = getWorkspaceDir(scope);
  const files = listWorkspaceMemoryFiles(scope)
    .map((absPath) => path.relative(workspaceDir, absPath).replace(/\\/g, "/"))
    .filter((relPath) => /^memory\/\d{4}-\d{2}-\d{2}\.md$/i.test(relPath))
    .sort()
    .reverse();

  const out: DailyJournalItem[] = [];
  for (const relPath of files) {
    const absPath = resolveWorkspaceMemoryReadPath(relPath, scope);
    if (!absPath || !fs.existsSync(absPath)) continue;
    const content = fs.readFileSync(absPath, "utf-8");
    const stats = fs.statSync(absPath);
    const lines = content.split("\n");
    const entries = lines.filter((line) => line.trim().startsWith("- ")).length;
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    const preview = lines
      .filter((line) => {
        const trimmed = line.trim();
        return Boolean(trimmed) && !trimmed.startsWith("#");
      })
      .slice(0, 4)
      .join("\n");

    out.push({
      path: relPath,
      date: path.basename(relPath, ".md"),
      bytes: stats.size,
      words,
      entries,
      updatedAtMs: stats.mtimeMs,
      preview,
    });
  }
  return out;
}

type BackfillCandidate = {
  sourcePath: string;
  journalDate: string;
  lineNumber: number;
  content: string;
  type: MemoryEntry["type"];
  tags: string[];
};

function inferBackfillType(content: string): MemoryEntry["type"] {
  const lowered = content.toLowerCase();
  if (lowered.includes("prefer") || lowered.includes("likes ") || lowered.includes("dislikes ")) return "preference";
  if (lowered.includes("decided") || lowered.startsWith("decision:")) return "decision";
  if (lowered.includes("tool:") || lowered.includes("uses ")) return "tool";
  if (lowered.includes("skill:") || lowered.includes("capable of")) return "skill";
  if (lowered.includes("met ") || lowered.includes("person ") || lowered.includes("agent ")) return "entity";
  if (lowered.includes("because ") || lowered.includes("learned ")) return "knowledge";
  return "observation";
}

function extractBackfillCandidates(scope: { workspacePath: string }, limit = 80): BackfillCandidate[] {
  const journals = readDailyJournalItems(scope).slice(0, 14);
  const candidates: BackfillCandidate[] = [];

  for (const journal of journals) {
    const absPath = resolveWorkspaceMemoryReadPath(journal.path, scope);
    if (!absPath || !fs.existsSync(absPath)) continue;
    const lines = fs.readFileSync(absPath, "utf-8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index] || "";
      const trimmed = raw.trim();
      if (!trimmed.startsWith("- ")) continue;
      const body = trimmed
        .replace(/^- /, "")
        .replace(/^\d{4}-\d{2}-\d{2}T[^:]+:\s*/, "")
        .trim();
      if (!body || body.startsWith("[delete]")) continue;
      const content = body
        .replace(/^\[(?:fact|preference|entity|decision|correction|relationship|skill|observation|profile|event|knowledge|behavior|tool|update)\]\s*/i, "")
        .replace(/^id=[^\s]+\s*/i, "")
        .trim();
      if (!content || content.length < 24) continue;
      candidates.push({
        sourcePath: journal.path,
        journalDate: journal.date,
        lineNumber: index + 1,
        content,
        type: inferBackfillType(content),
        tags: ["backfill", "journal"],
      });
      if (candidates.length >= limit) return candidates;
    }
  }

  return candidates;
}

// Jaccard token similarity between two content strings.
function tokenSimilarity(a: string, b: string): number {
  const tokA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  let intersection = 0;
  for (const t of tokA) { if (tokB.has(t)) intersection++; }
  const union = tokA.size + tokB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Maximal Marginal Relevance: picks diverse top-N from candidates (λ=0.6).
function mmrRerank(candidates: SearchResult[], limit: number, lambda = 0.6): SearchResult[] {
  if (candidates.length <= limit) return candidates;
  const selected: SearchResult[] = [];
  const remaining = [...candidates];

  while (selected.length < limit && remaining.length > 0) {
    let bestScore = -Infinity;
    let bestIdx = 0;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const relevance = cand.score;
      const maxSim = selected.length === 0
        ? 0
        : Math.max(...selected.map((s) => tokenSimilarity(cand.content, s.content)));
      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestScore) { bestScore = mmr; bestIdx = i; }
    }
    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  return selected;
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
      baseUrl: normalizeProviderBaseUrl(provider, (row.base_url as string | undefined) || undefined),
      fastMode: row.fast_mode === 1,
    };
  } catch {
    return null;
  }
}

function buildExtractiveSessionSummary(params: {
  matchCount: number;
  messageCount: number;
  participants: string[];
  matches: SessionRecallMatch[];
}): string {
  const lead = params.matches[0]?.preview
    ? `Top match: ${clipText(params.matches[0].preview, 120)}`
    : "Relevant transcript match found.";
  const participantText =
    params.participants.length > 0
      ? ` Participants: ${params.participants.slice(0, 3).join(", ")}.`
      : "";
  return `Matched ${params.matchCount} indexed transcript chunk${params.matchCount === 1 ? "" : "s"} across a ${params.messageCount}-message session. ${lead}.${participantText}`.trim();
}

async function summarizeSessionRecallWithModel(
  query: string,
  sessions: Array<{
    sessionId: string;
    messageCount: number;
    participants: string[];
    matches: SessionRecallMatch[];
    startedAt: string | null;
    updatedAt: string | null;
  }>,
): Promise<{
  provider: string;
  modelId: string;
  summaries: Map<string, string>;
} | null> {
  const model = loadActiveModel();
  if (!model || sessions.length === 0) return null;

  const payload = sessions.slice(0, 4).map((session) => ({
    sessionId: session.sessionId,
    messageCount: session.messageCount,
    participants: session.participants,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    matches: session.matches.slice(0, 3).map((match) => ({
      score: Number(match.score.toFixed(3)),
      preview: match.preview,
    })),
  }));

  try {
    const result = await callModel({
      provider: model.provider as Parameters<typeof callModel>[0]["provider"],
      modelId: model.modelId,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      fastMode: model.fastMode,
      enableSmartRouting: true,
      systemPrompt:
        "You summarize archived chat sessions for an operator. Return JSON only with " +
        "{\"summaries\":[{\"sessionId\":\"...\",\"summary\":\"...\"}]}. " +
        "Each summary must be 1-2 grounded sentences explaining why the session is relevant to the query. " +
        "Do not speculate beyond the provided excerpts.",
      userMessage: `Query: ${query}\n\nSessions:\n${JSON.stringify(payload, null, 2)}`,
      maxTokens: 500,
    });
    const jsonMatch = result.response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as {
      summaries?: Array<{ sessionId?: string; summary?: string }>;
    };
    if (!Array.isArray(parsed.summaries)) return null;

    const summaries = new Map<string, string>();
    for (const entry of parsed.summaries) {
      const sessionId = String(entry?.sessionId || "").trim();
      const summary = clipText(String(entry?.summary || ""), 220);
      if (!sessionId || !summary) continue;
      summaries.set(sessionId, summary);
    }
    if (summaries.size === 0) return null;
    return {
      provider: result.provider ?? model.provider,
      modelId: result.modelId ?? model.modelId,
      summaries,
    };
  } catch {
    return null;
  }
}

async function rerankWithModel(query: string, candidates: SearchResult[], limit: number): Promise<SearchResult[]> {
  if (candidates.length <= 1) return candidates.slice(0, limit);
  const model = loadActiveModel();
  if (!model) return candidates.slice(0, limit);

  const short = candidates.slice(0, Math.min(20, Math.max(limit * 3, 8)));
  const payload = short
    .map((c, i) => {
      const lines =
        c.startLine && c.endLine ? ` lines=${c.startLine}-${c.endLine}` : "";
      return `[${i}] path=${c.path}${lines}\n${c.content.slice(0, 500)}`;
    })
    .join("\n\n");

  try {
    const result = await callModel({
      provider: model.provider as Parameters<typeof callModel>[0]["provider"],
      modelId: model.modelId,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      fastMode: model.fastMode,
      systemPrompt:
        "You rank memory snippets for relevance. Return JSON only with {\"indexes\":[...]} where indexes are candidate IDs in best-first order.",
      userMessage:
        `Query: ${query}\n\nCandidates:\n${payload}\n\n` +
        `Return top ${limit} indexes only. JSON only.`,
      maxTokens: 300,
    });

    const jsonMatch = result.response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return short.slice(0, limit);
    const parsed = JSON.parse(jsonMatch[0]) as { indexes?: number[] };
    if (!Array.isArray(parsed.indexes)) return short.slice(0, limit);

    const picked: SearchResult[] = [];
    for (const idx of parsed.indexes) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= short.length) continue;
      const item = short[idx];
      if (!item) continue;
      if (picked.some((p) => p.path === item.path && p.content === item.content)) continue;
      picked.push(item);
      if (picked.length >= limit) break;
    }
    if (picked.length > 0) return picked;
    return short.slice(0, limit);
  } catch {
    return short.slice(0, limit);
  }
}

function parseListTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((tag) => String(tag).trim()).filter(Boolean);
}

function isDurableType(type: MemoryEntry["type"]): boolean {
  return (
    type === "fact" ||
    type === "preference" ||
    type === "entity" ||
    type === "decision" ||
    type === "skill" ||
    type === "relationship" ||
    type === "correction" ||
    type === "profile" ||
    type === "knowledge" ||
    type === "behavior" ||
    type === "tool"
  );
}

function normalizeExtractMode(raw: unknown): ExtractMode {
  const value = String(raw ?? "manual").toLowerCase();
  return value === "auto" ? "auto" : "manual";
}

function normalizeMessageList(value: unknown): Array<{ role: "user" | "assistant"; content: string }> {
  if (!Array.isArray(value)) return [];
  const output: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const roleRaw = String((item as Record<string, unknown>).role || "user").toLowerCase();
    const role = roleRaw === "assistant" ? "assistant" : "user";
    const content = String((item as Record<string, unknown>).content || "").trim();
    if (!content) continue;
    output.push({ role, content });
  }
  return output;
}

async function updateStoredStats() {
  const provider = getProvider();
  const stats = await provider.getStats();
  const db = getSqlite();
  db.prepare(
    "UPDATE memory_config SET total_memories = ?, storage_bytes = ?, updated_at = ? WHERE id = 'default'",
  ).run(stats.totalMemories, stats.storageBytes, new Date().toISOString());
  return stats;
}

async function getQueryEmbedding(query: string) {
  const modelId = getConfiguredEmbeddingModelId();
  if (modelId === "disabled") return null;
  const model = getEmbeddingModel(modelId === "auto" ? undefined : modelId);
  if (!model) return null;
  return generateEmbedding(query, model).catch(() => null);
}

async function expandQueryVariants(query: string): Promise<string[]> {
  const model = loadActiveModel();
  if (!model) return [];
  try {
    const result = await callModel({
      provider: model.provider as Parameters<typeof callModel>[0]["provider"],
      modelId: model.modelId,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      fastMode: model.fastMode,
      systemPrompt:
        "Generate up to 3 alternate search queries for memory retrieval. Return JSON only with {\"variants\":[\"...\"]}. Keep them short and concrete.",
      userMessage: `Original query: ${query}`,
      maxTokens: 200,
    });
    const match = result.response.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { variants?: string[] };
    if (!Array.isArray(parsed.variants)) return [];
    return parsed.variants
      .map((variant) => String(variant || "").trim())
      .filter((variant) => variant && variant.toLowerCase() !== query.toLowerCase())
      .slice(0, 3);
  } catch {
    return [];
  }
}

async function runUnifiedSearch(options: {
  query: string;
  candidateCount: number;
  provider: ReturnType<typeof getProvider>;
  agentId: string;
  workspacePath: string;
}): Promise<SearchResult[]> {
  const queryEmbedding = await getQueryEmbedding(options.query);
  const atomic = await options.provider.search(options.query, options.candidateCount);
  const workspace = searchWorkspaceMemories(options.query, options.candidateCount, { workspacePath: options.workspacePath });
  const sessions = await searchSessionChunks(options.query, queryEmbedding, options.candidateCount, options.agentId);
  const collections = await searchCollectionChunks(options.query, queryEmbedding, options.candidateCount, options.agentId);
  return prepareSearchResults({ atomic, workspace, sessions, collections });
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();

    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");
    const scope = resolveMemoryScope(searchParams.get("agentId"));
    ensureWorkspaceScaffold({ workspacePath: scope.workspacePath });
    const provider = getProvider(scope.memoryAgentId);
    const memoryManager = getMemorySearchManager(scope.memoryAgentId, scope.workspacePath);

    if (action === "search") {
      const query = String(searchParams.get("query") || "");
      const limit = Math.max(1, Math.min(50, parseInt(searchParams.get("limit") || "10", 10)));
      const mode = detectSearchMode(searchParams.get("mode"));
      const minScoreRaw = parseFloat(searchParams.get("min_score") || "0");
      const minScore = Number.isFinite(minScoreRaw) ? Math.max(0, minScoreRaw) : 0;
      const debug = searchParams.get("debug") === "1";
      const sessionKey = String(searchParams.get("sessionKey") || "");
      if (!query.trim()) {
        return NextResponse.json({ success: true, mode, data: [] });
      }
      // Authoritative scope comes from the caller's runtime context (workflow
      // execution), never from model arguments.
      const memoryAccess = normalizeMemoryAccess(searchParams.get("memoryAccess"), "agent");
      const visibilityWorkflowId = String(searchParams.get("workflowId") || "").trim() || null;
      const visibility = buildSearchVisibility(memoryAccess, visibilityWorkflowId);
      const { data: ranked, diagnostics } = await memoryManager.search({
        query,
        limit,
        minScore,
        mode,
        debug,
        sessionKey: sessionKey || undefined,
        visibility,
      });

      // Apply snippet cap, source diversification, and injected char budget.
      const { maxSnippetChars, maxInjectedChars } = loadMemoryDisplayConfig();
      const capped = ranked.map((r) => ({ ...r, content: r.content.slice(0, maxSnippetChars) }));
      const diversified = diversifyBySource(capped, limit);
      const data = clampByInjectedChars(diversified, maxInjectedChars);
      const scopedDiagnostics = diagnostics
        ? {
            ...diagnostics,
            agentId: scope.agentId,
            memoryAgentId: scope.memoryAgentId,
            sourceCounts: data.reduce<Record<string, number>>((acc, item) => {
              acc[item.source] = (acc[item.source] ?? 0) + 1;
              return acc;
            }, {}),
          }
        : null;

      return NextResponse.json({ success: true, mode, data, ...(scopedDiagnostics ? { diagnostics: scopedDiagnostics } : {}) });
    }

    if (action === "session-recall") {
      const memoryAccess = normalizeMemoryAccess(searchParams.get("memoryAccess"), "agent");
      if (memoryAccess !== "agent") {
        return NextResponse.json(
          { success: false, error: "Past-session recall is unavailable for this workflow memory scope." },
          { status: 403 },
        );
      }
      const query = collapseWhitespace(String(searchParams.get("query") || ""));
      const limit = Math.max(1, Math.min(8, parseInt(searchParams.get("limit") || "4", 10)));
      const sessionConfig = loadSessionChunkConfig();
      const sessionChunkCount = getSessionChunkCount(scope.agentId);

      if (!query) {
        return NextResponse.json({
          success: true,
          data: {
            query,
            indexingEnabled: sessionConfig.enabled,
            sessionChunkCount,
            usedModel: null,
            sessions: [],
          },
        });
      }

      const queryEmbedding = await getQueryEmbedding(query);
      const queryLower = query.toLowerCase();
      const recallTerms = extractRecallTerms(query);
      const hits = await searchSessionChunks(
        query,
        queryEmbedding,
        Math.max(limit * 6, 12),
        scope.agentId,
      );
      const lexicalMatches = searchSessionMessagesLexical({
        agentId: scope.agentId,
        query,
        limit,
      });
      if (hits.length === 0 && lexicalMatches.length === 0) {
        return NextResponse.json({
          success: true,
          data: {
            query,
            indexingEnabled: sessionConfig.enabled,
            sessionChunkCount,
            usedModel: null,
            sessions: [],
          },
        });
      }

      const grouped = new Map<
        string,
        {
          sessionId: string;
          score: number;
          matchCount: number;
          exactQueryMatch: boolean;
          termCoverage: number;
          lexicalRank: number | null;
          matches: SessionRecallMatch[];
        }
      >();
      for (const hit of hits) {
        const sessionId = String(hit.sessionId || "").trim();
        if (!sessionId) continue;
        const entry = grouped.get(sessionId) ?? {
          sessionId,
          score: 0,
          matchCount: 0,
          exactQueryMatch: false,
          termCoverage: 0,
          lexicalRank: null,
          matches: [],
        };
        const normalizedChunk = collapseWhitespace(hit.chunkText).toLowerCase();
        entry.score = Math.max(entry.score, hit.score ?? 0);
        entry.matchCount += 1;
        entry.exactQueryMatch = entry.exactQueryMatch || normalizedChunk.includes(queryLower);
        entry.termCoverage = Math.max(
          entry.termCoverage,
          countRecallTermCoverage(normalizedChunk, recallTerms),
        );
        const preview = buildSessionRecallPreview(hit.chunkText, query);
        appendSessionRecallMatch(entry, {
          score: hit.score ?? 0,
          chunkIndex: hit.chunkIndex,
          preview,
        });
        grouped.set(sessionId, entry);
      }

      for (const hit of lexicalMatches) {
        const entry = grouped.get(hit.sessionId) ?? {
          sessionId: hit.sessionId,
          score: 0,
          matchCount: 0,
          exactQueryMatch: false,
          termCoverage: 0,
          lexicalRank: null,
          matches: [],
        };
        entry.score = Math.max(entry.score, hit.score);
        entry.matchCount += 1;
        entry.exactQueryMatch = true;
        entry.termCoverage = Math.max(entry.termCoverage, Math.max(1, recallTerms.length));
        if (entry.lexicalRank == null) {
          entry.lexicalRank = lexicalMatches.findIndex((candidate) => candidate.sessionId === hit.sessionId);
        }
        appendSessionRecallMatch(entry, {
          score: hit.score,
          chunkIndex: -1,
          preview: hit.preview,
        });
        grouped.set(hit.sessionId, entry);
      }

      const rankedSessions = Array.from(grouped.values())
        .sort((left, right) => {
          if (left.lexicalRank != null || right.lexicalRank != null) {
            if (left.lexicalRank == null) return 1;
            if (right.lexicalRank == null) return -1;
            if (left.lexicalRank !== right.lexicalRank) {
              return left.lexicalRank - right.lexicalRank;
            }
          }
          if (left.exactQueryMatch !== right.exactQueryMatch) {
            return left.exactQueryMatch ? -1 : 1;
          }
          if (right.termCoverage !== left.termCoverage) {
            return right.termCoverage - left.termCoverage;
          }
          if (right.score !== left.score) return right.score - left.score;
          return right.matchCount - left.matchCount;
        })
        .slice(0, limit);

      const db = getSqlite();
      const sessionIds = rankedSessions.map((entry) => entry.sessionId);
      const placeholders = sessionIds.map(() => "?").join(", ");
      const statsRows = sessionIds.length
        ? (db
            .prepare(
              `
                SELECT session_id, COUNT(*) AS message_count, MIN(created_at) AS started_at, MAX(created_at) AS updated_at
                FROM messages
                WHERE agent_id = ?
                  AND session_id IN (${placeholders})
                GROUP BY session_id
              `,
            )
            .all(scope.agentId, ...sessionIds) as Array<{
            session_id: string;
            message_count?: number;
            started_at?: string | null;
            updated_at?: string | null;
          }>)
        : [];
      const statsBySession = new Map(
        statsRows.map((row) => [
          row.session_id,
          {
            messageCount: row.message_count ?? 0,
            startedAt: row.started_at ?? null,
            updatedAt: row.updated_at ?? null,
          },
        ]),
      );

      const sessionsWithMeta = rankedSessions.map((entry) => ({
        ...entry,
        messageCount: statsBySession.get(entry.sessionId)?.messageCount ?? 0,
        startedAt: statsBySession.get(entry.sessionId)?.startedAt ?? null,
        updatedAt: statsBySession.get(entry.sessionId)?.updatedAt ?? null,
        participants: [] as string[],
      }));

      const requestedSummaryMode = String(searchParams.get("summaries") || "").trim().toLowerCase();
      const llmSummaries =
        requestedSummaryMode === "llm"
          ? await summarizeSessionRecallWithModel(
              query,
              sessionsWithMeta.map((entry) => ({
                sessionId: entry.sessionId,
                messageCount: entry.messageCount,
                participants: entry.participants,
                matches: entry.matches,
                startedAt: entry.startedAt,
                updatedAt: entry.updatedAt,
              })),
            )
          : null;

      const sessions: SessionRecallSession[] = sessionsWithMeta.map((entry) => {
        const llmSummary = llmSummaries?.summaries.get(entry.sessionId) ?? null;
        return {
          sessionId: entry.sessionId,
          score: entry.score,
          matchCount: entry.matchCount,
          messageCount: entry.messageCount,
          startedAt: entry.startedAt,
          updatedAt: entry.updatedAt,
          participants: entry.participants,
          summary:
            llmSummary ??
            buildExtractiveSessionSummary({
              matchCount: entry.matchCount,
              messageCount: entry.messageCount,
              participants: entry.participants,
              matches: entry.matches,
            }),
          summaryMode: llmSummary ? "llm" : "extractive",
          matches: entry.matches,
        };
      });

      return NextResponse.json({
        success: true,
        data: {
          query,
          indexingEnabled: sessionConfig.enabled,
          sessionChunkCount,
          usedModel: llmSummaries
            ? { provider: llmSummaries.provider, modelId: llmSummaries.modelId }
            : null,
          sessions,
        },
      });
    }

    if (action === "get") {
      const requestedPath = String(searchParams.get("path") || "");
      if (!requestedPath.trim()) {
        return NextResponse.json({ success: false, error: "path is required" }, { status: 400 });
      }
      const fromRaw = parseInt(searchParams.get("from") || "", 10);
      const linesRaw = parseInt(searchParams.get("lines") || "", 10);
      const from = Number.isFinite(fromRaw) ? fromRaw : undefined;
      const lines = Number.isFinite(linesRaw) ? linesRaw : undefined;

      const normalized = requestedPath.trim().replace(/\\/g, "/");
      const isLegacyAtomic = /^mem_[A-Za-z0-9_-]+\.md$/i.test(normalized);
      const memoryAccess = normalizeMemoryAccess(searchParams.get("memoryAccess"), "agent");
      if (memoryAccess === "none") {
        return NextResponse.json({ success: false, error: "Durable memory access is disabled for this node." }, { status: 403 });
      }
      if (memoryAccess === "workflow") {
        if (!isLegacyAtomic) {
          return NextResponse.json({ success: false, error: "Workflow-scoped nodes may only read their own atomic memories." }, { status: 403 });
        }
        const workflowId = String(searchParams.get("workflowId") || "").trim();
        const atomicId = normalized.slice(0, -3);
        const visibility = resolveAtomicVisibility(scope.memoryAgentId, { kind: "workflow", workflowId: workflowId || null });
        if (visibility.mode !== "allow" || !visibility.ids.has(atomicId)) {
          return NextResponse.json({ success: false, error: "Memory is outside this workflow's scope." }, { status: 403 });
        }
      }

      const payload = isLegacyAtomic
        ? readLegacyAtomicSlice({ relPath: normalized, from, lines })
        : readWorkspaceMemorySlice({ relPath: normalized, from, lines, workspacePath: scope.workspacePath });
      return NextResponse.json({ success: true, data: payload });
    }

    if (action === "stats") {
      const stats = await provider.getStats();
      const workspaceFiles = listWorkspaceMemoryFiles();

      return NextResponse.json({
        success: true,
        data: {
          totalMemories: stats.totalMemories,
          storageBytes: stats.storageBytes,
          tier: "unified",
          currentMode: "unified",
          autoThreshold: stats.autoThreshold,
          workspaceMemoryFiles: listWorkspaceMemoryFiles({ workspacePath: scope.workspacePath }).length,
          embeddingModel: stats.embeddingModel,
          vectorIndexed: stats.vectorIndexed,
          sessionChunks: stats.sessionChunks,
          agentId: scope.agentId,
          workspacePath: scope.workspacePath,
        },
      });
    }

    if (action === "journal") {
      return NextResponse.json({ success: true, data: readDailyJournalItems({ workspacePath: scope.workspacePath }) });
    }

    if (action === "promotion-events") {
      return NextResponse.json({
        success: true,
        data: listMemoryPromotionEvents({
          agentId: scope.agentId,
          limit: Number(searchParams.get("limit")) || 100,
          backfillRunId: searchParams.get("backfillRunId"),
          eventKind: searchParams.get("eventKind"),
          entryId: searchParams.get("entryId"),
        }),
      });
    }

    if (action === "backfill-preview") {
      const candidates = extractBackfillCandidates({ workspacePath: scope.workspacePath }, Number(searchParams.get("limit")) || 60);
      const backfillRunId = `preview_${nanoid(10)}`;
      for (const candidate of candidates) {
        recordMemoryPromotionEvent({
          agentId: scope.agentId,
          eventKind: "candidate",
          source: "journal-backfill-preview",
          content: candidate.content,
          backfillRunId,
          detail: {
            sourcePath: candidate.sourcePath,
            journalDate: candidate.journalDate,
            lineNumber: candidate.lineNumber,
            type: candidate.type,
            tags: candidate.tags,
          },
        });
      }
      return NextResponse.json({
        success: true,
        data: {
          backfillRunId,
          candidates,
          count: candidates.length,
        },
      });
    }

    if (action === "rollups") {
      const limit = Math.max(1, Math.min(12, parseInt(searchParams.get("limit") || "6", 10)));
      const tagFilter = String(searchParams.get("tag") || "").trim().toLowerCase();
      const memories = (await provider.getAll()).filter((entry) =>
        !tagFilter || entry.tags.some((tag) => tag.toLowerCase() === tagFilter),
      );
      return NextResponse.json({
        success: true,
        data: buildMemoryRollups(memories, limit),
      });
    }

    if (action === "embedding-status") {
      const status = await memoryManager.getStatus();
      const scopedStatus = buildSessionScopeRuntime(status, scope.agentId, getSessionChunkCount(scope.agentId));
      return NextResponse.json({
        success: true,
        data: {
          configured: scopedStatus.configured,
          active: scopedStatus.active,
          vectorIndexed: scopedStatus.vectorIndexed,
          sessionChunks: scopedStatus.sessionChunks,
          collectionChunks: scopedStatus.collectionChunks,
          mode: scopedStatus.mode,
          vectorBackend: scopedStatus.vectorBackend,
          providerPlan: scopedStatus.providerPlan,
          searchPolicy: scopedStatus.searchPolicy,
          runtime: scopedStatus.runtime,
          agentId: scope.agentId,
          memoryAgentId: scope.memoryAgentId,
        },
      });
    }

    if (action === "health") {
      const status = await getMemoryCoreStatus(scope.memoryAgentId, scope.workspacePath);
      const scopedStatus = buildSessionScopeRuntime(status, scope.agentId, getSessionChunkCount(scope.agentId));
      return NextResponse.json({
        success: true,
        data: {
          ...scopedStatus,
          agentId: scope.agentId,
          memoryAgentId: scope.memoryAgentId,
          workspacePath: scope.workspacePath,
        },
      });
    }

    if (action === "diagnostics") {
      const diagnostics = await memoryManager.getDiagnosticsSummary();
      const scopedDiagnostics = buildSessionScopeRuntime(
        diagnostics,
        scope.agentId,
        getSessionChunkCount(scope.agentId),
      );
      return NextResponse.json({
        success: true,
        data: {
          agentId: scope.agentId,
          memoryAgentId: scope.memoryAgentId,
          workspacePath: scope.workspacePath,
          embeddingModel: scopedDiagnostics.embeddingModel,
          vectorBackend: scopedDiagnostics.vectorBackend,
          vectorIndexed: scopedDiagnostics.vectorIndexed,
          sessionChunks: scopedDiagnostics.sessionChunks,
          collectionChunks: scopedDiagnostics.collectionChunks,
          pathContexts: scopedDiagnostics.pathContexts,
          startupFileHygiene: getStartupFileHygieneReport({ workspacePath: scope.workspacePath }),
          providerPlan: scopedDiagnostics.providerPlan,
          searchPolicy: scopedDiagnostics.searchPolicy,
          runtime: scopedDiagnostics.runtime,
        },
      });
    }

    if (action === "path-contexts") {
      return NextResponse.json({ success: true, data: listPathContexts(scope.memoryAgentId) });
    }

    if (action === "index-collections") {
      const result = await memoryManager.indexCollections();
      return NextResponse.json({ success: true, data: result });
    }

    if (action === "rebuild-index") {
      const result = await memoryManager.rebuildAtomicIndex();
      return NextResponse.json({ success: true, data: result });
    }

    if (action === "index-sessions") {
      const result = await memoryManager.indexSessions();
      return NextResponse.json({ success: true, data: result });
    }

    if (action === "timeline") {
      const all = await provider.getAll();
      const typeFilter = String(searchParams.get("type") || "").trim();
      const limit = Math.max(1, Math.min(200, parseInt(searchParams.get("limit") || "100", 10)));
      const filtered = typeFilter ? all.filter((m) => m.type === typeFilter) : all;
      const sorted = [...filtered].sort((a, b) => {
        const ta = new Date(a.created).getTime();
        const tb = new Date(b.created).getTime();
        return tb - ta;
      }).slice(0, limit);
      const types = Array.from(new Set(all.map((m) => m.type))).sort();
      return NextResponse.json({ success: true, data: { entries: sorted, types, total: all.length } });
    }

    // Default list: all atomic entries.
    const memories = await provider.getAll();
    return NextResponse.json({ success: true, data: memories });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();

    const body = await request.json();
    const scope = resolveMemoryScope(body.agentId);
    ensureWorkspaceScaffold({ workspacePath: scope.workspacePath });
    const provider = getProvider(scope.memoryAgentId);
    const now = new Date().toISOString();

    if (String(body.action || "") === "operations") {
      // Atomic all-or-nothing batch (add/replace/remove). Single-op calls below
      // are unchanged; this is the multi-operation reliability path.
      try {
        const result = await applyMemoryOperations(body.operations as MemoryOperation[], {
          agentId: scope.memoryAgentId,
          requestId: typeof body.requestId === "string" ? body.requestId : null,
        });
        return NextResponse.json({ success: true, data: result });
      } catch (error) {
        const status = error instanceof MemoryBatchValidationError ? 400 : 500;
        return NextResponse.json({ success: false, error: String(error instanceof Error ? error.message : error) }, { status });
      }
    }

    if (String(body.action || "") === "set-path-context") {
      const pathPrefix = String(body.pathPrefix || "").trim();
      const contextText = String(body.contextText || "").trim();
      if (!pathPrefix || !contextText) {
        return NextResponse.json(
          { success: false, error: "pathPrefix and contextText are required" },
          { status: 400 },
        );
      }
      return NextResponse.json({
        success: true,
        data: upsertPathContext(pathPrefix, contextText, scope.memoryAgentId),
      });
    }

    if (String(body.action || "") === "delete-path-context") {
      const id = String(body.id || "").trim();
      if (!id) {
        return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });
      }
      return NextResponse.json({
        success: true,
        data: { deleted: deletePathContext(id) },
      });
    }

    if (String(body.action || "") === "clear-staged-signals") {
      const cleared = clearStagedMemoryPromotionEvents(scope.agentId, String(body.backfillRunId || "").trim() || null);
      return NextResponse.json({ success: true, data: { cleared } });
    }

    if (String(body.action || "") === "backfill-reset") {
      const backfillRunId = String(body.backfillRunId || "").trim();
      if (!backfillRunId) {
        return NextResponse.json({ success: false, error: "backfillRunId is required" }, { status: 400 });
      }
      const provider = getProvider(scope.memoryAgentId);
      const memories = await provider.getAll();
      const targets = memories.filter((entry) => String(entry.metadata?.backfillRunId || "") === backfillRunId);
      for (const entry of targets) {
        await provider.delete(entry.id);
        if (isDurableType(entry.type)) {
          markMainMemoryEntryDeleted(entry.id, entry.content, { workspacePath: scope.workspacePath });
        }
        recordMemoryPromotionEvent({
          agentId: scope.agentId,
          entryId: entry.id,
          eventKind: "reset",
          source: "journal-backfill-reset",
          content: entry.content,
          backfillRunId,
          detail: entry.metadata ?? null,
        });
      }
      await updateStoredStats();
      return NextResponse.json({ success: true, data: { deleted: targets.length, backfillRunId } });
    }

    if (String(body.action || "") === "backfill-apply") {
      const provider = getProvider(scope.memoryAgentId);
      const backfillRunId = String(body.backfillRunId || "").trim() || `backfill_${nanoid(10)}`;
      const candidates = extractBackfillCandidates(
        { workspacePath: scope.workspacePath },
        Math.max(1, Math.min(200, Number(body.limit) || 80)),
      );
      const existing = await provider.getAll();
      const existingContent = new Set(existing.map((entry) => collapseWhitespace(entry.content).toLowerCase()));
      const stored: MemoryEntry[] = [];

      for (const candidate of candidates) {
        const normalized = collapseWhitespace(candidate.content).toLowerCase();
        if (!normalized || existingContent.has(normalized)) continue;
        const entry: MemoryEntry = {
          id: `mem_${nanoid(8)}`,
          type: candidate.type,
          content: candidate.content,
          confidence: 0.68,
          source: "journal-backfill",
          tags: candidate.tags,
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          metadata: {
            backfillRunId,
            sourcePath: candidate.sourcePath,
            journalDate: candidate.journalDate,
            lineNumber: candidate.lineNumber,
          },
        };
        const next = await provider.store(entry);
        stored.push(next);
        existingContent.add(normalized);
        if (isDurableType(next.type)) {
          appendMainMemoryNote(next.content, {
            id: next.id,
            type: next.type,
            source: "journal-backfill",
            tags: next.tags,
            status: "active",
            confidence: next.confidence,
            agentId: scope.memoryAgentId,
          }, { workspacePath: scope.workspacePath });
        }
        recordMemoryPromotionEvent({
          agentId: scope.agentId,
          entryId: next.id,
          eventKind: "promoted",
          source: "journal-backfill",
          content: next.content,
          backfillRunId,
          detail: next.metadata ?? null,
        });
      }

      await updateStoredStats();
      return NextResponse.json({
        success: true,
        data: {
          backfillRunId,
          count: stored.length,
          entries: stored,
        },
      });
    }

    const type = String(body.type || "fact") as MemoryEntry["type"];
    const source = String(body.source || "webchat");
    const tags = parseListTags(body.tags);
    const extractMode = normalizeExtractMode(body.extractMode);
    const defaultConfidence = Number.isFinite(Number(body.confidence)) ? Number(body.confidence) : 0.8;
    const content = String(body.content || "").trim();
    const whenToUse = String(body.whenToUse || "").trim() || undefined;
    const happenedAt = String(body.happenedAt || "").trim() || undefined;

    // Optional provenance fields for stronger audit trail.
    const workflowId = body.workflowId ? String(body.workflowId) : undefined;
    const nodeId = body.nodeId ? String(body.nodeId) : undefined;
    const channel = body.channel ? String(body.channel) : undefined;
    const executionId = body.executionId ? String(body.executionId) : undefined;
    // Authoritative memory access from the caller's runtime context.
    const memoryAccess = normalizeMemoryAccess(body.memoryAccess, "agent");
    if (memoryAccess === "none") {
      return NextResponse.json({ success: false, error: "Durable memory writes are disabled for this node." }, { status: 403 });
    }

    const entriesToStore: MemoryEntry[] = [];
    if (extractMode === "auto") {
      const messages = normalizeMessageList(body.messages);
      const inputMessages = messages.length > 0
        ? messages
        : (content ? [{ role: "user" as const, content }] : []);
      if (inputMessages.length > 0) {
        const extracted = await provider.extract(inputMessages);
        for (const extractedEntry of extracted) {
          entriesToStore.push({
            ...extractedEntry,
            id: extractedEntry.id || `mem_${nanoid(8)}`,
            source: extractedEntry.source || source,
            tags: Array.from(new Set([...(extractedEntry.tags || []), ...tags])),
            confidence: Number.isFinite(Number(extractedEntry.confidence))
              ? Number(extractedEntry.confidence)
              : defaultConfidence,
            created: extractedEntry.created || now,
            updated: now,
            metadata: {
              ...(extractedEntry.metadata ?? {}),
              ...(workflowId ? { workflowId } : {}),
              ...(nodeId ? { nodeId } : {}),
              ...(channel ? { channel } : {}),
            },
          });
        }
      }
    }

    if (entriesToStore.length === 0) {
      if (!content) {
        return NextResponse.json({ success: false, error: "content is required" }, { status: 400 });
      }
      entriesToStore.push({
        id: `mem_${nanoid(8)}`,
        type,
        content,
        confidence: defaultConfidence,
        source,
        tags,
        created: now,
        updated: now,
        whenToUse,
        happenedAt,
        metadata: {
          ...(workflowId ? { workflowId } : {}),
          ...(nodeId ? { nodeId } : {}),
          ...(channel ? { channel } : {}),
        },
      });
    }

    // Workflow-scoped entries are kept private to the workflow: they go into the
    // atomic store with workflow visibility and are NOT appended to the agent's
    // curated MEMORY.md (which is injected into every workflow using the agent).
    if (memoryAccess === "workflow") {
      const visibility = buildWriteVisibility("workflow", { workflowId, executionId, nodeId });
      if (!visibility?.id) {
        return NextResponse.json({ success: false, error: "workflowId is required for workflow-scoped memory." }, { status: 400 });
      }
      const ops: MemoryOperation[] = entriesToStore.map((entry) => ({
        op: "add",
        content: entry.content,
        type: entry.type,
        tags: entry.tags,
        metadata: entry.metadata,
      }));
      const result = await applyMemoryOperations(ops, { agentId: scope.memoryAgentId, visibility });
      return NextResponse.json({
        success: true,
        data: {
          entries: result.added.map((id, index) => ({ ...entriesToStore[index], id })),
          count: result.added.length,
          extractMode,
          memoryAccess: "workflow",
        },
      });
    }

    const storedEntries: Array<MemoryEntry & { dailyPath: string }> = [];
    for (const pending of entriesToStore) {
      const stored = await provider.store(pending);

      // Build provenance tags for the daily log line.
      const provenance = [
        workflowId ? `workflow_id=${workflowId}` : "",
        nodeId ? `node_id=${nodeId}` : "",
        channel ? `channel=${channel}` : "",
      ]
        .filter(Boolean)
        .join(" ");

        const logLine = provenance
        ? `[${stored.type}] id=${stored.id} ${provenance} ${stored.content}`
        : `[${stored.type}] id=${stored.id} ${stored.content}`;

      const dailyPath = appendDailyMemoryNote(logLine, new Date(), { workspacePath: scope.workspacePath });

      if (isDurableType(stored.type)) {
        appendMainMemoryNote(stored.content, {
          id: stored.id,
          status: extractMode === "auto" ? "updated" : "active",
          type: stored.type,
          source: stored.source,
          tags: stored.tags,
          agentId: scope.memoryAgentId,
        }, { workspacePath: scope.workspacePath });
      }

      recordTelemetryEvent("memory.stored", {
        id: stored.id,
        type: stored.type,
        source: stored.source,
        confidence: stored.confidence,
        dailyPath,
        extractMode,
      });
      await runHooks("memory.stored", {
        id: stored.id,
        type: stored.type,
        content: stored.content,
        source: stored.source,
        tags: stored.tags,
        dailyPath,
        extractMode,
      });
      recordMemoryPromotionEvent({
        agentId: scope.agentId,
        entryId: stored.id,
        eventKind: extractMode === "auto" ? "extracted" : "stored",
        source,
        content: stored.content,
        detail: {
          type: stored.type,
          tags: stored.tags,
          confidence: stored.confidence,
          dailyPath,
          extractMode,
        },
      });
      storedEntries.push({ ...stored, dailyPath });
    }

    await updateStoredStats();
    if (storedEntries.length === 1) {
      return NextResponse.json({ success: true, data: storedEntries[0] });
    }
    return NextResponse.json({
      success: true,
      data: { entries: storedEntries, count: storedEntries.length, extractMode },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    initializeDatabase();

    const body = await request.json();
    const scope = resolveMemoryScope(body.agentId);
    ensureWorkspaceScaffold({ workspacePath: scope.workspacePath });
    const db = getSqlite();
    const now = new Date().toISOString();

    // Legacy tier field: silently accept but ignore (tier system removed).
    if (body.tier && !body.id) {
      return NextResponse.json({ success: true, data: { tier: "unified", currentMode: "unified" } });
    }

    if (body.id && body.content) {
      const provider = getProvider(scope.memoryAgentId);
      const id = String(body.id);
      const nextContent = String(body.content).trim();
      const before = await provider.get(id);
      await provider.update(id, nextContent);
      const after = await provider.get(id);
      const dailyPath = appendDailyMemoryNote(`[update] id=${id} ${nextContent}`, new Date(), { workspacePath: scope.workspacePath });
      if (after && isDurableType(after.type)) {
        appendMainMemoryNote(after.content, {
          id: after.id,
          type: after.type,
          source: "memory.update",
          tags: after.tags,
          status: "updated",
          agentId: scope.memoryAgentId,
        }, { workspacePath: scope.workspacePath });
      } else if (before && isDurableType(before.type)) {
        markMainMemoryEntryDeleted(id, "merged into existing memory after update", { workspacePath: scope.workspacePath });
      }
      recordTelemetryEvent("memory.updated", {
        id,
        previousContent: before?.content || "",
        content: nextContent,
        dailyPath,
      });
      await runHooks("memory.updated", {
        id,
        previousContent: before?.content || "",
        content: nextContent,
        dailyPath,
      });
      recordMemoryPromotionEvent({
        agentId: scope.agentId,
        entryId: id,
        eventKind: "updated",
        source: "memory.update",
        content: nextContent,
        detail: {
          previousContent: before?.content || "",
          dailyPath,
        },
      });
      await updateStoredStats();
      return NextResponse.json({ success: true, data: after || null });
    }

    // Update memory_config fields (embedding_model, vector_weight, text_weight, etc.)
    const allowed = [
      "embedding_model", "vector_weight", "text_weight",
      "index_sessions", "session_chunk_tokens", "session_chunk_overlap",
      "startup_include_files", "startup_exclude_files", "extra_collection_paths",
    ];
    const updates: string[] = [];
    const values: unknown[] = [];
    for (const key of allowed) {
      const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      if (body[camel] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(body[camel]);
      } else if (body[key] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(body[key]);
      }
    }
    if (updates.length > 0) {
      updates.push("updated_at = ?");
      values.push(now);
      values.push("default");
      db.prepare(`UPDATE memory_config SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      return NextResponse.json({ success: true, data: { updated: updates.length - 1 } });
    }

    return NextResponse.json({ success: false, error: "Missing required fields" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, error: "Missing id" }, { status: 400 });
    }
    const scope = resolveMemoryScope(new URL(request.url).searchParams.get("agentId"));
    ensureWorkspaceScaffold({ workspacePath: scope.workspacePath });
    const provider = getProvider(scope.memoryAgentId);
    const before = await provider.get(id);
    await provider.delete(id);
    const dailyPath = appendDailyMemoryNote(
      before
        ? `[delete] id=${id} type=${before.type} ${before.content}`
        : `[delete] id=${id}`,
      new Date(),
      { workspacePath: scope.workspacePath },
    );
    if (before && isDurableType(before.type)) {
      markMainMemoryEntryDeleted(id, before.content, { workspacePath: scope.workspacePath });
    }
    recordTelemetryEvent("memory.deleted", { id, found: Boolean(before), dailyPath });
    await runHooks("memory.deleted", {
      id,
      found: Boolean(before),
      content: before?.content || "",
      dailyPath,
    });
    recordMemoryPromotionEvent({
      agentId: scope.agentId,
      entryId: id,
      eventKind: "deleted",
      source: "memory.delete",
      content: before?.content || "",
      detail: {
        found: Boolean(before),
        dailyPath,
      },
    });
    await updateStoredStats();
    return NextResponse.json({ success: true, data: before || null });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
