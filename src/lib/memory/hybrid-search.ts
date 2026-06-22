// Server-only — do not import in client components.
import type { MemoryEntry } from "@/types/memory";
import {
  cosineSimilarity,
  getStoredEmbedding,
  getOrGenerateEmbedding,
  type EmbeddingModel,
} from "./embedding-provider";
import { computeAtomicContentHash } from "./simple";
import { searchMemoryVectors } from "./sqlite-vec";

export interface VectorResult {
  entry: MemoryEntry;
  similarity: number;
}

export interface HybridEntry extends MemoryEntry {
  hybridScore: number;
  bm25Score?: number;
  vectorScore?: number;
}

/** Normalize an array of scores to [0, 1] range. */
function normalizeScores(pairs: Array<{ score: number }>): number[] {
  const max = Math.max(...pairs.map((p) => p.score), 1e-9);
  return pairs.map((p) => p.score / max);
}

/**
 * Merge BM25 (text) and vector results into a single ranked list using
 * configurable weights.
 *
 * @param bm25      Results from FTS5/SimpleMemoryProvider.search() with their salience scores.
 * @param vector    Results from vectorSearch().
 * @param vectorWeight  Weight for vector score (default 0.7).
 * @param textWeight    Weight for BM25 score (default 0.3).
 * @param limit     Maximum results to return.
 */
export function mergeHybridResults(
  bm25: Array<MemoryEntry & { score?: number }>,
  vector: VectorResult[],
  vectorWeight: number,
  textWeight: number,
  limit: number
): HybridEntry[] {
  const bm25Norm = normalizeScores(bm25.map((e) => ({ score: e.score ?? 0 })));
  const vectorNorm = normalizeScores(vector.map((v) => ({ score: v.similarity })));

  const merged = new Map<string, HybridEntry>();

  // Contribute BM25 scores.
  bm25.forEach((entry, i) => {
    const key = entry.id ?? entry.content.slice(0, 40);
    const existing = merged.get(key);
    const textContrib = textWeight * bm25Norm[i];
    if (existing) {
      existing.hybridScore += textContrib;
      existing.bm25Score = (existing.bm25Score ?? 0) + textContrib;
    } else {
      merged.set(key, { ...entry, hybridScore: textContrib, bm25Score: textContrib });
    }
  });

  // Contribute vector scores.
  vector.forEach((v, i) => {
    const key = v.entry.id ?? v.entry.content.slice(0, 40);
    const existing = merged.get(key);
    const vecContrib = vectorWeight * vectorNorm[i];
    if (existing) {
      existing.hybridScore += vecContrib;
      existing.vectorScore = (existing.vectorScore ?? 0) + vecContrib;
    } else {
      merged.set(key, { ...v.entry, hybridScore: vecContrib, vectorScore: vecContrib });
    }
  });

  return Array.from(merged.values())
    .sort((a, b) => b.hybridScore - a.hybridScore)
    .slice(0, limit);
}

/**
 * Score cached embeddings against a query embedding via cosine similarity.
 * Only uses already-cached embeddings — never calls the embedding API during search.
 * New embeddings are indexed lazily in store()/update() and via rebuild-index.
 *
 * Caps the candidate scan at 500 most-recently-updated entries to stay fast at scale.
 */
export async function vectorSearch(
  queryEmbedding: number[],
  candidates: MemoryEntry[],
  topK: number,
  agentId = "default",
): Promise<VectorResult[]> {
  if (!queryEmbedding.length || !candidates.length) return [];

  const candidateMap = new Map(candidates.map((entry) => [entry.id, entry]));

  const nativeMatches = await searchMemoryVectors(queryEmbedding, topK * 4, ["atomic"], agentId);
  const nativeResults: VectorResult[] = [];
  for (const match of nativeMatches) {
    const entry = candidateMap.get(match.refId);
    if (!entry) continue;
    nativeResults.push({ entry, similarity: match.score });
  }
  if (nativeResults.length) {
    return nativeResults.slice(0, topK);
  }

  // Cap scan size for performance on the JSON fallback path.
  const scanSet = candidates.slice(0, 500);

  const scored: VectorResult[] = [];
  for (const entry of scanSet) {
    const contentHash =
      entry.contentHash ?? computeAtomicContentHash(entry.content, entry.type);
    const embedding = getStoredEmbedding(entry.id, contentHash, undefined, agentId);
    if (!embedding) continue;
    const similarity = cosineSimilarity(queryEmbedding, embedding);
    if (similarity > 0) {
      scored.push({ entry, similarity });
    }
  }

  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
}

/**
 * Generate and cache an embedding for a single memory entry.
 * Called fire-and-forget from UnifiedMemoryProvider.store() and .update().
 */
export async function indexMemoryEmbedding(
  entry: MemoryEntry,
  model: EmbeddingModel,
  agentId = "default",
): Promise<void> {
  const contentHash =
    entry.contentHash ?? computeAtomicContentHash(entry.content, entry.type);
  await getOrGenerateEmbedding(entry.id, entry.content, contentHash, model, agentId);
}
