import { detectHardwareV2 } from "./inventory/hardware";
import { detectRuntimes, fetchLlamaCppRuntimeState } from "./inventory/runtimes";
import { discoverLocalModels } from "./inventory/local-files";
import { fetchOllamaInventory } from "./inventory/ollama";
import type { HardwareProfileV2, LocalModelArtifact, OllamaInstalledModel, RuntimeInventory } from "./inventory/types";
import { loadCatalog, recommendableCatalogModels } from "./catalog/load";
import type { CatalogModel, FreshnessState } from "./catalog/schema";
import { classifyArchitectureFit, estimateArchitectureMemory } from "./fit/architecture";
import { runNativeFit } from "./fit/llama-native";
import type { FitClass, FitConfidence } from "./fit/types";
import { buildLlamaCliCommand, buildLlamaServerCommand, buildOllamaCommand } from "./fit/commands";
import { getCalibration, localCalibrationKey, ollamaCalibrationKey, type CalibrationRecord } from "./calibration";

export type ModelTask = "coding" | "chat" | "reasoning" | "vision" | "general";
export type Preference = "quality" | "balanced" | "speed";
export type Lane = "quality" | "balanced" | "fast";

export type CandidateSource = "local_gguf" | "ollama_installed" | "catalog";

export type RankedModel = {
  source: CandidateSource;
  modelId: string;
  displayName: string;
  family: string | null;
  totalParamsB: number | null;
  activeParamsB: number | null;
  isMoe: boolean;
  quant: string | null;
  contextMax: number | null;
  capabilities: string[];
  path: string | null;
  ollamaTag: string | null;
  sizeBytes: number | null;
  fitClass: FitClass;
  confidence: FitConfidence;
  fitSource: string;
  gpuGB: number;
  hostGB: number;
  cpuMoe: boolean;
  gpuLayers: number | "auto";
  commands: { llamaServer?: string; llamaCli?: string; ollama?: { run: string; note?: string } };
  reasons: string[];
  warnings: string[];
  performance: {
    generationTokensPerSecond: number | null;
    timeToFirstTokenMs: number | null;
    measuredAt: string | null;
  };
  score: number;
  lane: Lane | null;
  rawFitterOutput?: string;
};

export type RecommendationResultV2 = {
  hardware: HardwareProfileV2;
  runtimes: RuntimeInventory;
  task: ModelTask;
  preference: Preference;
  contextTokens: number;
  installed: RankedModel[];
  lanes: { quality: RankedModel | null; balanced: RankedModel | null; fast: RankedModel | null };
  allCandidates: RankedModel[];
  constrained: RankedModel[];
  catalog: { source: string; state: FreshnessState; generatedAt: string };
  notes: string[];
};

const FIT_RANK: Record<FitClass, number> = {
  full_gpu: 6, hybrid_fast: 5, hybrid_workable: 4, cpu_heavy: 2, memory_risky: 1, cannot_load: 0,
};

function cacheTypeForContext(contextTokens: number): string {
  return contextTokens >= 32768 ? "q8_0" : "f16";
}

/** Parse an Ollama parameter_size like "137M", "7B", "20.9B" into billions. */
function parseParamB(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/([\d.]+)\s*([BMK])?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "B").toUpperCase();
  if (unit === "M") return n / 1000;
  if (unit === "K") return n / 1_000_000;
  return n;
}

/** A model usable for chat/coding/reasoning lanes (excludes embedding-only models). */
function isChatCapable(capabilities: string[]): boolean {
  if (capabilities.length === 0) return true; // assume usable when unknown
  if (capabilities.some((c) => ["chat", "completion", "coding", "reasoning", "tools", "vision", "thinking"].includes(c))) return true;
  return !capabilities.every((c) => c === "embedding" || c === "embed");
}

function normalizedIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isLoadedInLlamaServer(artifact: LocalModelArtifact, loadedModels: string[]): boolean {
  const artifactIds = [artifact.id, artifact.displayName, artifact.path.split(/[\\/]/).pop() ?? ""]
    .map(normalizedIdentity)
    .filter(Boolean);
  return loadedModels.some((loaded) => {
    const loadedId = normalizedIdentity(loaded);
    return artifactIds.some((artifactId) => loadedId === artifactId || loadedId.includes(artifactId) || artifactId.includes(loadedId));
  });
}

function localCapabilities(artifact: LocalModelArtifact, catalogModels: CatalogModel[]): string[] {
  const md = artifact.metadata;
  const identity = normalizedIdentity(`${artifact.displayName} ${artifact.path}`);
  if (/\b(?:embed|embedding|bert)\b/i.test(`${artifact.displayName} ${md?.architecture ?? ""} ${md?.family ?? ""}`)) {
    return ["embedding"];
  }
  const match = catalogModels.find((model) =>
    [model.id, model.displayName].some((candidate) => {
      const modelIdentity = normalizedIdentity(candidate);
      return modelIdentity.length >= 8 && identity.includes(modelIdentity);
    })
  );
  const inherited = match?.capabilities.filter((cap) => cap !== "vision") ?? [];
  const caps = new Set<string>(inherited.length > 0 ? inherited : ["chat"]);
  if (md?.visionProjector) caps.add("vision");
  return [...caps];
}

function computeFit(
  candidate: { totalParamsB: number | null; activeParamsB: number | null; isMoe: boolean; quant: string | null; blockCount: number | null; headCountKv: number | null; headDim: number | null; path: string | null; sizeBytes: number | null; loaded?: boolean },
  hw: HardwareProfileV2,
  runtimes: RuntimeInventory,
  contextTokens: number,
): { fitClass: FitClass; gpuGB: number; hostGB: number; cpuMoe: boolean; gpuLayers: number | "auto"; confidence: FitConfidence; fitSource: string; reasons: string[]; warnings: string[]; rawFitter?: string } {
  const freeVramNow = Math.max(0, ...hw.gpus.map((g) => g.freeVramGB ?? g.totalVramGB ?? 0));
  const cacheType = cacheTypeForContext(contextTokens);
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (candidate.totalParamsB === null && !candidate.sizeBytes) {
    return {
      fitClass: "cannot_load",
      gpuGB: 0,
      hostGB: 0,
      cpuMoe: false,
      gpuLayers: 0,
      confidence: "catalog_estimated",
      fitSource: "insufficient_metadata",
      reasons,
      warnings: ["Model size is unknown; no safe fit estimate can be produced."],
    };
  }

  // 1) llama.cpp native fitter for a local GGUF.
  if (candidate.path && runtimes.llamaCpp.available && runtimes.llamaCpp.fitParamsPath) {
    const native = runNativeFit({
      fitParamsPath: runtimes.llamaCpp.fitParamsPath,
      modelPath: candidate.path,
      contextTokens,
      parallelSlots: 1,
      cpuMoe: candidate.isMoe,
      keyType: cacheType,
      valueType: cacheType,
      capabilities: runtimes.llamaCpp.capabilities,
    });
    if (native.ok) {
      if (candidate.loaded) {
        const fitClass: FitClass = native.hostTotalGB <= 0.1 ? "full_gpu" : "hybrid_workable";
        return {
          fitClass,
          gpuGB: native.gpuTotalGB,
          hostGB: native.hostTotalGB,
          cpuMoe: candidate.isMoe,
          gpuLayers: "auto",
          confidence: "runtime_estimated",
          fitSource: "llama_server_live",
          reasons,
          warnings,
          rawFitter: native.raw,
        };
      }
      const gpuFits = native.devices.every((device, index) => {
        const gpu = hw.gpus[index];
        if (!gpu) return false;
        return device.totalMiB / 1024 <= Math.max(0, (gpu.freeVramGB ?? gpu.totalVramGB) - 1);
      });
      const hostFitsNow = native.hostTotalGB <= Math.max(0, hw.freeRamGB - hw.recommendedHostReserveGB);
      const hostFitsPhysical = native.hostTotalGB <= Math.max(0, hw.totalRamGB - hw.recommendedHostReserveGB);
      let fitClass: FitClass;
      if (!gpuFits || !hostFitsPhysical) {
        fitClass = "cannot_load";
        warnings.push("The native fit allocation exceeds available device or physical host memory.");
      } else if (!hostFitsNow) {
        fitClass = "memory_risky";
        warnings.push("The model fits physical memory but not current free RAM with the safety reserve.");
      } else if (native.hostTotalGB <= 0.1) {
        fitClass = "full_gpu";
        reasons.push(`llama.cpp native fit: ~${native.gpuTotalGB} GB fits across the detected GPU allocation.`);
      } else if (candidate.isMoe) {
        fitClass = "hybrid_workable";
        reasons.push(`llama.cpp native fit (cpu-moe): ~${native.gpuTotalGB} GB on GPU, ~${native.hostTotalGB} GB on host RAM. MoE experts run on CPU.`);
      } else {
        fitClass = "hybrid_workable";
        reasons.push(`llama.cpp native fit: ~${native.gpuTotalGB} GB GPU + ~${native.hostTotalGB} GB host.`);
      }
      return { fitClass, gpuGB: native.gpuTotalGB, hostGB: native.hostTotalGB, cpuMoe: candidate.isMoe, gpuLayers: "auto", confidence: "runtime_estimated", fitSource: "llama_fit_params", reasons, warnings, rawFitter: native.raw };
    }
  }

  // 2) Architecture-aware fallback.
  const est = estimateArchitectureMemory({
    totalParamsB: candidate.totalParamsB,
    activeParamsB: candidate.activeParamsB,
    isMoe: candidate.isMoe,
    blockCount: candidate.blockCount,
    headCountKv: candidate.headCountKv,
    headDim: candidate.headDim,
    quant: candidate.quant ?? "Q4_K_M",
    fileSizeBytes: candidate.sizeBytes,
    contextTokens,
    parallelSlots: 1,
    cacheType,
  });
  if (candidate.loaded) {
    const totalVram = Math.max(0, ...hw.gpus.map((gpu) => gpu.totalVramGB));
    const gpuGB = Math.min(est.requiredGB, Math.max(0, totalVram - 1));
    return {
      fitClass: est.requiredGB <= Math.max(0, totalVram - 1) ? "full_gpu" : "hybrid_workable",
      gpuGB,
      hostGB: Math.max(0, est.requiredGB - gpuGB),
      cpuMoe: candidate.isMoe,
      gpuLayers: "auto",
      confidence: "runtime_estimated",
      fitSource: "llama_server_live",
      reasons,
      warnings,
    };
  }
  const cls = classifyArchitectureFit({
    estimate: est,
    freeVramGB: freeVramNow,
    freeRamGB: hw.freeRamGB,
    hostReserveGB: hw.recommendedHostReserveGB,
    gpuReserveGB: 1,
    isMoe: candidate.isMoe,
    supportsCpuMoe: runtimes.llamaCpp.capabilities?.cpuMoe ?? candidate.path !== null,
  });
  reasons.push(`Estimated ~${est.requiredGB} GB (${est.weightsGB} GB weights + ${est.kvCacheGB} GB KV @ ${cacheType} + ${est.computeGB} GB). ${cls.rationale}`);
  return { fitClass: cls.fitClass, gpuGB: Math.min(est.requiredGB, freeVramNow), hostGB: Math.max(0, est.requiredGB - freeVramNow), cpuMoe: cls.cpuMoe, gpuLayers: cls.gpuLayers, confidence: candidate.path ? "metadata_estimated" : "catalog_estimated", fitSource: "internal_estimator", reasons, warnings };
}

function laneScore(model: RankedModel, lane: Lane, task: ModelTask): number {
  if (model.fitClass === "cannot_load") return 0;
  const installed = model.source === "local_gguf" || model.source === "ollama_installed";
  const quality = model.totalParamsB ?? 7;
  const taskMatch = task !== "general" && model.capabilities.includes(task);
  let score = 0;

  if (lane === "quality") {
    // Bigger/stronger preferred; workable hybrids are welcome (a better hybrid
    // must be able to beat a small full-GPU model here).
    score += Math.min(45, quality * 1.2);
    score += FIT_RANK[model.fitClass] * 2;
    if (model.fitClass === "memory_risky") score -= 25;
    if (installed) score += model.source === "local_gguf" ? 25 : 20;
    if (taskMatch) score += 15;
    if (model.confidence === "measured") score += 5;
  } else if (lane === "fast") {
    // Responsiveness dominates: full-GPU wins; hybrids are penalized; smaller is faster.
    score += model.fitClass === "full_gpu" ? 60 : model.fitClass === "hybrid_fast" ? 20 : model.fitClass === "hybrid_workable" ? 5 : -25;
    score -= Math.min(30, quality);
    if (installed) score += 12;
    if (taskMatch) score += 8;
    if (model.performance.generationTokensPerSecond !== null) {
      score += Math.min(30, model.performance.generationTokensPerSecond);
    }
  } else {
    // Balanced: prefer a modern mid-size model with a good fit; penalize very large.
    score += FIT_RANK[model.fitClass] * 5;
    score += Math.min(22, quality);
    if (quality > 24) score -= quality - 24;
    if (installed) score += 18;
    if (taskMatch) score += 12;
    if (model.confidence === "measured") score += 8;
  }
  return Math.round(score);
}

function measuredPerformance(calibration: CalibrationRecord | null): RankedModel["performance"] {
  return {
    generationTokensPerSecond: calibration?.metrics.generationTokensPerSecond ?? null,
    timeToFirstTokenMs: calibration?.metrics.timeToFirstTokenMs ?? null,
    measuredAt: calibration?.measuredAt ?? null,
  };
}

function meetsHardRequirements(model: RankedModel, opts: { vision: boolean; tools: boolean }): boolean {
  if (opts.vision && !model.capabilities.includes("vision")) return false;
  if (opts.tools && !model.capabilities.includes("tools")) return false;
  return true;
}

export async function recommendLocalModelsV2(options?: {
  task?: ModelTask;
  preference?: Preference;
  contextTokens?: number;
  visionRequired?: boolean;
  toolsRequired?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  hardware?: HardwareProfileV2;
  runtimes?: RuntimeInventory;
  localArtifacts?: LocalModelArtifact[];
  ollamaModels?: OllamaInstalledModel[];
}): Promise<RecommendationResultV2> {
  const task: ModelTask = options?.task ?? "general";
  const preference: Preference = options?.preference ?? "balanced";
  const contextTokens = options?.contextTokens ?? 8192;
  const hw = options?.hardware ?? detectHardwareV2();
  const detectedRuntimes = options?.runtimes ?? detectRuntimes({ env: options?.env });
  const llamaCppState = options?.runtimes
    ? {
        endpoint: detectedRuntimes.llamaCpp.endpoint ?? "http://127.0.0.1:8080",
        serviceUp: detectedRuntimes.llamaCpp.serviceUp ?? false,
        loadedModels: detectedRuntimes.llamaCpp.loadedModels ?? [],
      }
    : await fetchLlamaCppRuntimeState({
        endpoint: detectedRuntimes.llamaCpp.endpoint,
        fetchImpl: options?.fetchImpl,
      });
  const local = options?.localArtifacts ?? discoverLocalModels({ env: options?.env });
  const ollamaInventory = options?.ollamaModels
    ? { serviceUp: detectedRuntimes.ollama.serviceUp, models: options.ollamaModels }
    : await fetchOllamaInventory({ endpoint: detectedRuntimes.ollama.endpoint, fetchImpl: options?.fetchImpl });
  const ollama = ollamaInventory.models;
  const runtimes: RuntimeInventory = {
    ...detectedRuntimes,
    llamaCpp: { ...detectedRuntimes.llamaCpp, ...llamaCppState },
    ollama: { ...detectedRuntimes.ollama, serviceUp: ollamaInventory.serviceUp },
  };
  const catalog = await loadCatalog({ env: options?.env, fetchImpl: options?.fetchImpl });
  const notes = [...runtimes.notes];

  const ranked: RankedModel[] = [];

  // Local GGUF artifacts (strongest availability + metadata evidence).
  for (const art of local) {
    const md = art.metadata;
    const loaded = isLoadedInLlamaServer(art, runtimes.llamaCpp.loadedModels ?? []);
    const fit = computeFit(
      { totalParamsB: md?.totalParamsB ?? null, activeParamsB: md?.activeParamsB ?? null, isMoe: md?.isMoe ?? false, quant: md?.quantization ?? null, blockCount: md?.blockCount ?? null, headCountKv: md?.headCountKv ?? null, headDim: md?.headDim ?? null, path: art.path, sizeBytes: art.sizeBytes, loaded },
      hw, runtimes, contextTokens,
    );
    const caps = localCapabilities(art, catalog.models);
    const calibration = getCalibration(localCalibrationKey({
      artifact: art,
      runtime: runtimes.llamaCpp,
      hardware: hw,
      contextTokens,
      kvType: cacheTypeForContext(contextTokens),
    }));
    const cmdPlan = { modelPath: art.path, contextTokens, parallelSlots: 1, gpuLayers: fit.gpuLayers, cpuMoe: fit.cpuMoe, keyType: cacheTypeForContext(contextTokens), valueType: cacheTypeForContext(contextTokens), capabilities: runtimes.llamaCpp.capabilities, serverPath: runtimes.llamaCpp.serverPath ?? undefined, cliPath: runtimes.llamaCpp.cliPath ?? undefined };
    ranked.push({
      source: "local_gguf", modelId: art.id, displayName: art.displayName, family: md?.family ?? null,
      totalParamsB: md?.totalParamsB ?? null, activeParamsB: md?.activeParamsB ?? null, isMoe: md?.isMoe ?? false,
      quant: md?.quantization ?? null, contextMax: md?.contextLength ?? null, capabilities: caps,
      path: art.path, ollamaTag: null, sizeBytes: art.sizeBytes,
      fitClass: fit.fitClass, confidence: calibration ? "measured" : fit.confidence, fitSource: calibration ? "live_benchmark" : fit.fitSource, gpuGB: fit.gpuGB, hostGB: fit.hostGB,
      cpuMoe: fit.cpuMoe, gpuLayers: fit.gpuLayers,
      commands: { llamaServer: buildLlamaServerCommand(cmdPlan), llamaCli: buildLlamaCliCommand(cmdPlan) },
      reasons: calibration
        ? [`Measured ${calibration.metrics.generationTokensPerSecond ?? "unknown"} tokens/s on this exact file, runtime, hardware, context, and KV configuration.`, ...fit.reasons]
        : fit.reasons,
      warnings: fit.warnings,
      performance: measuredPerformance(calibration),
      score: 0, lane: null, rawFitterOutput: fit.rawFitter,
    });
  }

  // Ollama installed models.
  for (const m of ollama) {
    const totalParamsB = parseParamB(m.parameterSize);
    const fit = computeFit({ totalParamsB, activeParamsB: totalParamsB, isMoe: false, quant: m.quantization, blockCount: null, headCountKv: null, headDim: null, path: null, sizeBytes: m.sizeBytes }, hw, runtimes, contextTokens);
    const ollamaCmd = buildOllamaCommand(m.tag, contextTokens);
    const calibration = getCalibration(ollamaCalibrationKey({
      tag: m.tag,
      sizeBytes: m.sizeBytes,
      runtime: runtimes.ollama,
      hardware: hw,
      contextTokens,
    }));
    ranked.push({
      source: "ollama_installed", modelId: `ollama:${m.tag}`, displayName: m.tag, family: m.family,
      totalParamsB, activeParamsB: totalParamsB, isMoe: false, quant: m.quantization, contextMax: m.contextLength,
      capabilities: m.capabilities, path: null, ollamaTag: m.tag, sizeBytes: m.sizeBytes,
      fitClass: fit.fitClass, confidence: calibration ? "measured" : "runtime_estimated", fitSource: calibration ? "live_benchmark" : "ollama_show", gpuGB: fit.gpuGB, hostGB: fit.hostGB,
      cpuMoe: fit.cpuMoe, gpuLayers: fit.gpuLayers, commands: { ollama: ollamaCmd ?? undefined },
      reasons: calibration
        ? [`Measured ${calibration.metrics.generationTokensPerSecond ?? "unknown"} tokens/s on this exact Ollama tag and hardware configuration.`, ...fit.reasons]
        : fit.reasons,
      warnings: fit.warnings,
      performance: measuredPerformance(calibration),
      score: 0, lane: null,
    });
  }

  // Catalog download suggestions (only for families not already present locally/installed).
  const haveFamilies = new Set(ranked.map((r) => (r.family ?? "").toLowerCase()).filter(Boolean));
  for (const c of recommendableCatalogModels(catalog)) {
    if (haveFamilies.has(c.family.toLowerCase())) continue;
    const variant = c.variants.find((v) => v.runtime === "ollama") ?? c.variants[0];
    const fit = computeFit({ totalParamsB: c.totalParamsB, activeParamsB: c.activeParamsB, isMoe: c.architecture === "moe", quant: variant?.quantization ?? "Q4_K_M", blockCount: null, headCountKv: null, headDim: null, path: null, sizeBytes: variant?.sizeBytes ?? null }, hw, runtimes, contextTokens);
    ranked.push({
      source: "catalog", modelId: c.id, displayName: c.displayName, family: c.family,
      totalParamsB: c.totalParamsB, activeParamsB: c.activeParamsB, isMoe: c.architecture === "moe",
      quant: variant?.quantization ?? null, contextMax: c.contextMax, capabilities: c.capabilities,
      path: null, ollamaTag: variant?.runtime === "ollama" ? variant.exactId : null, sizeBytes: variant?.sizeBytes ?? null,
      fitClass: fit.fitClass, confidence: "catalog_estimated", fitSource: fit.fitSource, gpuGB: fit.gpuGB, hostGB: fit.hostGB,
      cpuMoe: fit.cpuMoe, gpuLayers: fit.gpuLayers,
      commands: { ollama: buildOllamaCommand(variant?.runtime === "ollama" ? variant.exactId : null, contextTokens) ?? undefined },
      reasons: fit.reasons, warnings: [...fit.warnings, c.status === "legacy" ? "Older model kept for compatibility; newer families usually preferred." : c.status === "catalogued" ? "Catalog entry pending runtime verification." : ""].filter(Boolean),
      performance: measuredPerformance(null),
      score: 0, lane: null,
    });
  }

  // Score lanes.
  const hard = { vision: options?.visionRequired ?? (task === "vision"), tools: options?.toolsRequired ?? false };
  const eligible = ranked.filter((r) =>
    r.fitClass !== "cannot_load" &&
    meetsHardRequirements(r, hard) &&
    isChatCapable(r.capabilities) &&
    (r.contextMax === null || r.contextMax >= contextTokens)
  );
  const pickLane = (lane: Lane): RankedModel | null => {
    const scored = eligible.map((m) => ({ m, s: laneScore(m, lane, task) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (scored[0]) scored[0].m.lane = scored[0].m.lane ?? lane;
    return scored[0]?.m ?? null;
  };
  const quality = pickLane("quality");
  const fast = pickLane("fast");
  const balanced = pickLane("balanced");

  for (const r of ranked) r.score = Math.max(laneScore(r, "quality", task), laneScore(r, "balanced", task), laneScore(r, "fast", task));
  const installed = ranked.filter((r) => r.source !== "catalog").sort((a, b) => b.score - a.score);
  const constrained = ranked.filter((r) => r.fitClass === "cannot_load" || r.fitClass === "memory_risky");

  return {
    hardware: hw, runtimes, task, preference, contextTokens,
    installed,
    lanes: { quality, balanced, fast },
    allCandidates: ranked.sort((a, b) => b.score - a.score),
    constrained,
    catalog: { source: catalog.source, state: catalog.state, generatedAt: catalog.freshness.generatedAt },
    notes,
  };
}
