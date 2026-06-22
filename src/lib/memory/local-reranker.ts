import os from "node:os";
import path from "node:path";
import { logger } from "@/lib/utils/logger";

const log = logger.child("memory:local-reranker");

export const DEFAULT_LOCAL_RERANK_MODEL =
  process.env.MEMORY_LOCAL_RERANK_MODEL?.trim() || "Xenova/ms-marco-MiniLM-L-6-v2";

type TensorLike = {
  data?: Float32Array | Float64Array | number[];
  dims?: number[];
};

type TokenizerLike = (
  input: string | string[],
  options?: {
    text_pair?: string | string[] | null;
    padding?: boolean;
    truncation?: boolean;
    return_tensor?: boolean;
  },
) => Record<string, unknown>;

type SequenceModelLike = ((input: Record<string, unknown>) => Promise<{ logits?: TensorLike }>) & {
  config?: {
    id2label?: Record<string, string> | Record<number, string>;
    problem_type?: string;
  };
};

type TransformersModule = {
  env: {
    cacheDir?: string;
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
  };
  AutoTokenizer: {
    from_pretrained: (
      model: string,
      options?: { local_files_only?: boolean },
    ) => Promise<TokenizerLike>;
  };
  AutoModelForSequenceClassification: {
    from_pretrained: (
      model: string,
      options?: { quantized?: boolean; local_files_only?: boolean },
    ) => Promise<SequenceModelLike>;
  };
};

type CrossEncoderBundle = {
  tokenizer: TokenizerLike;
  model: SequenceModelLike;
};

const bundleCache = new Map<string, Promise<CrossEncoderBundle>>();

async function loadTransformersModule(): Promise<TransformersModule> {
  return import("@xenova/transformers");
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

async function getCrossEncoderBundle(
  modelId: string,
  cacheDir: string,
  localOnly: boolean,
): Promise<CrossEncoderBundle> {
  const key = `${modelId}::${cacheDir}::${localOnly ? "local-only" : "local+remote"}`;
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const mod = await loadTransformersModule();
    mod.env.cacheDir = cacheDir;
    mod.env.allowLocalModels = true;
    mod.env.allowRemoteModels = !localOnly;
    const [tokenizer, model] = await Promise.all([
      mod.AutoTokenizer.from_pretrained(modelId, { local_files_only: localOnly }),
      mod.AutoModelForSequenceClassification.from_pretrained(modelId, {
        quantized: true,
        local_files_only: localOnly,
      }),
    ]);
    return { tokenizer, model };
  })();

  bundleCache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    bundleCache.delete(key);
    throw error;
  }
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function softmax(values: number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0) || 1;
  return exps.map((value) => value / total);
}

function resolvePositiveIndex(model: SequenceModelLike, width: number): number {
  const labels = model.config?.id2label ?? {};
  const entries = Object.entries(labels);
  for (const [rawIndex, rawLabel] of entries) {
    const label = String(rawLabel || "").toLowerCase();
    if (label.includes("relevant") || label.includes("true") || label.includes("entail") || label === "label_1") {
      const parsed = Number(rawIndex);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed < width) return parsed;
    }
  }
  return width > 1 ? Math.min(1, width - 1) : 0;
}

function tensorRowScores(logits: TensorLike | undefined, model: SequenceModelLike, expectedCount: number): Array<number | null> {
  const values = Array.from(logits?.data ?? []);
  const dims = Array.isArray(logits?.dims) ? logits!.dims! : [];
  if (!values.length) return new Array(expectedCount).fill(null);

  const rows = Math.max(1, Number(dims[0] || expectedCount || 1));
  const width = Math.max(1, Number(dims[dims.length - 1] || (values.length / rows) || 1));
  const positiveIndex = resolvePositiveIndex(model, width);
  const problemType = String(model.config?.problem_type || "").toLowerCase();
  const scores: Array<number | null> = [];

  for (let row = 0; row < rows; row++) {
    const start = row * width;
    const slice = values.slice(start, start + width);
    if (!slice.length) {
      scores.push(null);
      continue;
    }
    if (slice.length === 1 || problemType === "multi_label_classification") {
      scores.push(sigmoid(Number(slice[0] ?? 0)));
      continue;
    }
    const distribution = softmax(slice);
    scores.push(Number(distribution[positiveIndex] ?? distribution[0] ?? 0));
  }

  while (scores.length < expectedCount) scores.push(null);
  return scores.slice(0, expectedCount);
}

export async function rerankLocallyWithCrossEncoder(
  query: string,
  documents: string[],
  options?: {
    modelId?: string;
    cacheDir?: string;
    localOnly?: boolean;
  },
): Promise<{ scores: Array<number | null>; modelId: string } | null> {
  const trimmedQuery = query.trim().slice(0, 512);
  const normalizedDocs = documents.map((document) => document.trim().slice(0, 3000));
  if (!trimmedQuery || normalizedDocs.length === 0) return null;

  const modelId = String(options?.modelId || DEFAULT_LOCAL_RERANK_MODEL).trim() || DEFAULT_LOCAL_RERANK_MODEL;
  const cacheDir = options?.cacheDir || defaultCacheDir();
  const localOnly = options?.localOnly ?? false;

  try {
    const bundle = await getCrossEncoderBundle(modelId, cacheDir, localOnly);
    const inputs = bundle.tokenizer(new Array(normalizedDocs.length).fill(trimmedQuery), {
      text_pair: normalizedDocs,
      padding: true,
      truncation: true,
      return_tensor: true,
    });
    const output = await bundle.model(inputs);
    const scores = tensorRowScores(output.logits, bundle.model, normalizedDocs.length);
    return { scores, modelId };
  } catch (error) {
    log.warn("Local cross-encoder rerank failed", {
      modelId,
      cacheDir,
      localOnly,
      error: String(error),
    });
    return null;
  }
}
