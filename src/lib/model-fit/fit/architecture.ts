import type { FitClass } from "./types";

/**
 * Architecture-aware fallback estimator (used when native llama.cpp fitting is
 * unavailable). Key rules from the plan:
 *  - MoE uses TOTAL parameters for resident weight memory and ACTIVE parameters
 *    only for compute/throughput.
 *  - Prefer the real local file size for weight storage when available.
 *  - KV cache is computed from layers, KV heads, head dim, cache type, context,
 *    and parallel slots — NOT paramsB * 0.12.
 *  - A model larger than VRAM is not automatically rejected (hybrid is fine).
 */

const QUANT_BYTES_PER_WEIGHT: Record<string, number> = {
  F32: 4, F16: 2, BF16: 2, Q8_0: 1.06, Q6_K: 0.82, Q5_K_M: 0.69, Q5_K_S: 0.66,
  Q4_K_M: 0.6, Q4_K_S: 0.57, Q4_0: 0.56, Q3_K_M: 0.49, Q3_K_S: 0.44, Q2_K: 0.39,
  IQ2_XXS: 0.26, IQ3_XXS: 0.33,
};

const KV_BYTES_PER_ELEMENT: Record<string, number> = { f16: 2, bf16: 2, f32: 4, q8_0: 1.0625, q5_1: 0.75, q4_0: 0.5 };

export function weightsGBFromParams(totalParamsB: number, quant: string): number {
  const bpw = QUANT_BYTES_PER_WEIGHT[(quant || "Q4_K_M").toUpperCase()] ?? 0.6;
  return Math.round(totalParamsB * bpw * 10) / 10;
}

export type ArchFitInput = {
  totalParamsB: number | null;
  activeParamsB: number | null;
  isMoe: boolean;
  blockCount: number | null;
  headCountKv: number | null;
  headDim: number | null;
  quant: string;
  fileSizeBytes: number | null;
  contextTokens: number;
  parallelSlots: number;
  cacheType: string;
};

export type ArchFitEstimate = {
  weightsGB: number;
  activeWeightsGB: number;
  kvCacheGB: number;
  computeGB: number;
  requiredGB: number;
};

export function estimateArchitectureMemory(input: ArchFitInput): ArchFitEstimate {
  // Weights: real file size is authoritative for a local artifact.
  const weightsGB = input.fileSizeBytes
    ? Math.round((input.fileSizeBytes / 1024 ** 3) * 10) / 10
    : input.totalParamsB !== null
      ? weightsGBFromParams(input.totalParamsB, input.quant)
      : 0;

  // Active weights (MoE): the share that must be compute-resident.
  const activeFraction =
    input.isMoe && input.totalParamsB && input.activeParamsB
      ? Math.min(1, input.activeParamsB / input.totalParamsB)
      : 1;
  const activeWeightsGB = Math.round(weightsGB * activeFraction * 10) / 10;

  // KV cache from architecture (GQA-aware): 2(K+V) * layers * kvHeads * headDim * ctx * np * bytes.
  const layers = input.blockCount ?? 32;
  const kvHeads = input.headCountKv ?? 8;
  const headDim = input.headDim ?? 128;
  const kvBytes = KV_BYTES_PER_ELEMENT[(input.cacheType || "f16").toLowerCase()] ?? 2;
  const kvElements = 2 * layers * kvHeads * headDim * input.contextTokens * Math.max(1, input.parallelSlots);
  const kvCacheGB = Math.round((kvElements * kvBytes) / 1024 ** 3 * 10) / 10;

  const computeGB = 0.7;
  const requiredGB = Math.round((weightsGB + kvCacheGB + computeGB) * 10) / 10;
  return { weightsGB, activeWeightsGB, kvCacheGB, computeGB, requiredGB };
}

export type ClassifyInput = {
  estimate: ArchFitEstimate;
  freeVramGB: number;
  freeRamGB: number;
  hostReserveGB: number;
  gpuReserveGB: number;
  isMoe: boolean;
  supportsCpuMoe: boolean;
};

export type ClassifyResult = {
  fitClass: FitClass;
  cpuMoe: boolean;
  gpuLayers: number | "auto";
  rationale: string;
};

/**
 * Decide the fit class. For MoE on a small GPU, placing experts on CPU
 * (`--cpu-moe`) keeps active weights + KV + attention on the GPU — a workable
 * hybrid rather than a rejection.
 */
export function classifyArchitectureFit(input: ClassifyInput): ClassifyResult {
  const { estimate, freeVramGB, freeRamGB, hostReserveGB, gpuReserveGB, isMoe, supportsCpuMoe } = input;
  const usableVram = Math.max(0, freeVramGB - gpuReserveGB);
  const usableRam = Math.max(0, freeRamGB - hostReserveGB);
  const fullRequired = estimate.requiredGB;

  // Full GPU: everything (weights + KV + compute) fits in VRAM.
  if (fullRequired <= usableVram) {
    return { fitClass: "full_gpu", cpuMoe: false, gpuLayers: "auto", rationale: "Full weights + KV fit in VRAM." };
  }

  // MoE hybrid via CPU experts: GPU holds active weights + KV + compute, experts on RAM.
  if (isMoe && supportsCpuMoe) {
    const gpuResident = estimate.activeWeightsGB + estimate.kvCacheGB + estimate.computeGB;
    const expertsOnHost = estimate.weightsGB - estimate.activeWeightsGB;
    if (gpuResident <= usableVram && expertsOnHost <= usableRam) {
      const tight = gpuResident > usableVram * 0.85;
      return {
        fitClass: tight ? "hybrid_workable" : "hybrid_fast",
        cpuMoe: true,
        gpuLayers: "auto",
        rationale: `MoE experts on CPU (${Math.round(expertsOnHost)} GB RAM); active weights + KV on GPU.`,
      };
    }
  }

  // Dense/MoE partial offload: split weights across VRAM and RAM.
  if (estimate.weightsGB + estimate.kvCacheGB <= usableVram + usableRam) {
    const vramForWeights = Math.max(0, usableVram - estimate.kvCacheGB - estimate.computeGB);
    const frac = estimate.weightsGB > 0 ? Math.min(1, vramForWeights / estimate.weightsGB) : 0;
    const fitClass: FitClass = frac > 0.6 ? "hybrid_workable" : frac > 0.15 ? "cpu_heavy" : "cpu_heavy";
    if (estimate.requiredGB > usableVram + usableRam * 0.95) {
      return { fitClass: "memory_risky", cpuMoe: false, gpuLayers: "auto", rationale: "Close to total memory limits; may page or fail." };
    }
    return { fitClass, cpuMoe: false, gpuLayers: "auto", rationale: `Partial offload (~${Math.round(frac * 100)}% of weights on GPU).` };
  }

  return { fitClass: "cannot_load", cpuMoe: false, gpuLayers: 0, rationale: `Needs ~${fullRequired} GB; only ${Math.round(usableVram + usableRam)} GB usable.` };
}
