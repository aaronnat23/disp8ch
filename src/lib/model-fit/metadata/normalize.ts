import type { GgufMetadata, GgufValue } from "./gguf-reader";

/**
 * Normalize GGUF metadata into architecture-aware fields. MoE models preserve
 * BOTH total and active parameters. Values come from metadata first; the
 * filename is a low-confidence fallback only.
 */

export type NormalizedModelMetadata = {
  architecture: string | null;
  family: string | null;
  displayName: string | null;
  quantization: string | null;
  fileType: number | null;
  totalParamsB: number | null;
  activeParamsB: number | null;
  isMoe: boolean;
  blockCount: number | null;
  embeddingLength: number | null;
  headCount: number | null;
  headCountKv: number | null;
  headDim: number | null;
  contextLength: number | null;
  expertCount: number | null;
  expertUsedCount: number | null;
  ropeFreqBase: number | null;
  visionProjector: boolean;
  sources: string[];
  paramConfidence: "metadata" | "filename" | "unknown";
};

// GGUF file_type enum → quant label (common subset).
const FILE_TYPE_QUANT: Record<number, string> = {
  0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1",
  10: "Q2_K", 11: "Q3_K_S", 12: "Q3_K_M", 13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M",
  16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K", 19: "IQ2_XXS", 20: "IQ2_XS", 23: "IQ3_XXS",
  21: "Q2_K_S", 22: "IQ3_XS", 24: "IQ1_S", 25: "IQ4_NL", 26: "IQ3_S", 27: "IQ3_M",
  28: "IQ2_S", 29: "IQ2_M", 30: "IQ4_XS", 31: "IQ1_M", 32: "BF16",
  36: "TQ1_0", 37: "TQ2_0", 38: "MXFP4_MOE", 39: "NVFP4", 40: "Q1_0",
};

function num(v: GgufValue | undefined): number | null {
  return typeof v === "number" ? v : null;
}
function str(v: GgufValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}

/** Parse "35B-A3B", "30B-A3B", "12B", "7b" → { total, active }. */
export function parseSizeLabel(label: string | null): { totalB: number | null; activeB: number | null } {
  if (!label) return { totalB: null, activeB: null };
  const m = label.match(/(\d+(?:\.\d+)?)\s*B(?:[-_\s]*A(\d+(?:\.\d+)?)\s*B)?/i);
  if (!m) return { totalB: null, activeB: null };
  const totalB = Number(m[1]);
  const activeB = m[2] !== undefined ? Number(m[2]) : totalB; // dense: active == total
  return { totalB: Number.isFinite(totalB) ? totalB : null, activeB: Number.isFinite(activeB) ? activeB : null };
}

/** Low-confidence filename parse: family + total/active size + quant. */
export function parseFilename(fileName: string): {
  family: string | null;
  totalB: number | null;
  activeB: number | null;
  quant: string | null;
} {
  const base = fileName.replace(/\.gguf$/i, "");
  const { totalB, activeB } = parseSizeLabel(base);
  const quantMatch = base.match(/\b(Q\d(?:_K(?:_[SML])?|_\d)?|IQ\d\w*|F16|BF16|F32|Q8_0)\b/i);
  const familyMatch = base.match(/\b(qwen[\d.]*|gemma[\d.]*|llama[\d.]*|mistral|mixtral|phi[\d.]*|deepseek[\w-]*|gpt-oss|granite)\b/i);
  return {
    family: familyMatch ? familyMatch[1].toLowerCase() : null,
    totalB,
    activeB,
    quant: quantMatch ? quantMatch[1].toUpperCase() : null,
  };
}

function deriveFamily(architecture: string | null, displayName: string | null): string | null {
  const hay = `${architecture ?? ""} ${displayName ?? ""}`.toLowerCase();
  if (/qwen3/.test(hay)) return "qwen3";
  if (/qwen2/.test(hay)) return "qwen2";
  if (/gemma/.test(hay)) return "gemma";
  if (/llama/.test(hay)) return "llama";
  if (/mixtral/.test(hay)) return "mixtral";
  if (/mistral/.test(hay)) return "mistral";
  if (/phi/.test(hay)) return "phi";
  if (/deepseek/.test(hay)) return "deepseek";
  return architecture ? architecture.replace(/moe$/, "") : null;
}

export function normalizeGguf(meta: GgufMetadata, fileName?: string): NormalizedModelMetadata {
  const kv = meta.kv;
  const architecture = str(kv["general.architecture"]);
  const prefix = architecture ? `${architecture}.` : "";
  const k = (suffix: string) => kv[`${prefix}${suffix}`];

  const displayName = str(kv["general.name"]) ?? str(kv["general.basename"]);
  const fileType = num(kv["general.file_type"]);
  const quantization = fileType !== null && FILE_TYPE_QUANT[fileType] ? FILE_TYPE_QUANT[fileType] : null;

  const expertCount = num(k("expert_count"));
  const expertUsedCount = num(k("expert_used_count"));
  const isMoe = (expertCount ?? 0) > 1;

  const sizeLabel = str(kv["general.size_label"]);
  let { totalB, activeB } = parseSizeLabel(sizeLabel);
  let paramConfidence: NormalizedModelMetadata["paramConfidence"] = totalB !== null ? "metadata" : "unknown";
  const sources = ["gguf_metadata"];

  if (totalB === null && fileName) {
    const fn = parseFilename(fileName);
    totalB = fn.totalB;
    activeB = fn.activeB;
    if (totalB !== null) { paramConfidence = "filename"; sources.push("filename"); }
  }
  // Dense model: active == total. MoE without an active label keeps active null.
  if (activeB === null && !isMoe) activeB = totalB;

  const embeddingLength = num(k("embedding_length"));
  const headCount = num(k("attention.head_count"));
  const headCountKv = num(k("attention.head_count_kv")) ?? headCount;
  const keyLength = num(k("attention.key_length"));
  const headDim = keyLength ?? (embeddingLength !== null && headCount ? Math.round(embeddingLength / headCount) : null);

  return {
    architecture,
    family: deriveFamily(architecture, displayName),
    displayName,
    quantization: quantization ?? (fileName ? parseFilename(fileName).quant : null),
    fileType,
    totalParamsB: totalB,
    activeParamsB: activeB,
    isMoe,
    blockCount: num(k("block_count")),
    embeddingLength,
    headCount,
    headCountKv,
    headDim,
    contextLength: num(k("context_length")),
    expertCount,
    expertUsedCount,
    ropeFreqBase: num(k("rope.freq_base")),
    visionProjector: Boolean(kv["clip.has_vision_encoder"]) || Boolean(kv["general.vision"]) || /vision|vl|llava/i.test(displayName ?? ""),
    sources,
    paramConfidence,
  };
}
