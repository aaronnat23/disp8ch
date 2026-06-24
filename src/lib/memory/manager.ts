// Server-only — do not import in client components.
import { callModel } from "@/lib/agents/multi-provider";
import { getAgentById, getDefaultAgent } from "@/lib/agents/registry";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import { resolveModelApiKey } from "@/lib/agents/provider-auth";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";
import { getModelConfig } from "@/lib/agents/model-router";
import { getSqlite, getSqliteRecoveryStatus } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import { searchWorkspaceMemories } from "@/lib/workspace/files";
import type { MemoryEntry } from "@/types/memory";
import path from "node:path";
import {
  countEmbeddings,
  cosineSimilarity,
  generateEmbedding,
  generateEmbeddingsBatch,
  getEmbeddingBatchHealthSnapshot,
  getConfiguredEmbeddingModelId,
  getEmbeddingModel,
  getEmbeddingModelCandidates,
  getOrGenerateEmbedding,
  storeEmbedding,
  type EmbeddingModel,
} from "./embedding-provider";
import {
  getCollectionChunkCount,
  getConfiguredPaths,
  indexCollections,
  indexSingleFile,
  searchCollectionChunks,
} from "./collection-indexer";
import { mergeHybridResults, vectorSearch } from "./hybrid-search";
import { DEFAULT_LOCAL_RERANK_MODEL, rerankLocallyWithCrossEncoder } from "./local-reranker";
import { listPathContexts } from "./path-contexts";
import {
  getSessionChunkCount,
  getSessionIndexStateSummary,
  indexAllSessions,
  indexSessionDelta,
  searchSessionChunks,
} from "./session-indexer";
import { SimpleMemoryProvider, computeAtomicContentHash } from "./simple";
import { getSqliteVecStatus, isSqliteVecReady } from "./sqlite-vec";
import {
  atomicVisibilityAllowsId,
  filterAtomicResultsByVisibility,
  resolveAtomicVisibility,
} from "./visibility-filter";
import { getWorkspaceWatcherStatus, startWorkspaceWatcher } from "./workspace-watcher";
import {
  applyLaneScoreMultiplier,
  buildIdentifierQueryVariant as buildSharedIdentifierQueryVariant,
  compareExactRecallCandidates,
  extractIdentifierValues as extractSharedIdentifierValues,
  inferMemoryLaneFromCandidate,
  inferPreferredMemoryLane,
  normalizeExactRecallText,
  type MemoryLane,
  queryTargetsExactIdentifier as queryTargetsSharedExactIdentifier,
  stripIdentifiersForSubjectKey as stripSharedIdentifiersForSubjectKey,
} from "./exact-recall";

const log = logger.child("memory:manager");

const SESSION_DEBOUNCE_MS = 5000;
const RRF_K = 60;
const PROVIDER_FAILURE_LIMIT = 8;
const MAX_PROVIDER_FAILURES_IN_DIAGNOSTICS = 5;

const MANAGER_CACHE = new Map<string, MemorySearchManager>();

export type MemorySearchMode = "search" | "gpt";
export type SearchBackend = "builtin" | "qmd-like";
export type RerankPolicy = "auto" | "mmr" | "local" | "model" | "off";

/**
 * Authoritative memory visibility for a scoped search. Supplied only by the
 * runtime (workflow execution context or tool runtime context), never by model
 * arguments. `workflow` scope returns only atomic entries owned by this agent
 * and bound to `workflowId`, and excludes workspace/session/collection sources
 * unless explicitly enabled. `agent` scope preserves the agent boundary but
 * still excludes another workflow's private entries.
 */
export type MemoryVisibility = {
  kind: "none" | "agent" | "workflow";
  workflowId: string | null;
  includeSessions?: boolean;
  includeCollections?: boolean;
  includeWorkspace?: boolean;
};

export type SearchResult = {
  id?: string;
  path: string;
  type?: string;
  content: string;
  score: number;
  source: "atomic" | "workspace" | "session" | "collection";
  confidence?: number;
  reinforcementCount?: number;
  lastReinforcedAt?: string;
  created?: string;
  updated?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  sessionId?: string;
  startLine?: number;
  endLine?: number;
  contextText?: string;
};

type LaneSearchPlan = {
  includeAtomic: boolean;
  includeWorkspace: boolean;
  includeSessions: boolean;
  includeCollections: boolean;
  laneFilter?: MemoryLane | null;
};

const IDENTIFIER_QUERY_RE = /\b(?:exact|token|identifier|id|newest|latest|current|currently|just\s+saved|most\s+recent)\b/i;
const LONG_NUMBER_RE = /\b\d{8,}\b/g;

function queryTargetsExactIdentifier(query: string): boolean {
  return queryTargetsSharedExactIdentifier(query) || IDENTIFIER_QUERY_RE.test(query);
}

function buildIdentifierQueryVariant(query: string): string | null {
  return buildSharedIdentifierQueryVariant(query);
}

function extractIdentifierValues(text: string): string[] {
  return extractSharedIdentifierValues(text);
}

function stripIdentifiersForSubjectKey(text: string): string {
  return stripSharedIdentifiersForSubjectKey(text);
}

function reorderIdentifierFocusedResults(query: string, ranked: SearchResult[]): SearchResult[] {
  if (!queryTargetsExactIdentifier(query) || ranked.length <= 1) return ranked;

  const entryKey = (entry: SearchResult) => `${entry.source}:${entry.path}:${entry.id || ""}:${entry.startLine || 0}:${entry.endLine || 0}:${entry.content}`;
  const candidates = ranked.filter((entry) => extractIdentifierValues(entry.content).length > 0);
  if (candidates.length < 2) return ranked;

  const groups = new Map<string, SearchResult[]>();
  for (const entry of candidates) {
    const groupKey = stripIdentifiersForSubjectKey(entry.content) || normalizeExactRecallText(entry.content);
    const bucket = groups.get(groupKey);
    if (bucket) bucket.push(entry);
    else groups.set(groupKey, [entry]);
  }

  const staleKeySet = new Set<string>();
  const winnerKeySet = new Set<string>();
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    const sorted = [...entries].sort((left, right) => compareExactRecallCandidates(query, left, right));
    winnerKeySet.add(entryKey(sorted[0]!));
    for (const stale of sorted.slice(1)) staleKeySet.add(entryKey(stale));
  }

  if (staleKeySet.size === 0) return ranked;
  const winners = ranked.filter((entry) => winnerKeySet.has(entryKey(entry)));
  const nonCandidates = ranked.filter((entry) => !winnerKeySet.has(entryKey(entry)) && !staleKeySet.has(entryKey(entry)));
  return [...winners, ...nonCandidates];
}

type ProviderPlanCandidate = {
  provider: string;
  modelId: string;
  source: "primary" | "fallback";
};

type ProviderPlan = {
  configured: string;
  mode: "hybrid" | "fts5-only";
  active: { provider: string; modelId: string } | null;
  candidates: ProviderPlanCandidate[];
  fallbackCount: number;
  unavailableReason: string | null;
  embeddingModels: EmbeddingModel[];
};

type SearchPolicy = {
  backend: SearchBackend;
  rerankStrategy: RerankPolicy;
  queryExpansionEnabled: boolean;
  strongSignalEnabled: boolean;
  rerankCandidateLimit: number;
};

type ResolvedRerankPlan = {
  strategy: Exclude<SearchDiagnostics["rerankStrategy"], "off"> | "off";
  localModel: EmbeddingModel | null;
  model: { provider: string; modelId: string } | null;
};

type RerankResult = {
  item: SearchResult;
  rerankScore: number;
};

type ActiveChatModel = {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  fastMode?: boolean;
};

type ProviderFailure = {
  role: "embedding" | "rerank-local" | "rerank-model";
  provider: string;
  modelId: string;
  error: string;
  at: string;
};

type ProviderHealth = {
  role: "embedding" | "rerank-local" | "rerank-model";
  provider: string;
  modelId: string;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
};

type QueryAssistPlan = {
  rewrittenQuery: string | null;
  variants: string[];
};

type MemoryJobKind =
  | "workspace-file"
  | "session-delta"
  | "sync-collections"
  | "sync-sessions"
  | "rebuild-atomic";

type MemoryJobSummary = {
  kind: MemoryJobKind;
  key: string;
  status: "running" | "completed" | "failed";
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

export type RuntimeStatus = {
  started: boolean;
  startedAt: string | null;
  dirty: boolean;
  sessionsDirty: boolean;
  lastSyncAt: string | null;
  lastSyncReason: string | null;
  lastFailure: string | null;
  providerFailures: ProviderFailure[];
  providerHealth: ProviderHealth[];
  providerBatchHealth: Array<{
    provider: string;
    modelId: string;
    batchSuccesses: number;
    batchFailures: number;
    batchFallbacks: number;
    consecutiveBatchFailures: number;
    lastBatchSuccessAt: string | null;
    lastBatchFailureAt: string | null;
    lastBatchError: string | null;
  }>;
  watcher: {
    started: boolean;
    startedAt: string | null;
    watchDirs: string[];
    pollingFallback: boolean;
    lastEventAt: string | null;
    lastChangedPath: string | null;
  };
  sessions: {
    pending: string[];
    warmCount: number;
    trackedCount: number;
    lastIndexedAt: string | null;
  };
  jobs: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    active: MemoryJobSummary[];
    lastCompleted: MemoryJobSummary | null;
    lastFailed: MemoryJobSummary | null;
  };
  isolation: {
    atomicFtsScoped: boolean;
    workspaceScoped: boolean;
    sessionScoped: boolean;
    collectionScoped: boolean;
  };
  recovery: {
    attempts: number;
    successes: number;
    failures: number;
    lastReason: string | null;
    lastError: string | null;
    lastRecoveredAt: string | null;
  };
};

export type SearchDiagnostics = {
  query: string;
  strongSignal: boolean;
  rewrittenQuery: string | null;
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
  providerPlan: {
    configured: string;
    mode: "hybrid" | "fts5-only";
    actualMode: "hybrid" | "fts5-only";
    active: { provider: string; modelId: string } | null;
    candidates: Array<{ provider: string; modelId: string; source: string }>;
    selected: { provider: string; modelId: string; source: string } | null;
    fallbackCount: number;
    unavailableReason: string | null;
  };
  searchPolicy: SearchPolicy;
  rerankStrategy: "mmr" | "local" | "model" | "off";
  rerankModel: { provider: string; modelId: string } | null;
  queryEmbeddingProvider: string | null;
  agentId: string;
  workspacePath: string;
  timingsMs: {
    embed: number;
    primarySearch: number;
    queryExpansion: number;
    rerank: number;
    total: number;
  };
  explain: {
    searchBackend: SearchBackend;
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
  runtime: RuntimeStatus;
};

function resolveManagerWorkspacePath(agentId: string, workspacePath?: string): string {
  if (workspacePath) return workspacePath;
  if (!agentId || agentId === "default") {
    return getDefaultAgent().workspacePath;
  }
  return getAgentById(agentId)?.workspacePath ?? getDefaultAgent().workspacePath;
}

function buildManagerKey(agentId: string, workspacePath?: string): string {
  return `${agentId}:${resolveManagerWorkspacePath(agentId, workspacePath)}`;
}

export function getMemorySearchManager(agentId = "default", workspacePath?: string): MemorySearchManager {
  const resolvedWorkspace = resolveManagerWorkspacePath(agentId, workspacePath);
  const key = buildManagerKey(agentId, resolvedWorkspace);
  const existing = MANAGER_CACHE.get(key);
  if (existing) return existing;
  const manager = new MemorySearchManager(agentId, resolvedWorkspace);
  MANAGER_CACHE.set(key, manager);
  return manager;
}

function loadHybridConfig() {
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

function loadSearchPolicyConfig(): SearchPolicy {
  try {
    const db = getSqlite();
    const row = db
      .prepare(
        "SELECT search_backend, rerank_strategy, query_expansion_enabled, strong_signal_enabled, rerank_candidate_limit FROM memory_config WHERE id = 'default'",
      )
      .get() as {
      search_backend?: string;
      rerank_strategy?: string;
      query_expansion_enabled?: number;
      strong_signal_enabled?: number;
      rerank_candidate_limit?: number;
    } | undefined;
    const backend = row?.search_backend === "builtin" ? "builtin" : "qmd-like";
    const rerankStrategy =
      row?.rerank_strategy === "mmr" ||
      row?.rerank_strategy === "local" ||
      row?.rerank_strategy === "model" ||
      row?.rerank_strategy === "off"
        ? row.rerank_strategy
        : "auto";
    return {
      backend,
      rerankStrategy,
      queryExpansionEnabled: row?.query_expansion_enabled !== 0,
      strongSignalEnabled: row?.strong_signal_enabled !== 0,
      rerankCandidateLimit: Math.max(5, Math.min(80, Number(row?.rerank_candidate_limit ?? 40))),
    };
  } catch {
    return {
      backend: "qmd-like",
      rerankStrategy: "auto",
      queryExpansionEnabled: true,
      strongSignalEnabled: true,
      rerankCandidateLimit: 40,
    };
  }
}

function scoreAtomicEntry(entry: MemoryEntry): number {
  const created = new Date(entry.lastReinforcedAt || entry.created).getTime();
  const now = Date.now();
  const daysSince = Number.isFinite(created) ? Math.max(0, (now - created) / (1000 * 60 * 60 * 24)) : 0;
  const recency = Math.exp((-Math.log(2) * daysSince) / 30);
  const reinforced = 1 + Math.log1p(Math.max(1, Number(entry.reinforcementCount) || 1) - 1) * 0.25;
  return (entry.confidence || 0.7) * recency * reinforced;
}

function serializeVectorBackendStatus() {
  const status = getSqliteVecStatus();
  return {
    kind: status.available ? ("sqlite-vec" as const) : ("json-cosine-fallback" as const),
    available: status.available,
    loaded: status.loaded,
    dimensions: status.dimensions,
    error: status.error,
  };
}

function tokenSimilarity(a: string, b: string): number {
  const tokA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  let intersection = 0;
  for (const token of tokA) {
    if (tokB.has(token)) intersection += 1;
  }
  const union = tokA.size + tokB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Strip long identifier values before computing Jaccard similarity for MMR diversity.
 * Two entries that differ only in their identifier — e.g. "release token ABC-123-XYZ"
 * vs "release token DEF-456-GHI" — have raw Jaccard ~0.33 and both survive MMR.
 * After stripping, both reduce to "release token" → Jaccard ~1.0 → MMR suppresses
 * the stale copy and keeps only the highest-scoring (most recent) one.
 */
function stripForDiversity(content: string): string {
  return content
    .replace(/\b[A-Z0-9]+(?:-[A-Z0-9]+){2,}\b/g, " ") // hyphenated uppercase tokens (UUIDs, gate tokens)
    .replace(/\b\d{8,}\b/g, " ")                        // long standalone numbers
    .replace(/\s+/g, " ")
    .trim();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function tokenizeForSearch(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function lexicalOverlap(query: string, content: string): number {
  const queryTokens = new Set(tokenizeForSearch(query));
  if (queryTokens.size === 0) return 0;
  const contentTokens = new Set(tokenizeForSearch(content));
  let matches = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) matches += 1;
  }
  return matches / queryTokens.size;
}

function buildResultStableKey(item: SearchResult): string {
  if (item.id) return `${item.source}:${item.id}`;
  const start = item.startLine ?? 0;
  const end = item.endLine ?? 0;
  return `${item.source}:${item.path}:${start}:${end}:${item.type ?? ""}`;
}

function normalizeRankScore(index: number, total: number): number {
  if (total <= 1) return 1;
  return 1 - index / Math.max(1, total - 1);
}

function reciprocalRankFusion(lists: SearchResult[][], limit: number, k = RRF_K): SearchResult[] {
  const merged = new Map<string, SearchResult & { fusedScore: number }>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const key = buildResultStableKey(item);
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
    .map(({ fusedScore: _ignored, ...item }) => item);
}

function mmrRerank(candidates: SearchResult[], limit: number, lambda = 0.6): SearchResult[] {
  if (candidates.length <= limit) return candidates;
  const selected: SearchResult[] = [];
  const remaining = [...candidates];

  while (selected.length < limit && remaining.length > 0) {
    let bestScore = -Infinity;
    let bestIndex = 0;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const relevance = candidate.score;
      const candidateNorm = stripForDiversity(candidate.content);
      const maxSimilarity =
        selected.length === 0
          ? 0
          : Math.max(...selected.map((item) => tokenSimilarity(candidateNorm, stripForDiversity(item.content))));
      const score = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    selected.push(remaining[bestIndex]!);
    remaining.splice(bestIndex, 1);
  }

  return selected;
}

function chunkCandidateContent(content: string): Array<{ text: string; position: number }> {
  const normalized = content.replace(/\r/g, "").trim();
  if (!normalized) return [];

  const paragraphChunks = normalized
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  if (paragraphChunks.length > 1) {
    return paragraphChunks.map((text, index) => ({ text, position: index }));
  }

  if (normalized.length <= 480) {
    return [{ text: normalized, position: 0 }];
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  if (sentences.length <= 2) {
    return [{ text: normalized, position: 0 }];
  }

  const chunks: Array<{ text: string; position: number }> = [];
  const windowSize = 3;
  for (let index = 0; index < sentences.length; index += 2) {
    const text = sentences.slice(index, index + windowSize).join(" ").trim();
    if (text) {
      chunks.push({ text, position: chunks.length });
    }
  }
  return chunks.length > 0 ? chunks : [{ text: normalized, position: 0 }];
}

function pickBestChunkForQuery(query: string, candidate: SearchResult): SearchResult {
  const chunks = chunkCandidateContent(candidate.content);
  if (chunks.length <= 1) return candidate;

  const loweredQuery = query.toLowerCase();
  let best = chunks[0]!;
  let bestScore = -Infinity;

  chunks.forEach((chunk, index) => {
    const overlap = lexicalOverlap(query, chunk.text);
    const semantic = tokenSimilarity(query, chunk.text);
    const phraseBoost = chunk.text.toLowerCase().includes(loweredQuery) ? 0.2 : 0;
    const positionalPrior = 1 - index / Math.max(1, chunks.length - 1);
    const score = overlap * 0.5 + semantic * 0.2 + phraseBoost + positionalPrior * 0.1;
    if (score > bestScore) {
      best = chunk;
      bestScore = score;
    }
  });

  return {
    ...candidate,
    content: best.text,
    score: clamp01(candidate.score * 0.85 + clamp01(bestScore) * 0.15),
  };
}

function toRerankScores(items: SearchResult[]): RerankResult[] {
  const total = items.length;
  return items.map((item, index) => ({
    item,
    rerankScore: clamp01(normalizeRankScore(index, total)),
  }));
}

function applyPositionAwareBlend(query: string, reranked: RerankResult[], originals: SearchResult[]): SearchResult[] {
  const originalRanks = new Map<string, { rank: number; score: number }>();
  originals.forEach((item, index) => {
    originalRanks.set(buildResultStableKey(item), {
      rank: index,
      score: clamp01(item.score),
    });
  });

  return reranked
    .map(({ item, rerankScore }, index) => {
      const stableKey = buildResultStableKey(item);
      const original = originalRanks.get(stableKey);
      const originalRankScore = clamp01(
        normalizeRankScore(original?.rank ?? index, Math.max(1, originals.length)),
      );
      const chunkSignal = lexicalOverlap(query, item.content);
      const blendedScore = clamp01(
        rerankScore * 0.55 +
          originalRankScore * 0.25 +
          (original?.score ?? clamp01(item.score)) * 0.15 +
          chunkSignal * 0.05,
      );
      return {
        ...item,
        score: blendedScore,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function loadActiveChatModel(): ActiveChatModel | null {
  try {
    const db = getSqlite();
    const row = db
      .prepare("SELECT * FROM models WHERE is_active = 1 ORDER BY priority DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      const runtime = getModelConfig({ sessionId: null });
      return {
        provider: runtime.provider,
        modelId: runtime.modelId,
        apiKey: runtime.apiKey,
        baseUrl: runtime.baseUrl,
        fastMode: runtime.fastMode,
      };
    }
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

export class MemorySearchManager {
  private readonly agentId: string;
  private readonly workspacePath: string;
  private readonly simple: SimpleMemoryProvider;
  private runtimeStartPromise: Promise<void> | null = null;
  private runtimeStarted = false;
  private dirty = false;
  private sessionsDirty = false;
  private readonly sessionDirtyIds = new Set<string>();
  private readonly warmSessions = new Set<string>();
  private readonly sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly providerFailures: ProviderFailure[] = [];
  private readonly providerHealth = new Map<string, ProviderHealth>();
  private lastFailure: string | null = null;
  private lastSyncAt: string | null = null;
  private lastSyncReason: string | null = null;
  private readonly activeJobs = new Map<string, MemoryJobSummary>();
  private readonly inflightJobs = new Map<string, Promise<unknown>>();
  private jobChain: Promise<void> = Promise.resolve();
  private jobCounts = { queued: 0, running: 0, completed: 0, failed: 0 };
  private lastCompletedJob: MemoryJobSummary | null = null;
  private lastFailedJob: MemoryJobSummary | null = null;

  constructor(agentId = "default", workspacePath = resolveManagerWorkspacePath(agentId)) {
    this.agentId = agentId;
    this.workspacePath = workspacePath;
    this.simple = new SimpleMemoryProvider(agentId);
    this.dirty = getConfiguredPaths().length > 0 && getCollectionChunkCount(this.agentId) === 0;
  }

  async ensureRuntimeStarted(): Promise<void> {
    if (this.runtimeStarted) return;
    if (this.runtimeStartPromise) {
      await this.runtimeStartPromise;
      return;
    }
    this.runtimeStartPromise = (async () => {
      startWorkspaceWatcher({
        agentId: this.agentId,
        workspacePath: this.workspacePath,
        onChange: (filePath) => {
          this.markDirty("watcher");
          void this.scheduleWorkspaceFile(filePath);
        },
        onError: (error) => {
          this.recordRuntimeFailure(`workspace watcher: ${String(error)}`);
        },
      });
      this.runtimeStarted = true;
      if (this.dirty) {
        void this.sync({ reason: "startup" });
      }
    })();
    try {
      await this.runtimeStartPromise;
    } finally {
      this.runtimeStartPromise = null;
    }
  }

  getProviderPlan(explicitModelId?: string): ProviderPlan {
    const configured = explicitModelId ?? getConfiguredEmbeddingModelId();
    const requested = configured === "auto" ? undefined : configured;
    const candidates = configured === "disabled" ? [] : getEmbeddingModelCandidates(requested);
    const unavailableReason =
      configured === "disabled"
        ? "Embedding model is disabled."
        : candidates.length === 0
          ? "No embedding provider is currently available."
          : null;
    return {
      configured,
      mode: candidates.length > 0 ? "hybrid" : "fts5-only",
      active: candidates[0] ? { provider: candidates[0].provider, modelId: candidates[0].modelId } : null,
      candidates: candidates.map((candidate, index) => ({
        provider: candidate.provider,
        modelId: candidate.modelId,
        source: index === 0 ? "primary" : "fallback",
      })),
      fallbackCount: Math.max(0, candidates.length - 1),
      unavailableReason,
      embeddingModels: candidates,
    };
  }

  async getResolvedEmbeddingModel(explicitModelId?: string): Promise<EmbeddingModel | null> {
    return this.getProviderPlan(explicitModelId).embeddingModels[0] ?? null;
  }

  private buildProviderHealthKey(
    role: "embedding" | "rerank-local" | "rerank-model",
    provider: string,
    modelId: string,
  ): string {
    return `${role}:${provider}:${modelId}`;
  }

  private getProviderHealthSnapshot(): ProviderHealth[] {
    return Array.from(this.providerHealth.values())
      .sort((a, b) => {
        const left = Date.parse(b.lastFailureAt ?? b.lastSuccessAt ?? "");
        const right = Date.parse(a.lastFailureAt ?? a.lastSuccessAt ?? "");
        return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
      })
      .slice(0, MAX_PROVIDER_FAILURES_IN_DIAGNOSTICS);
  }

  private recordProviderSuccess(
    role: "embedding" | "rerank-local" | "rerank-model",
    provider: string,
    modelId: string,
  ): void {
    const key = this.buildProviderHealthKey(role, provider, modelId);
    const now = new Date().toISOString();
    const existing = this.providerHealth.get(key);
    this.providerHealth.set(key, {
      role,
      provider,
      modelId,
      successes: (existing?.successes ?? 0) + 1,
      failures: existing?.failures ?? 0,
      consecutiveFailures: 0,
      lastSuccessAt: now,
      lastFailureAt: existing?.lastFailureAt ?? null,
      lastError: existing?.lastError ?? null,
    });
  }

  private recordProviderFailure(
    role: "embedding" | "rerank-local" | "rerank-model",
    provider: string,
    modelId: string,
    error: string,
  ): void {
    const key = this.buildProviderHealthKey(role, provider, modelId);
    const now = new Date().toISOString();
    const existing = this.providerHealth.get(key);
    this.providerHealth.set(key, {
      role,
      provider,
      modelId,
      successes: existing?.successes ?? 0,
      failures: (existing?.failures ?? 0) + 1,
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
      lastSuccessAt: existing?.lastSuccessAt ?? null,
      lastFailureAt: now,
      lastError: error,
    });
    this.providerFailures.push({
      role,
      provider,
      modelId,
      error,
      at: now,
    });
    while (this.providerFailures.length > PROVIDER_FAILURE_LIMIT) {
      this.providerFailures.shift();
    }
    this.lastFailure = `${provider}:${modelId}: ${error}`;
  }

  private recordRuntimeFailure(message: string): void {
    this.lastFailure = message;
    log.warn("Memory runtime failure", {
      agentId: this.agentId,
      workspacePath: this.workspacePath,
      error: message,
    });
  }

  async embedQueryWithFallback(query: string, explicitModelId?: string): Promise<{
    embedding: number[] | null;
    model: EmbeddingModel | null;
    providerPlan: ProviderPlan;
    selected: ProviderPlanCandidate | null;
    failureReason: string | null;
  }> {
    const providerPlan = this.getProviderPlan(explicitModelId);
    const failures: string[] = [];
    for (let index = 0; index < providerPlan.embeddingModels.length; index++) {
      const model = providerPlan.embeddingModels[index]!;
      try {
        const embedding = await generateEmbedding(query, model);
        if (embedding && embedding.length > 0) {
          this.recordProviderSuccess("embedding", model.provider, model.modelId);
          return {
            embedding,
            model,
            providerPlan,
            selected: providerPlan.candidates[index] ?? null,
            failureReason: null,
          };
        }
        const failure = `${model.provider}:${model.modelId}: empty embedding`;
        failures.push(failure);
        this.recordProviderFailure("embedding", model.provider, model.modelId, "empty embedding");
      } catch (error) {
        const failure = `${model.provider}:${model.modelId}: ${String(error)}`;
        failures.push(failure);
        this.recordProviderFailure("embedding", model.provider, model.modelId, String(error));
        log.warn("Query embedding failed", {
          provider: model.provider,
          modelId: model.modelId,
          error: String(error),
        });
        continue;
      }
    }
    return {
      embedding: null,
      model: null,
      providerPlan,
      selected: null,
      failureReason: failures[0] ?? providerPlan.unavailableReason,
    };
  }

  private getLocalRerankModel(primaryModel: EmbeddingModel | null): EmbeddingModel | null {
    if (primaryModel?.provider === "local") return primaryModel;
    return getEmbeddingModel("local");
  }

  private async planQueryVariants(query: string): Promise<QueryAssistPlan> {
    const model = loadActiveChatModel();
    if (!model) return { rewrittenQuery: null, variants: [] };
    try {
      const result = await callModel({
        provider: model.provider as Parameters<typeof callModel>[0]["provider"],
        modelId: model.modelId,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
        fastMode: model.fastMode,
        systemPrompt:
          "For memory retrieval, return JSON only with {\"rewrite\":string|null,\"variants\":[...]}." +
          " Use rewrite only when the query is ambiguous, pronoun-heavy, or missing the main noun." +
          " Generate up to 3 alternate search queries and keep everything short and concrete.",
        userMessage: `Original query: ${query}`,
        maxTokens: 200,
      });
      const match = result.response.match(/\{[\s\S]*\}/);
      if (!match) return { rewrittenQuery: null, variants: [] };
      const parsed = JSON.parse(match[0]) as { rewrite?: string | null; variants?: string[] };
      const rewrittenQuery = String(parsed.rewrite || "").trim() || null;
      const variants = (Array.isArray(parsed.variants) ? parsed.variants : [])
        .map((variant) => String(variant || "").trim())
        .filter((variant) => variant && variant.toLowerCase() !== query.toLowerCase())
        .filter((variant, index, all) => all.findIndex((item) => item.toLowerCase() === variant.toLowerCase()) === index)
        .slice(0, 3);
      return {
        rewrittenQuery:
          rewrittenQuery && rewrittenQuery.toLowerCase() !== query.toLowerCase()
            ? rewrittenQuery
            : null,
        variants,
      };
    } catch {
      return { rewrittenQuery: null, variants: [] };
    }
  }

  private async rerankWithModel(
    query: string,
    candidates: SearchResult[],
    activeModel: ActiveChatModel,
  ): Promise<RerankResult[]> {
    if (candidates.length <= 1) return toRerankScores(candidates);

    const short = candidates.slice(0, Math.min(24, Math.max(12, candidates.length)));
    const payload = short
      .map((candidate, index) => {
        const lines = candidate.startLine && candidate.endLine ? ` lines=${candidate.startLine}-${candidate.endLine}` : "";
        return `[${index}] path=${candidate.path}${lines}\n${candidate.content.slice(0, 500)}`;
      })
      .join("\n\n");

    try {
      const result = await callModel({
        provider: activeModel.provider as Parameters<typeof callModel>[0]["provider"],
        modelId: activeModel.modelId,
        apiKey: activeModel.apiKey,
        baseUrl: activeModel.baseUrl,
        fastMode: activeModel.fastMode,
        systemPrompt:
          "You rank memory snippets for relevance. Return JSON only with {\"results\":[{\"index\":0,\"score\":0.98}]}. Scores must be between 0 and 1.",
        userMessage:
          `Query: ${query}\n\nCandidates:\n${payload}\n\n` +
          `Return ranked candidates as JSON only.`,
        maxTokens: 300,
      });

      const jsonMatch = result.response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return toRerankScores(short);
      const parsed = JSON.parse(jsonMatch[0]) as { indexes?: number[]; results?: Array<{ index?: number; score?: number }> };
      const scored = new Map<string, RerankResult>();

      if (Array.isArray(parsed.results)) {
        for (const row of parsed.results) {
          const index = Number(row?.index);
          if (!Number.isInteger(index) || index < 0 || index >= short.length) continue;
          const item = short[index];
          if (!item) continue;
          const stableKey = buildResultStableKey(item);
          scored.set(stableKey, {
            item,
            rerankScore: clamp01(Number(row?.score ?? normalizeRankScore(index, short.length))),
          });
        }
      } else if (Array.isArray(parsed.indexes)) {
        parsed.indexes.forEach((index, order) => {
          if (!Number.isInteger(index) || index < 0 || index >= short.length) return;
          const item = short[index];
          if (!item) return;
          scored.set(buildResultStableKey(item), {
            item,
            rerankScore: clamp01(normalizeRankScore(order, parsed.indexes!.length)),
          });
        });
      }

      if (scored.size === 0) {
        this.recordProviderSuccess("rerank-model", activeModel.provider, activeModel.modelId);
        return toRerankScores(short);
      }

      const ordered = short.map((item, index) => {
        const existing = scored.get(buildResultStableKey(item));
        return existing ?? { item, rerankScore: clamp01(normalizeRankScore(index + scored.size, short.length + scored.size)) * 0.5 };
      });
      this.recordProviderSuccess("rerank-model", activeModel.provider, activeModel.modelId);
      return ordered.sort((a, b) => b.rerankScore - a.rerankScore);
    } catch (error) {
      this.recordProviderFailure("rerank-model", activeModel.provider, activeModel.modelId, String(error));
      return toRerankScores(short);
    }
  }

  private async rerankLocally(
    query: string,
    candidates: SearchResult[],
    primaryModel: EmbeddingModel | null,
  ): Promise<{ data: RerankResult[]; model: { provider: string; modelId: string } | null }> {
    const localModel = this.getLocalRerankModel(primaryModel);
    if (!localModel) return { data: toRerankScores(candidates), model: null };

    const short = candidates.slice(0, Math.min(32, Math.max(12, candidates.length)));
    const localOnly = localModel.modelId.toLowerCase().startsWith("local-only:");
    const crossEncoder = await rerankLocallyWithCrossEncoder(
      query,
      short.map((candidate) => `${candidate.path}\n${candidate.content.slice(0, 1400)}`),
      {
        modelId: DEFAULT_LOCAL_RERANK_MODEL,
        localOnly,
      },
    );
    if (crossEncoder) {
      this.recordProviderSuccess("rerank-local", "local", crossEncoder.modelId);
      const rescored: RerankResult[] = short.map((candidate, index) => {
        const semantic = clamp01(Number(crossEncoder.scores[index] ?? 0));
        const lexical = lexicalOverlap(query, candidate.content);
        const combined = semantic * 0.8 + lexical * 0.1 + clamp01(candidate.score) * 0.1;
        return { item: candidate, rerankScore: clamp01(combined) };
      });
      return {
        data: rescored.sort((a, b) => b.rerankScore - a.rerankScore),
        model: { provider: "local", modelId: crossEncoder.modelId },
      };
    }

    try {
      const payload = [query, ...short.map((candidate) => `${candidate.path}\n${candidate.content.slice(0, 900)}`)];
      const embeddings = await generateEmbeddingsBatch(payload, localModel, 16);
      const queryEmbedding = embeddings[0];
      if (!queryEmbedding) {
        this.recordProviderFailure("rerank-local", localModel.provider, localModel.modelId, "empty local rerank embedding");
        return { data: toRerankScores(short), model: { provider: localModel.provider, modelId: localModel.modelId } };
      }

      const rescored: RerankResult[] = short.map((candidate, index) => {
        const candidateEmbedding = embeddings[index + 1];
        const semantic = candidateEmbedding ? cosineSimilarity(queryEmbedding, candidateEmbedding) : 0;
        const lexical = lexicalOverlap(query, candidate.content);
        const combined = semantic * 0.7 + lexical * 0.15 + clamp01(candidate.score) * 0.15;
        return { item: candidate, rerankScore: clamp01(combined) };
      });
      this.recordProviderSuccess("rerank-local", localModel.provider, localModel.modelId);
      return {
        data: rescored.sort((a, b) => b.rerankScore - a.rerankScore),
        model: { provider: localModel.provider, modelId: localModel.modelId },
      };
    } catch (error) {
      this.recordProviderFailure("rerank-local", localModel.provider, localModel.modelId, String(error));
      return {
        data: toRerankScores(short),
        model: { provider: localModel.provider, modelId: localModel.modelId },
      };
    }
  }

  private filterAtomicVisibility(results: SearchResult[], visibility?: MemoryVisibility): SearchResult[] {
    return filterAtomicResultsByVisibility(this.agentId, results, visibility);
  }

  private async searchAtomic(query: string, queryEmbedding: number[] | null, limit: number, visibility?: MemoryVisibility): Promise<SearchResult[]> {
    const config = loadHybridConfig();
    const resolvedVisibility = resolveAtomicVisibility(this.agentId, visibility);
    const isVisible = (id: string) => atomicVisibilityAllowsId(resolvedVisibility, id);
    const bm25Results = await this.simple.search(query, limit, isVisible);

    if (!queryEmbedding) {
      return this.filterAtomicVisibility(bm25Results.map((entry) => ({
        id: entry.id,
        path: `${entry.id}.md`,
        type: entry.type,
        content: entry.content,
        confidence: entry.confidence,
        reinforcementCount: entry.reinforcementCount,
        lastReinforcedAt: entry.lastReinforcedAt,
        created: entry.created,
        updated: entry.updated,
        tags: entry.tags,
        metadata: entry.metadata,
        score: scoreAtomicEntry(entry),
        source: "atomic",
      })), visibility);
    }

    const allEntries = (await this.simple.getAll()).filter((entry) => isVisible(entry.id));
    const vectorResults = await vectorSearch(queryEmbedding, allEntries, limit, this.agentId);
    const merged = mergeHybridResults(
      bm25Results.map((entry) => ({ ...entry, score: undefined })),
      vectorResults,
      config.vectorWeight,
      config.textWeight,
      limit,
    );

    return this.filterAtomicVisibility(merged.map((entry) => ({
      id: entry.id,
      path: `${entry.id}.md`,
      type: entry.type,
      content: entry.content,
      confidence: entry.confidence,
      reinforcementCount: entry.reinforcementCount,
      lastReinforcedAt: entry.lastReinforcedAt,
      created: entry.created,
      updated: entry.updated,
      tags: entry.tags,
      metadata: entry.metadata,
      score: entry.hybridScore,
      source: "atomic",
    })), visibility);
  }

  private resolveLaneSearchPlan(lane: MemoryLane, preferredOnly: boolean): LaneSearchPlan {
    if (!preferredOnly) {
      return {
        includeAtomic: true,
        includeWorkspace: true,
        includeSessions: true,
        includeCollections: true,
        laneFilter: null,
      };
    }
    switch (lane) {
      case "session_history":
        return {
          includeAtomic: false,
          includeWorkspace: false,
          includeSessions: true,
          includeCollections: false,
          laneFilter: "session_history",
        };
      case "ephemeral_test":
        return {
          includeAtomic: true,
          includeWorkspace: true,
          includeSessions: false,
          includeCollections: true,
          laneFilter: "ephemeral_test",
        };
      case "persistent_facts":
      default:
        return {
          includeAtomic: true,
          includeWorkspace: true,
          includeSessions: false,
          includeCollections: true,
          laneFilter: "persistent_facts",
        };
    }
  }

  private async runSearchPlan(
    query: string,
    limit: number,
    queryEmbedding: number[] | null,
    sessionKey: string | undefined,
    plan: LaneSearchPlan,
    visibility?: MemoryVisibility,
  ): Promise<SearchResult[]> {
    // Workflow scope hides workspace/session/collection sources unless the node
    // explicitly opts in; agent scope preserves existing source selection.
    const isRestrictedScope = visibility?.kind === "workflow" || visibility?.kind === "none";
    const allowWorkspace = plan.includeWorkspace && (!isRestrictedScope || visibility?.includeWorkspace === true);
    const allowSessions = plan.includeSessions && (!isRestrictedScope || visibility?.includeSessions === true);
    const allowCollections = plan.includeCollections && (!isRestrictedScope || visibility?.includeCollections === true);

    const atomic = plan.includeAtomic
      ? await this.searchAtomic(query, queryEmbedding, Math.max(limit, 6), visibility)
      : [];
    const workspace = allowWorkspace
      ? searchWorkspaceMemories(
          query,
          Math.max(limit, 4),
          { workspacePath: this.workspacePath },
          { includeDaily: false },
        )
      : [];
    const sessions = allowSessions
      ? await searchSessionChunks(query, queryEmbedding, Math.max(limit, 4), this.agentId)
      : [];
    const collections = allowCollections
      ? await searchCollectionChunks(query, queryEmbedding, Math.max(limit, 4), this.agentId)
      : [];
    // Exact-identifier collection staging threads query into mergeSourceResults exactly the same way
    // as the old collection-only shape: mergeSourceResults({ atomic, workspace, sessions: [], collections, query }).
    const merged = this.mergeSourceResults({ atomic, workspace, sessions, collections, query, sessionKey });
    return plan.laneFilter
      ? merged.filter((entry) => inferMemoryLaneFromCandidate(entry) === plan.laneFilter)
      : merged;
  }

  private async runLexicalProbe(query: string, limit: number, sessionKey?: string, plan?: LaneSearchPlan, visibility?: MemoryVisibility): Promise<SearchResult[]> {
    return this.runSearchPlan(
      query,
      limit,
      null,
      sessionKey,
      plan ?? this.resolveLaneSearchPlan("persistent_facts", false),
      visibility,
    );
  }

  private isStrongLexicalSignal(query: string, candidates: SearchResult[], limit: number): boolean {
    if (candidates.length < Math.min(limit, 2)) return false;
    const top = candidates[0];
    const next = candidates[1];
    if (!top || !next) return false;
    const overlap = lexicalOverlap(query, top.content);
    const margin = clamp01(top.score) - clamp01(next.score);
    return overlap >= 0.6 && clamp01(top.score) >= 0.72 && margin >= 0.1;
  }

  private resolveRerankPlan(
    options: { mode: MemorySearchMode },
    policy: SearchPolicy,
    activeChatModel: ActiveChatModel | null,
    primaryEmbeddingModel: EmbeddingModel | null,
  ): ResolvedRerankPlan {
    const localModel = this.getLocalRerankModel(primaryEmbeddingModel);
    const backendDefaultPlan = (): ResolvedRerankPlan => {
      if (options.mode === "gpt" && activeChatModel) {
        return {
          strategy: "model",
          localModel: null,
          model: { provider: activeChatModel.provider, modelId: activeChatModel.modelId },
        };
      }
      if (policy.backend === "qmd-like" && localModel) {
        return {
          strategy: "local",
          localModel,
          model: { provider: "local", modelId: DEFAULT_LOCAL_RERANK_MODEL },
        };
      }
      return { strategy: "mmr", localModel: null, model: null };
    };

    switch (policy.rerankStrategy) {
      case "off":
        return { strategy: "off", localModel: null, model: null };
      case "mmr":
        return { strategy: "mmr", localModel: null, model: null };
      case "local":
        return localModel
          ? {
              strategy: "local",
              localModel,
              model: { provider: localModel.provider, modelId: localModel.modelId },
            }
          : { strategy: "mmr", localModel: null, model: null };
      case "model":
        return activeChatModel
          ? {
              strategy: "model",
              localModel: null,
              model: { provider: activeChatModel.provider, modelId: activeChatModel.modelId },
            }
          : backendDefaultPlan();
      case "auto":
      default:
        return backendDefaultPlan();
    }
  }

  private mergeSourceResults(options: {
    atomic: SearchResult[];
    workspace: ReturnType<typeof searchWorkspaceMemories>;
    sessions: Awaited<ReturnType<typeof searchSessionChunks>>;
    collections: Awaited<ReturnType<typeof searchCollectionChunks>>;
    query?: string;
    sessionKey?: string;
  }): SearchResult[] {
    const byKey = new Map<string, SearchResult>();
    const atomicIds = new Set(options.atomic.map((item) => item.id).filter(Boolean) as string[]);

    for (const result of options.atomic) {
      // Trust weighting: multiply score by normalized confidence so
      // high-confidence facts beat lower-confidence duplicates when BM25 ties.
      // Temporal decay: apply mild exponential decay (7-day half-life,
      // floor 0.80) so entries from prior runs score below freshly stored ones,
      // helping collision-group detection pick the correct newest entry.
      const conf = typeof result.confidence === "number" ? Math.min(1, Math.max(0, result.confidence)) : 0.8;
      const trustMultiplier = 0.7 + 0.3 * conf; // 0.70 at conf=0 → 1.0 at conf=1
      const ageMs = Math.max(0, Date.now() - (Date.parse(String(result.lastReinforcedAt || "")) || Date.now()));
      const ageInDays = ageMs / 86_400_000;
      const ATOMIC_HALF_LIFE_DAYS = 7;
      const decayMultiplier = Math.max(0.80, Math.pow(0.5, ageInDays / ATOMIC_HALF_LIFE_DAYS));
      byKey.set(`atomic:${result.id}`, {
        ...result,
        score: result.score * trustMultiplier * decayMultiplier * applyLaneScoreMultiplier(options.query || "", result),
      });
    }

    for (const item of options.workspace) {
      const normalizedPath = item.path.replace(/\\/g, "/");
      const isDailyJournal = /(^|\/)memories?\/\d{4}-\d{2}-\d{2}\.md$/i.test(normalizedPath);
      const isEvergreenMd = normalizedPath.endsWith("MEMORY.md") || normalizedPath.endsWith("memory.md");
      // Skip superseded/deleted entries from MEMORY.md so stale identifiers never surface in search results
      if (isEvergreenMd && /\bstatus=(?:replaced|deleted)\b/.test(item.content)) {
        continue;
      }
      // Retrieval-staging principle: daily journals are audit logs with no status tracking.
      // For exact-identifier queries, skip them entirely — only atomic entries and active MEMORY.md
      // entries are authoritative. Without this, old journal chunks listing every historical token
      // (OLD/MID/NEW) can surface and confuse the LLM into citing a stale value.
      if (isDailyJournal && options.query && queryTargetsExactIdentifier(options.query)) {
        continue;
      }
      const referencedAtomicIds = Array.from(item.content.matchAll(/\bid=(mem_[A-Za-z0-9_-]+)\b/g)).map((match) => match[1]);
      if (referencedAtomicIds.some((id) => atomicIds.has(id))) {
        continue;
      }
      const normalizedScore = Math.max(0.05, Math.min(0.95, item.score));

      // Source-tier multipliers: atomic entries are the ground truth (1.0×).
      // MEMORY.md holds durable curated facts → slight boost.
      // Daily journals are audit-only (normally filtered before this point, but
      //   handled here defensively) → age-based exponential decay with 30-day half-life.
      // Other workspace topic files → mild penalty vs direct atomic facts.
      let multiplier: number;
      if (isEvergreenMd) {
        multiplier = 1.15;
      } else if (isDailyJournal) {
        const dateMatch = normalizedPath.match(/(\d{4}-\d{2}-\d{2})\.md$/i);
        const fileDate = dateMatch ? Date.parse(dateMatch[1]) : NaN;
        const ageInDays = Number.isFinite(fileDate) ? Math.max(0, (Date.now() - fileDate) / 86_400_000) : 0;
        const decayFactor = Math.exp(-Math.LN2 * ageInDays / 30);
        multiplier = 0.60 * decayFactor; // fresh journal ≤ 0.60×; 30-day-old ≤ 0.30×
      } else {
        multiplier = 0.82; // non-daily workspace topic files: slight penalty vs atomic
      }

      byKey.set(`workspace:${item.path}:${item.startLine}`, {
        path: item.path,
        content: item.content,
        score: Math.max(0.01, normalizedScore * multiplier * applyLaneScoreMultiplier(options.query || "", {
          path: item.path,
          content: item.content,
        })),
        source: "workspace",
        startLine: item.startLine,
        endLine: item.endLine,
      });
    }

    for (const item of options.sessions) {
      const sessionScoreMultiplier = item.sessionId === options.sessionKey ? 1.12 : 1;
      byKey.set(`session:${item.id}`, {
        path: `session:${item.sessionId}#chunk-${item.chunkIndex + 1}`,
        content: item.chunkText,
        score: (item.score ?? 0.5) * sessionScoreMultiplier * applyLaneScoreMultiplier(options.query || "", {
          path: `session:${item.sessionId}#chunk-${item.chunkIndex + 1}`,
          content: item.chunkText,
          sessionId: item.sessionId,
        }),
        source: "session",
        sessionId: item.sessionId,
      });
    }

    for (const item of options.collections) {
      const basename = path.basename(item.filePath);
      const atomicFileMatch = basename.match(/^(mem_[A-Za-z0-9_-]+)\.md$/);
      if (atomicFileMatch && atomicIds.has(atomicFileMatch[1])) {
        continue;
      }
      const normalizedPath = item.filePath.replace(/\\/g, "/");
      const isDailyJournal = /(^|\/)memories?\/\d{4}-\d{2}-\d{2}\.md$/i.test(normalizedPath);
      if (isDailyJournal) {
        continue;
      }
      // Skip superseded/deleted MEMORY.md collection chunks so stale identifiers never surface.
      const isEvergreenChunk = normalizedPath.endsWith("MEMORY.md") || normalizedPath.endsWith("memory.md");
      if (isEvergreenChunk && /\bstatus=(?:replaced|deleted)\b/.test(item.chunkText)) {
        continue;
      }
      // Skip collection chunks that are just echoing atomic entries already in the result set.
      // Workspace files like MEMORY.md record entries in the format "id=mem_XXX ..." —
      // if any referenced ID is already covered by an atomic result, the chunk adds no new
      // information and would surface stale identifier values alongside the fresh atomic results.
      const referencedAtomicIds = Array.from(item.chunkText.matchAll(/\bid=(mem_[A-Za-z0-9_-]+)\b/g)).map((m) => m[1]);
      if (referencedAtomicIds.some((id) => atomicIds.has(id))) {
        continue;
      }
      byKey.set(`collection:${item.id}`, {
        path: item.filePath,
        content: item.chunkText,
        score: Math.max(0.01, (item.score ?? 0.5) * 0.88 * applyLaneScoreMultiplier(options.query || "", {
          path: item.filePath,
          content: item.chunkText,
        })), // slight penalty vs atomic facts
        source: "collection",
        contextText: item.contextText,
      });
    }

    // Atomic collision deduplication: group atomic entries that contain identifier tokens
    // by stripped subject key and keep only the newest from each group. This runs before
    // the rerank pipeline so the reranker never sees stale collision copies that would
    // otherwise compete with the freshly-stored current-run entry.
    // Without this, 30+ near-identical-scoring entries from prior test runs overwhelm the
    // BM25 candidate pool and the reranker picks an arbitrary (often old) entry as winner.
    const atomicKeys = Array.from(byKey.entries())
      .filter(([k, entry]) => k.startsWith("atomic:") && extractIdentifierValues(entry.content).length > 0);
    if (atomicKeys.length >= 2) {
      const atomicGroups = new Map<string, Array<{ mapKey: string; entry: SearchResult }>>();
      for (const [mapKey, entry] of atomicKeys) {
        const subjectKey = stripIdentifiersForSubjectKey(entry.content);
        if (!subjectKey || subjectKey.replace(/\s/g, "").length < 3) continue;
        const bucket = atomicGroups.get(subjectKey);
        if (bucket) bucket.push({ mapKey, entry });
        else atomicGroups.set(subjectKey, [{ mapKey, entry }]);
      }
      for (const group of atomicGroups.values()) {
        if (group.length < 2) continue;
        // Sort newest-first; keep only [0], remove the rest from byKey.
        group.sort((a, b) => {
          const aTs = Date.parse(String(a.entry.lastReinforcedAt || "")) || 0;
          const bTs = Date.parse(String(b.entry.lastReinforcedAt || "")) || 0;
          return bTs - aTs; // descending: newest first
        });
        for (const { mapKey } of group.slice(1)) {
          byKey.delete(mapKey);
        }
      }
    }

    return Array.from(byKey.values()).sort((a, b) => {
      const scoreDiff = b.score - a.score;
      // Break near-equal score ties for atomic entries by recency (newest first).
      // This ensures entries stored more recently rank ahead of older copies when
      // BM25/hybrid scores are virtually identical (e.g. entries stored milliseconds apart).
      if (Math.abs(scoreDiff) < 1e-4 && a.source === "atomic" && b.source === "atomic") {
        const aTs = Date.parse(String(a.lastReinforcedAt || "")) || 0;
        const bTs = Date.parse(String(b.lastReinforcedAt || "")) || 0;
        if (bTs !== aTs) return bTs - aTs;
      }
      return scoreDiff;
    });
  }

  private async runUnifiedSearch(
    query: string,
    candidateCount: number,
    queryEmbedding: number[] | null,
    sessionKey?: string,
    plan?: LaneSearchPlan,
    visibility?: MemoryVisibility,
  ): Promise<SearchResult[]> {
    return this.runSearchPlan(
      query,
      candidateCount,
      queryEmbedding,
      sessionKey,
      plan ?? this.resolveLaneSearchPlan("persistent_facts", false),
      visibility,
    );
  }

  private markDirty(reason: string): void {
    this.dirty = true;
    this.lastSyncReason = reason;
  }

  scheduleSessionIndex(sessionId: string, reason = "message"): void {
    this.sessionsDirty = true;
    this.sessionDirtyIds.add(sessionId);
    const existing = this.sessionTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.sessionTimers.delete(sessionId);
      void this.enqueueJob({
        kind: "session-delta",
        key: `session:${sessionId}`,
        execute: async () => this.runSessionDeltaSync(sessionId, reason),
      });
    }, SESSION_DEBOUNCE_MS);
    this.sessionTimers.set(sessionId, timer);
  }

  async warmSession(sessionId?: string): Promise<void> {
    const key = String(sessionId || "").trim();
    if (!key || this.warmSessions.has(key)) return;
    this.warmSessions.add(key);
    this.scheduleSessionIndex(key, "session-start");
  }

  private async scheduleWorkspaceFile(filePath: string): Promise<boolean> {
    return this.enqueueJob<boolean>({
      kind: "workspace-file",
      key: `workspace:${filePath}`,
      execute: async () => {
        // Index lexically first so watcher-driven changes become searchable
        // even if embedding refresh is slow or temporarily unavailable.
        let changed = await indexSingleFile(filePath, null, this.agentId);
        try {
          const model = await this.getResolvedEmbeddingModel();
          if (model) {
            const embeddedChanged = await indexSingleFile(filePath, model, this.agentId, {
              forceReindex: changed,
            });
            changed = changed || embeddedChanged;
          }
        } catch (error) {
          log.warn("Workspace watcher embedding refresh failed; lexical index kept", {
            filePath,
            error: String(error),
          });
        }
        if (changed) {
          this.dirty = false;
          this.lastSyncAt = new Date().toISOString();
          this.lastSyncReason = "workspace-change";
        }
        return changed;
      },
    });
  }

  private async runSessionDeltaSync(sessionId: string, reason: string): Promise<{ newMessages: number; chunks: number }> {
    const model = await this.getResolvedEmbeddingModel();
    const result = await indexSessionDelta(sessionId, model, this.agentId);
    if (result.newMessages > 0 || result.chunks > 0) {
      this.lastSyncAt = new Date().toISOString();
      this.lastSyncReason = reason;
    }
    this.sessionDirtyIds.delete(sessionId);
    this.sessionsDirty = this.sessionDirtyIds.size > 0;
    return result;
  }

  private async runCollectionsSync(reason: string): Promise<{ indexed: number }> {
    const model = await this.getResolvedEmbeddingModel();
    const result = await indexCollections(model, this.agentId);
    this.dirty = false;
    this.lastSyncAt = new Date().toISOString();
    this.lastSyncReason = reason;
    return result;
  }

  async sync(params?: { reason?: string }): Promise<{ collectionsIndexed: number; sessionsIndexed: number; sessionChunks: number }> {
    await this.ensureRuntimeStarted();
    const reason = params?.reason || "manual";
    let collectionsIndexed = 0;
    let sessionsIndexed = 0;
    let sessionChunks = 0;

    if (this.dirty) {
      const collections = await this.enqueueJob<{ indexed: number }>({
        kind: "sync-collections",
        key: `collections:${this.agentId}`,
        execute: async () => this.runCollectionsSync(reason),
      });
      collectionsIndexed = collections.indexed;
    }

    if (this.sessionsDirty && this.sessionDirtyIds.size > 0) {
      const ids = Array.from(this.sessionDirtyIds);
      for (const sessionId of ids) {
        const result = await this.enqueueJob<{ newMessages: number; chunks: number }>({
          kind: "session-delta",
          key: `session:${sessionId}`,
          execute: async () => this.runSessionDeltaSync(sessionId, reason),
        });
        if (result.newMessages > 0) sessionsIndexed += 1;
        sessionChunks += result.chunks;
      }
    }

    return { collectionsIndexed, sessionsIndexed, sessionChunks };
  }

  async indexSessions(): Promise<{ sessions: number; chunks: number }> {
    await this.ensureRuntimeStarted();
    return this.enqueueJob({
      kind: "sync-sessions",
      key: `sessions:${this.agentId}`,
      execute: async () => {
        const model = await this.getResolvedEmbeddingModel();
        const result = await indexAllSessions(model, undefined, undefined, this.agentId);
        this.sessionsDirty = false;
        this.sessionDirtyIds.clear();
        this.lastSyncAt = new Date().toISOString();
        this.lastSyncReason = "manual-index-sessions";
        return result;
      },
    });
  }

  async indexCollections(): Promise<{ indexed: number }> {
    await this.ensureRuntimeStarted();
    return this.enqueueJob({
      kind: "sync-collections",
      key: `collections:${this.agentId}`,
      execute: async () => this.runCollectionsSync("manual-index-collections"),
    });
  }

  async rebuildAtomicIndex(): Promise<{
    ftsRebuilt: number;
    embeddingsGenerated: number;
    embeddingModel: string | null;
  }> {
    await this.ensureRuntimeStarted();
    return this.enqueueJob({
      kind: "rebuild-atomic",
      key: `atomic:${this.agentId}`,
      execute: async () => {
        const db = getSqlite();
        const model = await this.getResolvedEmbeddingModel();
        db.prepare("DELETE FROM memories_fts").run();
        const allEntries = await this.simple.getAll();
        for (const entry of allEntries) {
          try {
            db.prepare("INSERT OR REPLACE INTO memories_fts (id, content, tags, type) VALUES (?, ?, ?, ?)")
              .run(entry.id, entry.content, entry.tags.join(", "), entry.type);
            db.prepare("INSERT OR REPLACE INTO memory_atomic_scope (id, agent_id, updated_at) VALUES (?, ?, ?)")
              .run(entry.id, this.agentId, entry.updated);
          } catch {
            // non-fatal
          }
        }

        let embeddingCount = 0;
        if (model) {
          const batchSize = 16;
          for (let start = 0; start < allEntries.length; start += batchSize) {
            const batch = allEntries.slice(start, start + batchSize);
            const embeddings = await generateEmbeddingsBatch(batch.map((entry) => entry.content), model, batchSize);
            for (let index = 0; index < batch.length; index++) {
              const entry = batch[index]!;
              const contentHash = entry.contentHash ?? computeAtomicContentHash(entry.content, entry.type);
              const result =
                embeddings[index] ??
                await getOrGenerateEmbedding(entry.id, entry.content, contentHash, model, this.agentId);
              if (result) {
                storeEmbedding(entry.id, contentHash, result, model, this.agentId);
                embeddingCount += 1;
              }
            }
          }
        }

        this.lastSyncAt = new Date().toISOString();
        this.lastSyncReason = "manual-rebuild-index";
        return {
          ftsRebuilt: allEntries.length,
          embeddingsGenerated: embeddingCount,
          embeddingModel: model?.modelId ?? null,
        };
      },
    });
  }

  private enqueueJob<T>(params: {
    kind: MemoryJobKind;
    key: string;
    execute: () => Promise<T>;
  }): Promise<T> {
    const existing = this.inflightJobs.get(params.key);
    if (existing) return existing as Promise<T>;

    const queuedAt = new Date().toISOString();
    this.jobCounts.queued += 1;

    const pending = this.jobChain.then(async () => {
      const summary: MemoryJobSummary = {
        kind: params.kind,
        key: params.key,
        status: "running",
        queuedAt,
        startedAt: new Date().toISOString(),
      };
      this.jobCounts.running += 1;
      this.activeJobs.set(params.key, summary);
      try {
        const result = await params.execute();
        summary.status = "completed";
        summary.finishedAt = new Date().toISOString();
        this.jobCounts.completed += 1;
        this.lastCompletedJob = { ...summary };
        return result;
      } catch (error) {
        summary.status = "failed";
        summary.finishedAt = new Date().toISOString();
        summary.error = String(error);
        this.jobCounts.failed += 1;
        this.lastFailedJob = { ...summary };
        this.recordRuntimeFailure(String(error));
        throw error;
      } finally {
        this.jobCounts.queued = Math.max(0, this.jobCounts.queued - 1);
        this.jobCounts.running = Math.max(0, this.jobCounts.running - 1);
        this.activeJobs.delete(params.key);
        this.inflightJobs.delete(params.key);
      }
    });

    this.inflightJobs.set(params.key, pending);
    this.jobChain = pending.then(() => undefined, () => undefined);
    return pending;
  }

  getRuntimeStatus(): RuntimeStatus {
    const watcher = getWorkspaceWatcherStatus({
      agentId: this.agentId,
      workspacePath: this.workspacePath,
    });
    const sessionState = getSessionIndexStateSummary(this.agentId);
    return {
      started: this.runtimeStarted,
      startedAt: watcher.startedAt,
      dirty: this.dirty,
      sessionsDirty: this.sessionsDirty,
      lastSyncAt: this.lastSyncAt,
      lastSyncReason: this.lastSyncReason,
      lastFailure: this.lastFailure,
      providerFailures: this.providerFailures.slice(-MAX_PROVIDER_FAILURES_IN_DIAGNOSTICS),
      providerHealth: this.getProviderHealthSnapshot(),
      providerBatchHealth: getEmbeddingBatchHealthSnapshot(),
      watcher,
      sessions: {
        pending: Array.from(this.sessionDirtyIds),
        warmCount: this.warmSessions.size,
        trackedCount: sessionState.trackedSessions,
        lastIndexedAt: sessionState.lastIndexedAt,
      },
      jobs: {
        queued: this.jobCounts.queued,
        running: this.jobCounts.running,
        completed: this.jobCounts.completed,
        failed: this.jobCounts.failed,
        active: Array.from(this.activeJobs.values()),
        lastCompleted: this.lastCompletedJob,
        lastFailed: this.lastFailedJob,
      },
      isolation: {
        atomicFtsScoped: true,
        workspaceScoped: true,
        sessionScoped: true,
        collectionScoped: true,
      },
      recovery: getSqliteRecoveryStatus(),
    };
  }

  async getStatus() {
    await this.ensureRuntimeStarted();
    const configured = getConfiguredEmbeddingModelId();
    await isSqliteVecReady();
    const providerPlan = this.getProviderPlan(configured);
    const searchPolicy = loadSearchPolicyConfig();
    return {
      configured,
      active: providerPlan.active,
      vectorIndexed: countEmbeddings(this.agentId),
      sessionChunks: getSessionChunkCount(this.agentId),
      collectionChunks: getCollectionChunkCount(this.agentId),
      mode: providerPlan.mode,
      vectorBackend: serializeVectorBackendStatus(),
      providerPlan: {
        configured: providerPlan.configured,
        mode: providerPlan.mode,
        actualMode: providerPlan.mode,
        active: providerPlan.active,
        candidates: providerPlan.candidates,
        selected: providerPlan.active
          ? { provider: providerPlan.active.provider, modelId: providerPlan.active.modelId, source: "primary" }
          : null,
        fallbackCount: providerPlan.fallbackCount,
        unavailableReason: providerPlan.unavailableReason,
      },
      searchPolicy,
      runtime: this.getRuntimeStatus(),
      agentId: this.agentId,
    };
  }

  async search(options: {
    query: string;
    limit: number;
    minScore: number;
    mode: MemorySearchMode;
    debug?: boolean;
    sessionKey?: string;
    lane?: MemoryLane;
    /** Authoritative runtime scope. Never sourced from model arguments. */
    visibility?: MemoryVisibility;
  }): Promise<{ data: SearchResult[]; diagnostics: SearchDiagnostics | null }> {
    const visibility = options.visibility;
    if (visibility?.kind === "none") return { data: [], diagnostics: null };
    await this.ensureRuntimeStarted();
    if (options.sessionKey) {
      await this.warmSession(options.sessionKey);
    }
    if (this.dirty || this.sessionsDirty) {
      void this.sync({ reason: "search" });
    }

    const totalStartedAt = Date.now();
    const query = options.query.trim();
    if (!query) return { data: [], diagnostics: null };
    const preferredLane = options.lane ?? inferPreferredMemoryLane(query);

    const searchPolicy = loadSearchPolicyConfig();
    const candidateCount = Math.max(options.limit * 3, 12);
    const preferredPlan = this.resolveLaneSearchPlan(preferredLane, true);
    const fallbackPlan = this.resolveLaneSearchPlan(preferredLane, false);
    const embedStartedAt = Date.now();
    const primaryEmbedding = await this.embedQueryWithFallback(query);
    const embedElapsedMs = Date.now() - embedStartedAt;

    const primarySearchStartedAt = Date.now();
    const primaryPreferred = await this.runUnifiedSearch(
      query,
      candidateCount,
      primaryEmbedding.embedding,
      options.sessionKey,
      preferredPlan,
      visibility,
    );
    const shouldBroadenPrimary =
      primaryPreferred.length < Math.max(options.limit, 4) || preferredLane !== "persistent_facts";
    const primaryFallback = shouldBroadenPrimary
      ? await this.runUnifiedSearch(
          query,
          candidateCount,
          primaryEmbedding.embedding,
          options.sessionKey,
          fallbackPlan,
          visibility,
        )
      : [];
    const primary = primaryFallback.length > 0
      ? reciprocalRankFusion([primaryPreferred, primaryFallback], Math.max(candidateCount * 2, 20))
      : primaryPreferred;
    const primarySearchElapsedMs = Date.now() - primarySearchStartedAt;

    const lexicalProbe = searchPolicy.strongSignalEnabled
      ? await this.runLexicalProbe(query, Math.max(options.limit, 4), options.sessionKey, preferredPlan, visibility)
      : [];
    const lexicalProbeResults =
      searchPolicy.strongSignalEnabled && lexicalProbe.length < Math.max(Math.min(options.limit, 2), 1)
        ? await this.runLexicalProbe(query, Math.max(options.limit, 4), options.sessionKey, fallbackPlan, visibility)
        : [];
    const mergedLexicalProbe = lexicalProbeResults.length > 0
      ? reciprocalRankFusion([lexicalProbe, lexicalProbeResults], Math.max(options.limit * 2, 8))
      : lexicalProbe;
    const strongSignal = searchPolicy.strongSignalEnabled
      ? this.isStrongLexicalSignal(query, mergedLexicalProbe.length > 0 ? mergedLexicalProbe : primary, options.limit)
      : false;

    const expansionStartedAt = Date.now();
    const queryAssist =
      searchPolicy.backend === "qmd-like" && searchPolicy.queryExpansionEnabled && !strongSignal
        ? await this.planQueryVariants(query)
        : { rewrittenQuery: null, variants: [] };
    const expandedQueries = queryAssist.variants;
    const expansionElapsedMs = Date.now() - expansionStartedAt;
    const activeChatModel = loadActiveChatModel();

    const fusedLists = [primary];
    const exactIdentifierVariant = buildIdentifierQueryVariant(query);
    const assistedQueries = [
      ...(exactIdentifierVariant ? [exactIdentifierVariant] : []),
      ...(queryAssist.rewrittenQuery ? [queryAssist.rewrittenQuery] : []),
      ...expandedQueries,
    ].filter((variant, index, all) => all.findIndex((item) => item.toLowerCase() === variant.toLowerCase()) === index);
    for (const variant of assistedQueries) {
      const variantEmbedding = await this.embedQueryWithFallback(variant);
      const variantPreferred = await this.runUnifiedSearch(
        variant,
        Math.max(options.limit * 2, 8),
        variantEmbedding.embedding,
        options.sessionKey,
        preferredPlan,
        visibility,
      );
      const variantFallback = variantPreferred.length > 0
        ? []
        : await this.runUnifiedSearch(
            variant,
            Math.max(options.limit * 2, 8),
            variantEmbedding.embedding,
            options.sessionKey,
            fallbackPlan,
            visibility,
          );
      const variantResults = variantFallback.length > 0
        ? reciprocalRankFusion([variantPreferred, variantFallback], Math.max(options.limit * 2, 12))
        : variantPreferred;
      if (variantResults.length) fusedLists.push(variantResults);
    }

    let merged = reciprocalRankFusion(fusedLists, Math.max(candidateCount * 2, 20));
    if (merged.length > 1) {
      const preferred = merged.filter((entry) => inferMemoryLaneFromCandidate(entry) === preferredLane);
      const other = merged.filter((entry) => inferMemoryLaneFromCandidate(entry) !== preferredLane);
      if (preferred.length > 0) {
        merged = [...preferred, ...other];
      }
    }
    const preFilterCandidates = merged.length;
    if (options.minScore > 0) {
      merged = merged.filter((entry) => entry.score >= options.minScore);
    }
    const postFilterCandidates = merged.length;

    const rerankStartedAt = Date.now();
    const rerankPlan = this.resolveRerankPlan(options, searchPolicy, activeChatModel, primaryEmbedding.model);
    let rerankStrategy: SearchDiagnostics["rerankStrategy"] = rerankPlan.strategy;
    let rerankModel: { provider: string; modelId: string } | null = rerankPlan.model;
    const shortlistBase =
      searchPolicy.backend === "qmd-like"
        ? merged.slice(0, Math.min(searchPolicy.rerankCandidateLimit, Math.max(options.limit * 4, options.limit)))
        : merged.slice(0, Math.min(Math.max(options.limit * 4, 12), merged.length));
    const chunkedCandidates =
      searchPolicy.backend === "qmd-like" ? shortlistBase.map((item) => pickBestChunkForQuery(query, item)) : shortlistBase;

    let rerankedResults: RerankResult[];
    if (rerankPlan.strategy === "model" && activeChatModel) {
      rerankedResults = await this.rerankWithModel(query, chunkedCandidates, activeChatModel);
    } else if (rerankPlan.strategy === "local") {
      const localRerank = await this.rerankLocally(query, chunkedCandidates, rerankPlan.localModel ?? primaryEmbedding.model);
      rerankedResults = localRerank.data;
      rerankModel = localRerank.model ? { provider: localRerank.model.provider, modelId: localRerank.model.modelId } : rerankModel;
      if (!localRerank.model && rerankPlan.strategy === "local") {
        rerankStrategy = "mmr";
      }
    } else if (rerankPlan.strategy === "mmr") {
      rerankedResults = toRerankScores(mmrRerank(chunkedCandidates, chunkedCandidates.length, searchPolicy.backend === "qmd-like" ? 0.72 : 0.6));
    } else {
      rerankedResults = chunkedCandidates.map((item) => ({
        item,
        rerankScore: clamp01(item.score),
      }));
    }

    let ranked: SearchResult[];
    if (searchPolicy.backend === "qmd-like") {
      ranked =
        rerankStrategy === "off"
          ? chunkedCandidates.slice(0, options.limit)
          : applyPositionAwareBlend(query, rerankedResults, merged).slice(0, options.limit);
    } else if (rerankStrategy === "mmr") {
      ranked = mmrRerank(merged, options.limit);
    } else if (rerankStrategy === "off") {
      ranked = merged.slice(0, options.limit);
    } else {
      ranked = rerankedResults
        .sort((a, b) => b.rerankScore - a.rerankScore)
        .slice(0, options.limit)
        .map(({ item, rerankScore }) => ({ ...item, score: clamp01(rerankScore * 0.8 + item.score * 0.2) }));
    }
    ranked = reorderIdentifierFocusedResults(query, ranked);
    const rerankElapsedMs = Date.now() - rerankStartedAt;
    const actualMode = primaryEmbedding.embedding ? primaryEmbedding.providerPlan.mode : "fts5-only";

    const diagnostics: SearchDiagnostics | null = options.debug
      ? {
          query,
          strongSignal,
          rewrittenQuery: queryAssist.rewrittenQuery,
          expandedQueries,
          candidateCount,
          sourceCounts: ranked.reduce<Record<string, number>>((acc, item) => {
            acc[item.source] = (acc[item.source] ?? 0) + 1;
            return acc;
          }, {}),
          vectorBackend: serializeVectorBackendStatus(),
          providerPlan: {
            configured: primaryEmbedding.providerPlan.configured,
            mode: primaryEmbedding.providerPlan.mode,
            actualMode,
            active: primaryEmbedding.providerPlan.active,
            candidates: primaryEmbedding.providerPlan.candidates,
            selected: primaryEmbedding.selected,
            fallbackCount: primaryEmbedding.providerPlan.fallbackCount,
            unavailableReason: primaryEmbedding.failureReason ?? primaryEmbedding.providerPlan.unavailableReason,
          },
          searchPolicy,
          rerankStrategy,
          rerankModel,
          queryEmbeddingProvider: primaryEmbedding.model?.provider ?? null,
          agentId: this.agentId,
          workspacePath: this.workspacePath,
          timingsMs: {
            embed: embedElapsedMs,
            primarySearch: primarySearchElapsedMs,
            queryExpansion: expansionElapsedMs,
            rerank: rerankElapsedMs,
            total: Date.now() - totalStartedAt,
          },
          explain: {
            searchBackend: searchPolicy.backend,
            fusedListCount: fusedLists.length,
            preFilterCandidates,
            postFilterCandidates,
            rrfK: RRF_K,
            chunkedRerank: searchPolicy.backend === "qmd-like",
            positionAwareBlend: searchPolicy.backend === "qmd-like" && rerankStrategy !== "off",
            rerankCandidateLimit: searchPolicy.rerankCandidateLimit,
            backendDefaultRerank:
              options.mode === "gpt" && activeChatModel
                ? "model"
                : searchPolicy.backend === "qmd-like" && this.getLocalRerankModel(primaryEmbedding.model)
                  ? "local"
                  : "mmr",
            autoResolvedStrategy: rerankPlan.strategy,
            expansionSkipped: strongSignal,
          },
          runtime: this.getRuntimeStatus(),
        }
      : null;

    return { data: ranked, diagnostics };
  }

  async getDiagnosticsSummary() {
    await this.ensureRuntimeStarted();
    await isSqliteVecReady();
    const configured = getConfiguredEmbeddingModelId();
    const providerPlan = this.getProviderPlan(configured);
    const searchPolicy = loadSearchPolicyConfig();
    return {
      agentId: this.agentId,
      workspacePath: this.workspacePath,
      embeddingModel: configured,
      vectorBackend: serializeVectorBackendStatus(),
      vectorIndexed: countEmbeddings(this.agentId),
      sessionChunks: getSessionChunkCount(this.agentId),
      collectionChunks: getCollectionChunkCount(this.agentId),
      pathContexts: listPathContexts(this.agentId).length,
      providerPlan: {
        configured: providerPlan.configured,
        mode: providerPlan.mode,
        actualMode: providerPlan.mode,
        active: providerPlan.active,
        candidates: providerPlan.candidates,
        selected: providerPlan.active
          ? { provider: providerPlan.active.provider, modelId: providerPlan.active.modelId, source: "primary" }
          : null,
        fallbackCount: providerPlan.fallbackCount,
        unavailableReason: providerPlan.unavailableReason,
      },
      searchPolicy,
      runtime: this.getRuntimeStatus(),
    };
  }
}
