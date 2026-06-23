export type CatalogArchitecture = "dense" | "moe" | "hybrid" | "unknown";
export type CatalogModality = "text" | "image" | "audio" | "video";
export type CatalogCapability = "chat" | "reasoning" | "coding" | "tools" | "vision" | "embedding";
export type CatalogStatus = "discovered" | "catalogued" | "compatible" | "recommended" | "experimental" | "deprecated" | "legacy";

export type CatalogVariant = {
  runtime: "ollama" | "gguf" | "mlx" | "safetensors";
  exactId: string;
  quantization: string | null;
  sizeBytes: number | null;
  sourceUrl: string;
};

export type CatalogModel = {
  id: string;
  family: string;
  displayName: string;
  releasedAt: string | null;
  totalParamsB: number | null;
  activeParamsB: number | null;
  architecture: CatalogArchitecture;
  contextMax: number | null;
  modalities: CatalogModality[];
  capabilities: CatalogCapability[];
  license: string | null;
  variants: CatalogVariant[];
  sourceUrls: string[];
  status: CatalogStatus;
};

export type RegistryFreshness = {
  schemaVersion: number;
  registryVersion: string;
  generatedAt: string;
  sourceCheckedAt: Record<string, string>;
  expiresAt: string | null;
  checksum: string | null;
  signature: string | null;
};

export type ModelCatalog = {
  freshness: RegistryFreshness;
  source: "bundled";
  models: CatalogModel[];
};

export type FreshnessState = "fresh" | "aging" | "stale" | "offline";

export function freshnessState(generatedAt: string, now = Date.now()): FreshnessState {
  const age = now - Date.parse(generatedAt);
  if (!Number.isFinite(age)) return "offline";
  const days = age / (1000 * 60 * 60 * 24);
  if (days <= 7) return "fresh";
  if (days <= 30) return "aging";
  return "stale";
}

const VALID_ARCH = new Set<CatalogArchitecture>(["dense", "moe", "hybrid", "unknown"]);
const VALID_CAP = new Set<CatalogCapability>(["chat", "reasoning", "coding", "tools", "vision", "embedding"]);
const VALID_MODALITY = new Set<CatalogModality>(["text", "image", "audio", "video"]);
const VALID_STATUS = new Set<CatalogStatus>(["discovered", "catalogued", "compatible", "recommended", "experimental", "deprecated", "legacy"]);
const VALID_RUNTIME = new Set<CatalogVariant["runtime"]>(["ollama", "gguf", "mlx", "safetensors"]);

/** Strict validation — reject malformed entries, dup variant ids, bad urls/sizes/context. */
export function validateCatalogModel(model: unknown): model is CatalogModel {
  if (!model || typeof model !== "object") return false;
  const m = model as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.family !== "string" || typeof m.displayName !== "string") return false;
  if (!VALID_ARCH.has(m.architecture as CatalogArchitecture)) return false;
  if (!VALID_STATUS.has(m.status as CatalogStatus)) return false;
  if (m.totalParamsB !== null && (typeof m.totalParamsB !== "number" || m.totalParamsB <= 0)) return false;
  if (m.activeParamsB !== null && (typeof m.activeParamsB !== "number" || m.activeParamsB <= 0)) return false;
  if (typeof m.totalParamsB === "number" && typeof m.activeParamsB === "number" && m.activeParamsB > m.totalParamsB) return false;
  if (m.contextMax !== null && (typeof m.contextMax !== "number" || m.contextMax <= 0 || m.contextMax > 10_000_000)) return false;
  if (!Array.isArray(m.modalities) || !m.modalities.every((v) => VALID_MODALITY.has(v as CatalogModality))) return false;
  if (!Array.isArray(m.capabilities) || !m.capabilities.every((c) => VALID_CAP.has(c as CatalogCapability))) return false;
  if (!Array.isArray(m.sourceUrls) || !m.sourceUrls.every((url) => {
    try { new URL(String(url)); return true; } catch { return false; }
  })) return false;
  if (!Array.isArray(m.variants) || m.variants.length === 0) return false;
  const seen = new Set<string>();
  for (const v of m.variants as CatalogVariant[]) {
    if (!v || !VALID_RUNTIME.has(v.runtime) || typeof v.exactId !== "string" || !v.exactId.trim() || typeof v.sourceUrl !== "string") return false;
    if (v.sizeBytes !== null && (typeof v.sizeBytes !== "number" || v.sizeBytes < 0)) return false;
    try { new URL(v.sourceUrl); } catch { return false; }
    const key = `${v.runtime}:${v.exactId}`;
    if (seen.has(key)) return false; // duplicate runtime identifier
    seen.add(key);
  }
  return true;
}
