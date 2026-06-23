/**
 * Memory estimation for local GGUF-style models. All heuristics are transparent
 * and approximate — they are meant to steer a choice, not to be exact. Pure.
 */

export type FitClass = "full_gpu" | "partial_offload" | "cpu_only" | "not_recommended";

/** Approximate bytes-per-weight for common quantizations (GGUF). */
const BYTES_PER_WEIGHT: Record<string, number> = {
  f16: 2.0,
  q8_0: 1.06,
  q6_k: 0.82,
  q5_k_m: 0.69,
  q5_k_s: 0.66,
  q4_k_m: 0.6,
  q4_k_s: 0.57,
  q4_0: 0.56,
  q3_k_m: 0.49,
  q3_k_s: 0.44,
  q2_k: 0.39,
};

export function bytesPerWeight(quant: string): number {
  const key = (quant || "q4_k_m").toLowerCase().replace(/[^a-z0-9_]/g, "");
  return BYTES_PER_WEIGHT[key] ?? BYTES_PER_WEIGHT.q4_k_m;
}

export type MemoryEstimate = {
  weightsGB: number;
  kvCacheGB: number;
  overheadGB: number;
  requiredGB: number;
};

/**
 * Estimate the memory needed to run a model at a given context length.
 *  - weights = params(B) × bytes-per-weight(quant)
 *  - kv cache ≈ scales with context and model size (GQA-aware rough factor)
 *  - overhead = fixed runtime/buffers allowance
 */
export function estimateModelMemory(params: {
  paramsB: number;
  quant: string;
  contextTokens: number;
}): MemoryEstimate {
  const weightsGB = params.paramsB * bytesPerWeight(params.quant);
  const ctxRatio = Math.max(1, params.contextTokens) / 4096;
  const kvCacheGB = Math.max(0.1, ctxRatio * Math.max(0.4, params.paramsB * 0.12));
  const overheadGB = 0.6;
  const requiredGB = weightsGB + kvCacheGB + overheadGB;
  return {
    weightsGB: round(weightsGB),
    kvCacheGB: round(kvCacheGB),
    overheadGB,
    requiredGB: round(requiredGB),
  };
}

export function classifyFit(params: {
  requiredGB: number;
  availableRamGB: number;
  availableVramGB: number;
}): FitClass {
  const { requiredGB, availableRamGB, availableVramGB } = params;
  // Leave a safety margin: don't promise a fit that uses 100% of memory.
  const vram = availableVramGB * 0.9;
  const ram = availableRamGB * 0.8;
  if (availableVramGB > 0 && requiredGB <= vram) return "full_gpu";
  if (availableVramGB > 0 && requiredGB <= vram + ram) return "partial_offload";
  if (requiredGB <= ram) return "cpu_only";
  return "not_recommended";
}

export type SpeedClass = "fast" | "medium" | "slow" | "very_slow";

/** Rough transformer block count by model size (used for partial GPU offload). */
export function estimateLayers(paramsB: number): number {
  if (paramsB <= 1) return 24;
  if (paramsB <= 4) return 28;
  if (paramsB <= 9) return 32;
  if (paramsB <= 16) return 40;
  if (paramsB <= 35) return 64;
  if (paramsB <= 75) return 80;
  return 96;
}

/**
 * Compute how many transformer layers to put on the GPU (llama.cpp `-ngl`).
 * This is llama.cpp's key advantage over Ollama's defaults: precise partial
 * offload. Full fit → all layers; CPU-only → 0; partial → the fraction of the
 * weights that fits in usable VRAM after reserving room for the KV cache.
 */
export function computeGpuLayers(params: {
  fit: FitClass;
  totalLayers: number;
  weightsGB: number;
  usableVramGB: number;
  kvCacheGB: number;
}): number {
  const { fit, totalLayers, weightsGB, usableVramGB, kvCacheGB } = params;
  if (fit === "full_gpu") return totalLayers;
  if (fit === "cpu_only" || fit === "not_recommended") return 0;
  // Partial: reserve VRAM for the KV cache + a small buffer, offload the rest.
  const vramForWeights = Math.max(0, usableVramGB - kvCacheGB - 0.6);
  if (weightsGB <= 0) return 0;
  const frac = Math.min(1, vramForWeights / weightsGB);
  return Math.max(0, Math.min(totalLayers, Math.floor(totalLayers * frac)));
}

export function estimateSpeed(fit: FitClass, paramsB: number): SpeedClass {
  if (fit === "full_gpu") return paramsB <= 14 ? "fast" : "medium";
  if (fit === "partial_offload") return paramsB <= 14 ? "medium" : "slow";
  if (fit === "cpu_only") return paramsB <= 8 ? "slow" : "very_slow";
  return "very_slow";
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
