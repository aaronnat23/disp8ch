// Server-only — do not import in client components.
import { getSqlite, withSqliteWriteRecovery } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import { resolveModelApiKey, resolveProviderEnvApiKey } from "@/lib/agents/provider-auth";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";
import { deleteMemoryVector, upsertMemoryVector } from "./sqlite-vec";
import crypto from "node:crypto";
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  generateLocalEmbeddings,
  isLocalEmbeddingModelId,
  normalizeLocalEmbeddingModelId,
} from "./local-transformers";

const log = logger.child("memory:embedding");

// NOTE: Embeddings are stored as JSON TEXT in SQLite (~12–15 KB per entry for
// 1536-dim models). Fine for <10K memories in single-user local-first use.

// ── Provider circuit breaker ────────────────────────────────────────────────
// When a provider fails (e.g. local Ollama isn't running and refuses
// connections), skip it for a short cooldown instead of blocking every
// embedding attempt on a fresh fetch + ECONNREFUSED. Bypasses the dominant
// chat-turn slowness when an unreachable provider is in the fallback list.

const PROVIDER_FAILURE_COOLDOWN_MS = 60_000;
const providerFailureTimestamps = new Map<string, number>();

function providerKey(model: EmbeddingModel): string {
  return `${model.provider}:${(model.baseUrl ?? "").toLowerCase()}:${model.modelId}`;
}

function isProviderInCooldown(model: EmbeddingModel): boolean {
  const ts = providerFailureTimestamps.get(providerKey(model));
  if (!ts) return false;
  if (Date.now() - ts > PROVIDER_FAILURE_COOLDOWN_MS) {
    providerFailureTimestamps.delete(providerKey(model));
    return false;
  }
  return true;
}

function markProviderFailed(model: EmbeddingModel): void {
  providerFailureTimestamps.set(providerKey(model), Date.now());
}

export interface EmbeddingModel {
  modelId: string;
  provider: string;
  apiKey: string;
  baseUrl?: string;
  cacheDir?: string;
  localOnly?: boolean;
}

export interface EmbeddingBatchHealth {
  provider: string;
  modelId: string;
  batchSuccesses: number;
  batchFailures: number;
  batchFallbacks: number;
  consecutiveBatchFailures: number;
  lastBatchSuccessAt: string | null;
  lastBatchFailureAt: string | null;
  lastBatchError: string | null;
}

type ActiveModelRow = Record<string, unknown>;
const batchHealth = new Map<string, EmbeddingBatchHealth>();

// Known embedding-capable model_id substrings in priority order.
const EMBEDDING_PRIORITY = [
  "gemini-embedding-001",
  "text-embedding-3-small",
  "text-embedding-3-large",
  "text-embedding-ada-002",
  "voyage-3-large",
  "voyage-3.5-lite",
  "mistral-embed",
  "codestral-embed",
  "text-embedding-004",
  "embedding-001",
  "nomic-embed-text",
  "mxbai-embed-large",
  "all-minilm",
  "bge-",
  "e5-",
];

function isEmbeddingModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return EMBEDDING_PRIORITY.some((p) => lower.includes(p));
}

function defaultEmbeddingModelForProvider(provider: string): string | null {
  const normalized = provider.toLowerCase();
  if (normalized === "gemini" || normalized === "google") return "gemini-embedding-001";
  if (normalized === "openai") return "text-embedding-3-small";
  if (normalized === "mistral") return "mistral-embed";
  if (normalized === "voyage") return "voyage-3.5-lite";
  if (normalized === "ollama") return "nomic-embed-text";
  if (normalized === "local") return DEFAULT_LOCAL_EMBEDDING_MODEL;
  return null;
}

function inferEmbeddingProviderFromModelId(modelId?: string | null): string | null {
  const lower = String(modelId || "").trim().toLowerCase();
  if (!lower) return null;
  if (isLocalEmbeddingModelId(lower)) return "local";
  if (
    lower.includes("gemini-embedding-001") ||
    lower.includes("text-embedding-004") ||
    lower.includes("embedding-001")
  ) {
    return "google";
  }
  if (lower.includes("text-embedding-3") || lower.includes("ada-002")) {
    return "openai";
  }
  if (lower.includes("voyage-")) {
    return "voyage";
  }
  if (lower.includes("mistral-embed") || lower.includes("codestral-embed")) {
    return "mistral";
  }
  if (
    lower.includes("nomic") ||
    lower.includes("mxbai") ||
    lower.includes("minilm") ||
    lower.includes("bge-") ||
    lower.includes("e5-")
  ) {
    return "ollama";
  }
  return null;
}

function chooseCredentialSource(rows: ActiveModelRow[], explicitModelId?: string): ActiveModelRow | null {
  if (!rows.length) return null;
  if (!explicitModelId || explicitModelId === "auto" || explicitModelId === "disabled") {
    return null;
  }
  const lower = explicitModelId.toLowerCase();
  if (
    lower.includes("gemini-embedding-001") ||
    lower.includes("text-embedding-004") ||
    lower.includes("embedding-001")
  ) {
    return rows.find((row) => String(row.provider).toLowerCase() === "google") ?? null;
  }
  if (lower.includes("text-embedding-3") || lower.includes("ada-002")) {
    return rows.find((row) => String(row.provider).toLowerCase() === "openai") ?? null;
  }
  if (lower.includes("voyage-")) {
    return rows.find((row) => String(row.provider).toLowerCase() === "voyage") ?? null;
  }
  if (lower.includes("mistral-embed") || lower.includes("codestral-embed")) {
    return rows.find((row) => String(row.provider).toLowerCase() === "mistral") ?? null;
  }
  if (
    lower.includes("nomic") ||
    lower.includes("mxbai") ||
    lower.includes("minilm") ||
    lower.includes("bge-") ||
    lower.includes("e5-")
  ) {
    return rows.find((row) => String(row.provider).toLowerCase() === "ollama") ?? null;
  }
  if (lower === "local" || lower.startsWith("local:") || lower.startsWith("local-only:")) {
    return rows.find((row) => String(row.provider).toLowerCase() === "local") ?? null;
  }
  return null;
}

function toEmbeddingModel(target: ActiveModelRow, modelIdOverride?: string): EmbeddingModel {
  const rawProvider = String(target.provider || "").trim().toLowerCase();
  const provider = normalizeProviderId(target.provider as string) ?? (rawProvider === "local" ? "local" : String(target.provider));
  if (provider === "local") {
    const normalized = normalizeLocalEmbeddingModelId(modelIdOverride || String(target.model_id || ""));
    return {
      modelId: normalized.modelId,
      provider,
      apiKey: "",
      cacheDir: normalized.cacheDir,
      localOnly: normalized.localOnly,
    };
  }
  const auth = resolveModelApiKey({ provider, storedApiKey: target.api_key as string });
  const baseUrl = normalizeProviderBaseUrl(
    provider,
    (target.base_url as string | undefined) || undefined
  );
  const currentModelId = String(target.model_id || "");
  const preferredModelId =
    modelIdOverride ||
    (isEmbeddingModel(currentModelId)
      ? currentModelId
      : defaultEmbeddingModelForProvider(provider) || currentModelId);

  return {
    modelId: preferredModelId,
    provider,
    apiKey: auth.apiKey,
    baseUrl,
  };
}

function getActiveModelRows(): ActiveModelRow[] {
  const db = getSqlite();
  return db
    .prepare("SELECT * FROM models WHERE is_active = 1 ORDER BY priority DESC")
    .all() as ActiveModelRow[];
}

function pushUniqueCandidate(
  output: EmbeddingModel[],
  candidate: EmbeddingModel | null,
): void {
  if (!candidate) return;
  const key = `${candidate.provider}:${candidate.modelId}:${candidate.baseUrl || ""}:${candidate.localOnly ? "local-only" : "default"}`;
  if (output.some((item) => `${item.provider}:${item.modelId}:${item.baseUrl || ""}:${item.localOnly ? "local-only" : "default"}` === key)) {
    return;
  }
  output.push(candidate);
}

function buildBatchHealthKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

function recordBatchSuccess(provider: string, modelId: string, fallbackUsed = false): void {
  const key = buildBatchHealthKey(provider, modelId);
  const now = new Date().toISOString();
  const existing = batchHealth.get(key);
  batchHealth.set(key, {
    provider,
    modelId,
    batchSuccesses: (existing?.batchSuccesses ?? 0) + 1,
    batchFailures: existing?.batchFailures ?? 0,
    batchFallbacks: (existing?.batchFallbacks ?? 0) + (fallbackUsed ? 1 : 0),
    consecutiveBatchFailures: 0,
    lastBatchSuccessAt: now,
    lastBatchFailureAt: existing?.lastBatchFailureAt ?? null,
    lastBatchError: existing?.lastBatchError ?? null,
  });
}

function recordBatchFailure(provider: string, modelId: string, error: string, fallbackUsed = false): void {
  const key = buildBatchHealthKey(provider, modelId);
  const now = new Date().toISOString();
  const existing = batchHealth.get(key);
  batchHealth.set(key, {
    provider,
    modelId,
    batchSuccesses: existing?.batchSuccesses ?? 0,
    batchFailures: (existing?.batchFailures ?? 0) + 1,
    batchFallbacks: (existing?.batchFallbacks ?? 0) + (fallbackUsed ? 1 : 0),
    consecutiveBatchFailures: (existing?.consecutiveBatchFailures ?? 0) + 1,
    lastBatchSuccessAt: existing?.lastBatchSuccessAt ?? null,
    lastBatchFailureAt: now,
    lastBatchError: error,
  });
}

export function getEmbeddingBatchHealthSnapshot(limit = 12): EmbeddingBatchHealth[] {
  return Array.from(batchHealth.values())
    .sort((a, b) => {
      const left = Date.parse(b.lastBatchFailureAt ?? b.lastBatchSuccessAt ?? "");
      const right = Date.parse(a.lastBatchFailureAt ?? a.lastBatchSuccessAt ?? "");
      return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
    })
    .slice(0, limit);
}

function hashApiKeyFingerprint(apiKey: string): string {
  if (!apiKey) return "none";
  return crypto.createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12);
}

export function getEmbeddingProviderKey(model: EmbeddingModel): string {
  const payload = [
    model.provider,
    model.modelId,
    model.baseUrl ?? "",
    model.cacheDir ?? "",
    model.localOnly ? "local-only" : "default",
    hashApiKeyFingerprint(model.apiKey),
  ].join("|");
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 24);
}

export function getEmbeddingModelCandidates(explicitModelId?: string): EmbeddingModel[] {
  const output: EmbeddingModel[] = [];

  if (isLocalEmbeddingModelId(explicitModelId)) {
    pushUniqueCandidate(output, getEmbeddingModel(explicitModelId));
    return output;
  }

  try {
    const rows = getActiveModelRows();
    const hasExplicitModel = Boolean(explicitModelId && explicitModelId !== "auto" && explicitModelId !== "disabled");
    const inferredProvider = hasExplicitModel ? inferEmbeddingProviderFromModelId(explicitModelId) : null;

    if (hasExplicitModel) {
      pushUniqueCandidate(output, getEmbeddingModel(explicitModelId));
      if (inferredProvider) {
        const fallbackRow = rows.find((row) => String(row.provider).toLowerCase() === inferredProvider) ?? null;
        if (fallbackRow) {
          pushUniqueCandidate(output, toEmbeddingModel(fallbackRow, explicitModelId));
        }
      }
    } else {
      pushUniqueCandidate(output, getEmbeddingModel(undefined));
    }

    for (const row of rows) {
      const provider = String(row.provider || "").trim().toLowerCase();
      const modelId = String(row.model_id || "");
      if (!provider) continue;
      if (!isEmbeddingModel(modelId) && !defaultEmbeddingModelForProvider(provider)) continue;
      pushUniqueCandidate(output, toEmbeddingModel(row));
    }

    for (const provider of ["google", "openai", "mistral", "voyage", "ollama"] as const) {
      if (output.some((item) => item.provider === provider)) continue;
      const defaultModel = defaultEmbeddingModelForProvider(provider);
      if (!defaultModel) continue;
      if (!resolveProviderEnvApiKey(provider) && provider !== "ollama") continue;
      pushUniqueCandidate(output, {
        provider,
        modelId: defaultModel,
        apiKey: resolveProviderEnvApiKey(provider)?.apiKey ?? "",
        baseUrl: normalizeProviderBaseUrl(provider, undefined),
      });
    }

    return output;
  } catch (err) {
    log.warn("Failed to enumerate embedding candidates", { error: String(err) });
    return output;
  }
}

/** Auto-detect the best embedding model from the models table.
 *  Returns null → FTS5-only mode (graceful fallback). */
export function getEmbeddingModel(explicitModelId?: string): EmbeddingModel | null {
  try {
    if (isLocalEmbeddingModelId(explicitModelId)) {
      const normalized = normalizeLocalEmbeddingModelId(explicitModelId);
      return {
        modelId: normalized.modelId,
        provider: "local",
        apiKey: "",
        cacheDir: normalized.cacheDir,
        localOnly: normalized.localOnly,
      };
    }

    const rows = getActiveModelRows();

    if (!rows.length) return null;

    let target: ActiveModelRow | null = null;
    const hasExplicitModel = Boolean(explicitModelId && explicitModelId !== "auto" && explicitModelId !== "disabled");
    const inferredProvider = hasExplicitModel ? inferEmbeddingProviderFromModelId(explicitModelId) : null;

    if (hasExplicitModel) {
      target = rows.find((r) => (r.model_id as string) === explicitModelId) ?? null;
      if (!target && inferredProvider) {
        target = rows.find((r) => String(r.provider).toLowerCase() === inferredProvider) ?? null;
      }
    }

    if (!target && !hasExplicitModel) {
      // Priority search: find the highest-priority known embedding model.
      for (const prefix of EMBEDDING_PRIORITY) {
        target = rows.find((r) => (r.model_id as string).toLowerCase().includes(prefix)) ?? null;
        if (target) break;
      }
    }

    if (!target && !hasExplicitModel) {
      // Fallback: look for known providers that support embeddings.
      target =
        rows.find((r) => (r.provider as string).toLowerCase() === "ollama") ??
        rows.find((r) => (r.provider as string).toLowerCase() === "mistral") ??
        rows.find((r) => (r.provider as string).toLowerCase() === "voyage") ??
        rows.find((r) => (r.provider as string).toLowerCase() === "openai") ??
        rows.find((r) => (r.provider as string).toLowerCase() === "google") ??
        rows.find((r) => (r.provider as string).toLowerCase() === "gemini") ??
        rows.find((r) => (r.provider as string).toLowerCase() === "local") ??
        null;
    }

    if (!target && hasExplicitModel) {
      target = chooseCredentialSource(rows, explicitModelId);
    }

    if (!target && hasExplicitModel) {
      if (inferredProvider === "ollama" || resolveProviderEnvApiKey(inferredProvider || "") || inferredProvider === "local") {
        target = {
          provider: inferredProvider,
          model_id: explicitModelId,
          api_key: "",
          base_url: undefined,
        };
      }
    }

    if (!target) return null;
    return toEmbeddingModel(target, explicitModelId && explicitModelId !== "auto" && explicitModelId !== "disabled" ? explicitModelId : undefined);
  } catch (err) {
    log.warn("Failed to detect embedding model", { error: String(err) });
    return null;
  }
}

/** Load the configured embedding model id from memory_config. */
export function getConfiguredEmbeddingModelId(): string {
  try {
    const db = getSqlite();
    const row = db
      .prepare("SELECT embedding_model FROM memory_config WHERE id = 'default'")
      .get() as { embedding_model?: string } | undefined;
    return row?.embedding_model ?? "auto";
  } catch {
    return "auto";
  }
}

/** Generate an embedding vector for the given text using fetch() (no extra packages). */
export async function generateEmbedding(
  text: string,
  model: EmbeddingModel
): Promise<number[] | null> {
  const trimmed = text.trim().slice(0, 8000); // guard against oversized inputs
  if (!trimmed) return null;

  // Skip providers that recently failed — avoids hammering an unreachable
  // local server (Ollama at localhost:11434 when it's not running) on every
  // chat turn.
  if (isProviderInCooldown(model)) {
    return null;
  }

  try {
    if (model.provider === "local") {
      const result = await generateLocalEmbeddings([trimmed], {
        modelId: model.modelId,
        cacheDir: model.cacheDir,
        localOnly: model.localOnly,
      });
      return result[0] ?? null;
    }

    if (model.provider === "ollama") {
      // Ollama embedding endpoint is POST /api/embed (NOT /v1/embeddings).
      // normalizeProviderBaseUrl appends /v1 for Ollama — strip it here.
      const ollamaBase = (model.baseUrl ?? "http://localhost:11434/v1").replace(/\/v1\/?$/i, "");
      const resp = await fetch(`${ollamaBase}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.modelId, input: trimmed }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        log.warn("Ollama embed request failed", { status: resp.status, modelId: model.modelId });
        markProviderFailed(model);
        return null;
      }
      const data = (await resp.json()) as { embeddings?: number[][] };
      return data.embeddings?.[0] ?? null;
    }

    if (model.provider === "gemini" || model.provider === "google") {
      // Gemini Embedding API: POST /v1beta/models/{model}:embedContent
      const modelId = model.modelId || "gemini-embedding-001";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:embedContent`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": model.apiKey,
        },
        body: JSON.stringify({
          model: `models/${modelId}`,
          content: { parts: [{ text: trimmed }] },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        log.warn("Gemini embed request failed", { status: resp.status, modelId });
        markProviderFailed(model);
        return null;
      }
      const data = (await resp.json()) as { embedding?: { values?: number[] } };
      return data.embedding?.values ?? null;
    }

    // OpenAI and OpenAI-compatible providers, including Mistral and Voyage.
    const base = (model.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const resp = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${model.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: model.modelId, input: trimmed }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      log.warn("Embedding API request failed", { status: resp.status, modelId: model.modelId });
      markProviderFailed(model);
      return null;
    }
    const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }>; embeddings?: number[][] };
    return data.data?.[0]?.embedding ?? data.embeddings?.[0] ?? null;
  } catch (err) {
    log.warn("Embedding generation failed", { modelId: model.modelId, error: String(err) });
    markProviderFailed(model);
    return null;
  }
}

export async function generateEmbeddingsBatch(
  texts: string[],
  model: EmbeddingModel,
  batchSize = 16,
): Promise<Array<number[] | null>> {
  const trimmed = texts.map((text) => text.trim().slice(0, 8000));
  const output: Array<number[] | null> = new Array(trimmed.length).fill(null);
  const pending = trimmed
    .map((text, index) => ({ text, index }))
    .filter((item) => item.text);

  if (!pending.length) return output;

  try {
    if (model.provider === "local") {
      const result = await generateLocalEmbeddings(trimmed, {
        modelId: model.modelId,
        cacheDir: model.cacheDir,
        localOnly: model.localOnly,
      });
      recordBatchSuccess(model.provider, model.modelId);
      return result;
    }

    if (model.provider === "gemini" || model.provider === "google") {
      const modelId = model.modelId || "gemini-embedding-001";
      let allBatchesSucceeded = true;
      for (let start = 0; start < pending.length; start += batchSize) {
        const batch = pending.slice(start, start + batchSize);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:batchEmbedContents`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": model.apiKey,
          },
          body: JSON.stringify({
            requests: batch.map((item) => ({
              model: `models/${modelId}`,
              content: { parts: [{ text: item.text }] },
            })),
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (!resp.ok) {
          log.warn("Gemini batch embed request failed; falling back to single embeds", {
            status: resp.status,
            modelId,
          });
          recordBatchFailure(model.provider, model.modelId, `http:${resp.status}`, true);
          allBatchesSucceeded = false;
          break;
        }
        const data = (await resp.json()) as { embeddings?: Array<{ values?: number[] }> };
        batch.forEach((item, index) => {
          output[item.index] = data.embeddings?.[index]?.values ?? null;
        });
      }
      if (!allBatchesSucceeded || output.some((item, index) => pending.some((p) => p.index === index) && item === null)) {
        for (const item of pending) {
          if (output[item.index] !== null) continue;
          output[item.index] = await generateEmbedding(item.text, model);
        }
        recordBatchSuccess(model.provider, model.modelId, true);
      } else {
        recordBatchSuccess(model.provider, model.modelId);
      }
      return output;
    }

    if (model.provider === "ollama") {
      const ollamaBase = (model.baseUrl ?? "http://localhost:11434/v1").replace(/\/v1\/?$/i, "");
      for (let start = 0; start < pending.length; start += batchSize) {
        const batch = pending.slice(start, start + batchSize);
        const resp = await fetch(`${ollamaBase}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: model.modelId, input: batch.map((item) => item.text) }),
          signal: AbortSignal.timeout(30000),
        });
        if (!resp.ok) {
          log.warn("Ollama batch embed request failed; falling back to single embeds", {
            status: resp.status,
            modelId: model.modelId,
          });
          recordBatchFailure(model.provider, model.modelId, `http:${resp.status}`, true);
          break;
        }
        const data = (await resp.json()) as { embeddings?: number[][] };
        batch.forEach((item, index) => {
          output[item.index] = data.embeddings?.[index] ?? null;
        });
      }
      if (output.some((item, index) => pending.some((p) => p.index === index) && item === null)) {
        for (const item of pending) {
          if (output[item.index] !== null) continue;
          output[item.index] = await generateEmbedding(item.text, model);
        }
        recordBatchSuccess(model.provider, model.modelId, true);
      } else {
        recordBatchSuccess(model.provider, model.modelId);
      }
      return output;
    }

    const base = (model.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    for (let start = 0; start < pending.length; start += batchSize) {
      const batch = pending.slice(start, start + batchSize);
      const resp = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${model.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: model.modelId, input: batch.map((item) => item.text) }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) {
        log.warn("Batch embedding request failed; falling back to single embeds", {
          status: resp.status,
          modelId: model.modelId,
        });
        recordBatchFailure(model.provider, model.modelId, `http:${resp.status}`, true);
        break;
      }
      const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }>; embeddings?: number[][] };
      batch.forEach((item, index) => {
        output[item.index] = data.data?.[index]?.embedding ?? data.embeddings?.[index] ?? null;
      });
    }
  } catch (err) {
    log.warn("Batch embedding generation failed; falling back to single embeds", {
      modelId: model.modelId,
      error: String(err),
    });
    recordBatchFailure(model.provider, model.modelId, String(err), true);
  }

  for (const item of pending) {
    if (output[item.index] !== null) continue;
    output[item.index] = await generateEmbedding(item.text, model);
  }
  recordBatchSuccess(model.provider, model.modelId, true);
  return output;
}

/** Cosine similarity in [0, 1] range. Returns 0 for zero/mismatched vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : Math.max(0, Math.min(1, dot / denom));
}

/** Persist an embedding to the memory_embeddings table. */
export function storeEmbedding(
  memoryId: string,
  contentHash: string,
  embedding: number[],
  model: EmbeddingModel,
  agentId = "default",
): void {
  try {
    const providerKey = getEmbeddingProviderKey(model);
    withSqliteWriteRecovery("store-memory-embedding", (db) => {
      db.prepare(
        "INSERT OR REPLACE INTO memory_embeddings (id, content_hash, embedding, provider_id, provider_key, model_id, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(memoryId, contentHash, JSON.stringify(embedding), model.provider, providerKey, model.modelId, agentId, new Date().toISOString());
    });
    void upsertMemoryVector("atomic", memoryId, embedding, model.modelId, agentId);
  } catch (err) {
    log.warn("Failed to store embedding", { memoryId, error: String(err) });
  }
}

/** Retrieve a cached embedding. Returns null if not found or content_hash mismatch (stale). */
export function getStoredEmbedding(
  memoryId: string,
  currentContentHash: string,
  model?: EmbeddingModel | null,
  agentId = "default",
): number[] | null {
  try {
    const db = getSqlite();
    const providerKey = model ? getEmbeddingProviderKey(model) : null;
    const row = db
      .prepare("SELECT embedding, content_hash, provider_id, provider_key, model_id FROM memory_embeddings WHERE id = ? AND agent_id = ?")
      .get(memoryId, agentId) as
      | { embedding: string; content_hash: string; provider_id?: string; provider_key?: string; model_id?: string }
      | undefined;
    if (!row) return null;
    // Invalidate if content changed.
    if (
      row.content_hash !== currentContentHash ||
      (model
        ? (
            String(row.provider_id || "unknown") !== model.provider ||
            String(row.provider_key || "") !== providerKey ||
            String(row.model_id || "") !== model.modelId
          )
        : false)
    ) {
      withSqliteWriteRecovery("delete-stale-memory-embedding", (database) => {
        database.prepare("DELETE FROM memory_embeddings WHERE id = ? AND agent_id = ?").run(memoryId, agentId);
      });
      return null;
    }
    const parsed = JSON.parse(row.embedding) as number[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Delete a cached embedding (call on memory delete/update). */
export function deleteEmbedding(memoryId: string, agentId = "default"): void {
  try {
    withSqliteWriteRecovery("delete-memory-embedding", (db) => {
      db.prepare("DELETE FROM memory_embeddings WHERE id = ? AND agent_id = ?").run(memoryId, agentId);
    });
    void deleteMemoryVector("atomic", memoryId, agentId);
  } catch {
    // Non-fatal
  }
}

/** Count of all cached embeddings. */
export function countEmbeddings(agentId?: string): number {
  try {
    const row = agentId
      ? (getSqlite().prepare("SELECT COUNT(*) AS n FROM memory_embeddings WHERE agent_id = ?").get(agentId) as { n: number })
      : (getSqlite().prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get() as { n: number });
    return row.n ?? 0;
  } catch {
    return 0;
  }
}

/** Cache-first embedding: check DB, generate on miss, store, return. Never throws. */
export async function getOrGenerateEmbedding(
  memoryId: string,
  content: string,
  contentHash: string,
  model: EmbeddingModel,
  agentId = "default",
): Promise<number[] | null> {
  const cached = getStoredEmbedding(memoryId, contentHash, model, agentId);
  if (cached) return cached;

  const embedding = await generateEmbedding(content, model);
  if (embedding) {
    storeEmbedding(memoryId, contentHash, embedding, model, agentId);
  }
  return embedding;
}
