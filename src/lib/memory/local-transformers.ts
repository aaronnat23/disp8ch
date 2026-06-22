import os from "node:os";
import path from "node:path";
import { logger } from "@/lib/utils/logger";

const log = logger.child("memory:local-transformers");

export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

type TensorLike = {
  data?: Float32Array | Float64Array | number[];
  dims?: number[];
};

type FeatureExtractor = (
  input: string | string[],
  options?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean; quantized?: boolean },
) => Promise<TensorLike>;

type TransformersModule = {
  env: {
    cacheDir?: string;
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
  };
  pipeline: (
    task: "feature-extraction",
    model: string,
    options?: { quantized?: boolean; local_files_only?: boolean },
  ) => Promise<FeatureExtractor>;
};

type LocalExtractorKey = string;

const extractorCache = new Map<LocalExtractorKey, Promise<FeatureExtractor>>();

async function loadTransformersModule(): Promise<TransformersModule> {
  const dynamicImport = (0, eval)("(specifier) => import(specifier)") as (
    specifier: string,
  ) => Promise<TransformersModule>;
  return dynamicImport("@xenova/transformers");
}

function defaultCacheDir(): string {
  if (process.env.MEMORY_LOCAL_MODEL_CACHE_DIR?.trim()) {
    return path.resolve(process.env.MEMORY_LOCAL_MODEL_CACHE_DIR);
  }
  if (process.env.LOCALAPPDATA?.trim()) {
    return path.join(process.env.LOCALAPPDATA, "disp8ch", "transformers");
  }
  if (process.env.XDG_CACHE_HOME?.trim()) {
    return path.join(process.env.XDG_CACHE_HOME, "disp8ch", "transformers");
  }
  return path.join(os.homedir(), ".cache", "disp8ch", "transformers");
}

export function isLocalEmbeddingModelId(modelId?: string | null): boolean {
  const value = String(modelId || "").trim().toLowerCase();
  return value === "local" || value.startsWith("local:") || value.startsWith("local-only:");
}

export function normalizeLocalEmbeddingModelId(modelId?: string | null): {
  modelId: string;
  localOnly: boolean;
  cacheDir: string;
} {
  const raw = String(modelId || "").trim();
  if (!raw || raw.toLowerCase() === "local") {
    return { modelId: DEFAULT_LOCAL_EMBEDDING_MODEL, localOnly: false, cacheDir: defaultCacheDir() };
  }
  if (raw.toLowerCase().startsWith("local-only:")) {
    const next = raw.slice("local-only:".length).trim() || DEFAULT_LOCAL_EMBEDDING_MODEL;
    return { modelId: next, localOnly: true, cacheDir: defaultCacheDir() };
  }
  if (raw.toLowerCase().startsWith("local:")) {
    const next = raw.slice("local:".length).trim() || DEFAULT_LOCAL_EMBEDDING_MODEL;
    return { modelId: next, localOnly: false, cacheDir: defaultCacheDir() };
  }
  return { modelId: raw, localOnly: false, cacheDir: defaultCacheDir() };
}

async function getExtractor(modelId: string, cacheDir: string, localOnly: boolean): Promise<FeatureExtractor> {
  const key = `${modelId}::${cacheDir}::${localOnly ? "local-only" : "local+remote"}`;
  const cached = extractorCache.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const mod = await loadTransformersModule();
    mod.env.cacheDir = cacheDir;
    mod.env.allowLocalModels = true;
    mod.env.allowRemoteModels = !localOnly;
    return mod.pipeline("feature-extraction", modelId, {
      quantized: true,
      local_files_only: localOnly,
    });
  })();

  extractorCache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    extractorCache.delete(key);
    throw error;
  }
}

function tensorToVectors(tensor: TensorLike, expectedCount: number): Array<number[] | null> {
  const values = Array.from(tensor.data ?? []);
  const dims = Array.isArray(tensor.dims) ? tensor.dims : [];
  if (!values.length) return new Array(expectedCount).fill(null);

  const width = Number(dims[dims.length - 1] || values.length);
  if (!width) return new Array(expectedCount).fill(null);

  const batch = dims.length > 1 ? Number(dims[0] || 1) : 1;
  const vectors: Array<number[] | null> = [];
  for (let row = 0; row < batch; row++) {
    const start = row * width;
    const slice = values.slice(start, start + width);
    vectors.push(slice.length === width ? slice : null);
  }

  while (vectors.length < expectedCount) vectors.push(null);
  return vectors.slice(0, expectedCount);
}

export async function generateLocalEmbeddings(
  texts: string[],
  options: { modelId?: string | null; cacheDir?: string; localOnly?: boolean } = {},
): Promise<Array<number[] | null>> {
  const normalizedTexts = texts.map((text) => text.trim().slice(0, 8000));
  const pending = normalizedTexts
    .map((text, index) => ({ text, index }))
    .filter((item) => item.text);
  if (!pending.length) return new Array(texts.length).fill(null);

  const normalized = normalizeLocalEmbeddingModelId(options.modelId);
  const cacheDir = options.cacheDir || normalized.cacheDir;
  const localOnly = options.localOnly ?? normalized.localOnly;

  try {
    const extractor = await getExtractor(normalized.modelId, cacheDir, localOnly);
    const tensor = await extractor(
      pending.length === 1 ? pending[0]!.text : pending.map((item) => item.text),
      { pooling: "mean", normalize: true, quantized: true },
    );
    const vectors = tensorToVectors(tensor, pending.length);
    const output = new Array(texts.length).fill(null) as Array<number[] | null>;
    pending.forEach((item, index) => {
      output[item.index] = vectors[index] ?? null;
    });
    return output;
  } catch (error) {
    log.warn("Local embedding generation failed", {
      modelId: normalized.modelId,
      cacheDir,
      localOnly,
      error: String(error),
    });
    return new Array(texts.length).fill(null);
  }
}
