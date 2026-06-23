import { detectHardware, type HardwareProfile } from "./detect-hardware";
import { loadModelRegistry, type ModelTask, type RegistryModel } from "./model-registry";
import { classifyFit, computeGpuLayers, estimateLayers, estimateModelMemory, estimateSpeed, type FitClass, type SpeedClass } from "./estimate-memory";
import { scoreModel } from "./score-model";
import { ollamaCommands } from "./runtimes/ollama";
import { llamaCppCommands, type LlamaCppCommands } from "./runtimes/llama-cpp";
import { mlxCommand } from "./runtimes/mlx";

export type ModelRecommendation = {
  id: string;
  name: string;
  paramsB: number;
  quant: string;
  contextTokens: number;
  fit: FitClass;
  speed: SpeedClass;
  score: number;
  requiredGB: number;
  reasons: string[];
  warnings: string[];
  commands: { ollama?: { pull: string; run: string }; llamaCpp?: LlamaCppCommands; mlx?: string };
};

export type RecommendationResult = {
  hardware: HardwareProfile;
  task: ModelTask;
  contextTokens: number;
  registrySource: "bundled";
  recommendations: ModelRecommendation[];
  best: ModelRecommendation | null;
};

function evaluate(
  model: RegistryModel,
  hw: HardwareProfile,
  task: ModelTask,
  contextTokens: number,
): ModelRecommendation {
  const mem = estimateModelMemory({ paramsB: model.paramsB, quant: model.quant, contextTokens });
  const fit = classifyFit({
    requiredGB: mem.requiredGB,
    availableRamGB: hw.totalRamGB,
    availableVramGB: hw.totalVramGB,
  });
  const speed = estimateSpeed(fit, model.paramsB);
  const score = scoreModel({ model, fit, speed, task, contextTokens });

  const totalLayers = model.layers ?? estimateLayers(model.paramsB);
  const gpuLayers = computeGpuLayers({
    fit,
    totalLayers,
    weightsGB: mem.weightsGB,
    usableVramGB: hw.totalVramGB * 0.9,
    kvCacheGB: mem.kvCacheGB,
  });
  const llamaCpp = llamaCppCommands({
    model,
    contextTokens,
    gpuLayers,
    totalLayers,
    cpuThreads: Math.max(1, Math.floor(hw.cpuCores / 2)),
  });

  const reasons: string[] = [];
  const warnings: string[] = [];

  reasons.push(`~${mem.requiredGB} GB needed (${mem.weightsGB} GB weights @ ${model.quant} + ${mem.kvCacheGB} GB KV + ${mem.overheadGB} GB overhead).`);
  if (fit === "full_gpu") reasons.push(`Fits fully in ${hw.totalVramGB} GB VRAM — offload all ${totalLayers} layers (-ngl ${gpuLayers}).`);
  else if (fit === "partial_offload") { reasons.push(`Partial offload: put ~${gpuLayers}/${totalLayers} layers on GPU (-ngl ${gpuLayers}), the rest on CPU/RAM. llama.cpp/llama-server give finer control here than Ollama.`); warnings.push("Partial offload is slower than full-GPU and uses both VRAM and RAM."); }
  else if (fit === "cpu_only") { reasons.push(`Runs on CPU using system RAM (${hw.totalRamGB} GB total), -ngl 0.`); warnings.push("CPU-only inference is noticeably slower, especially for larger models."); }
  else warnings.push(`Needs ~${mem.requiredGB} GB but the machine has ${hw.totalRamGB} GB RAM / ${hw.totalVramGB} GB VRAM — not recommended.`);

  if (task !== "general" && !model.tasks.includes(task)) warnings.push(`Not specialized for "${task}" tasks.`);
  if (model.contextDefault < contextTokens) warnings.push(`Default context (${model.contextDefault}) is below the requested ${contextTokens} tokens.`);

  return {
    id: model.id,
    name: model.name,
    paramsB: model.paramsB,
    quant: model.quant,
    contextTokens,
    fit,
    speed,
    score,
    requiredGB: mem.requiredGB,
    reasons,
    warnings,
    commands: {
      ollama: ollamaCommands(model) ?? undefined,
      llamaCpp,
      mlx: mlxCommand(model, hw.platform, hw.arch) ?? undefined,
    },
  };
}

export async function recommendLocalModels(options?: {
  task?: ModelTask;
  contextTokens?: number;
  hardware?: HardwareProfile;
  limit?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<RecommendationResult> {
  const hw = options?.hardware ?? detectHardware();
  const task: ModelTask = options?.task ?? "general";
  const contextTokens = options?.contextTokens ?? 8192;
  const registry = await loadModelRegistry({ env: options?.env, fetchImpl: options?.fetchImpl });

  const evaluated = registry.models
    .map((m) => evaluate(m, hw, task, contextTokens))
    .filter((r) => r.fit !== "not_recommended")
    .sort((a, b) => b.score - a.score);

  const recommendations = evaluated.slice(0, options?.limit ?? 5);
  return {
    hardware: hw,
    task,
    contextTokens,
    registrySource: registry.source,
    recommendations,
    best: recommendations[0] ?? null,
  };
}

/** Render a concise human/agent-readable summary. */
export function renderRecommendations(result: RecommendationResult): string {
  const hw = result.hardware;
  const lines: string[] = [];
  lines.push(`# Local model recommendations (${result.task}, ${result.contextTokens} ctx)`);
  lines.push(`Machine: ${hw.platform}/${hw.arch}, ${hw.cpuCores}-core ${hw.cpuModel}, ${hw.totalRamGB} GB RAM, ${hw.totalVramGB} GB VRAM${hw.unifiedMemory ? " (unified)" : ""}.`);
  if (hw.gpus.length) lines.push(`GPU: ${hw.gpus.map((g) => `${g.name}${g.vramGB ? ` (${g.vramGB} GB)` : ""}`).join("; ")}`);
  lines.push(`Registry: ${result.registrySource}.`);
  if (!result.best) {
    lines.push("\nNo listed model is a comfortable fit for this machine. Try a smaller model or more RAM/VRAM.");
    return lines.join("\n");
  }
  lines.push("");
  result.recommendations.forEach((r, i) => {
    lines.push(`## ${i + 1}. ${r.name} — ${r.fit.replace("_", " ")}, ${r.speed} (score ${r.score})`);
    lines.push(r.reasons.join(" "));
    if (r.warnings.length) lines.push(`Warnings: ${r.warnings.join(" ")}`);
    if (r.commands.ollama) lines.push(`Ollama: \`${r.commands.ollama.run}\``);
    if (r.commands.llamaCpp) {
      lines.push(`llama.cpp (CLI): \`${r.commands.llamaCpp.cli}\``);
      lines.push(`llama-server (OpenAI-compatible): \`${r.commands.llamaCpp.server}\``);
      if (r.commands.llamaCpp.download) lines.push(`Download GGUF: \`${r.commands.llamaCpp.download}\``);
    }
    if (r.commands.mlx) lines.push(`MLX: \`${r.commands.mlx}\``);
    lines.push("");
  });
  return lines.join("\n").trim();
}
