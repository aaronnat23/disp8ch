#!/usr/bin/env tsx
/**
 * model-fit-advisor regression: memory estimation, fit classification, scoring,
 * static bundled registry, and end-to-end recommendation with fake hardware.
 */
import { bytesPerWeight, classifyFit, computeGpuLayers, estimateLayers, estimateModelMemory, estimateSpeed } from "@/lib/model-fit/estimate-memory";
import { scoreModel } from "@/lib/model-fit/score-model";
import { loadModelRegistry, BUNDLED_REGISTRY } from "@/lib/model-fit/model-registry";
import { recommendLocalModels, renderRecommendations } from "@/lib/model-fit/recommend-models";
import type { HardwareProfile } from "@/lib/model-fit/detect-hardware";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

function hw(p: Partial<HardwareProfile>): HardwareProfile {
  return {
    platform: "linux", arch: "x64", cpuModel: "Test CPU", cpuCores: 8,
    totalRamGB: 16, freeRamGB: 8, gpus: [], totalVramGB: 0, unifiedMemory: false, detectionNotes: [],
    ...p,
  };
}

async function main() {
  // --- memory estimation ---
  check("bpw.known", bytesPerWeight("Q4_K_M") === 0.6);
  check("bpw.default", bytesPerWeight("weird-quant") === 0.6);
  const m7 = estimateModelMemory({ paramsB: 7, quant: "q4_k_m", contextTokens: 8192 });
  check("estimate.7bWeights", Math.abs(m7.weightsGB - 4.2) < 0.1);
  check("estimate.requiredIncludesKvOverhead", m7.requiredGB > m7.weightsGB);

  // --- fit classification ---
  check("fit.fullGpu", classifyFit({ requiredGB: 5.5, availableRamGB: 32, availableVramGB: 24 }) === "full_gpu");
  check("fit.cpuOnly", classifyFit({ requiredGB: 5.5, availableRamGB: 32, availableVramGB: 0 }) === "cpu_only");
  check("fit.partialOffload", classifyFit({ requiredGB: 19, availableRamGB: 32, availableVramGB: 8 }) === "partial_offload");
  check("fit.notRecommended", classifyFit({ requiredGB: 45, availableRamGB: 8, availableVramGB: 0 }) === "not_recommended");

  // --- speed + scoring ---
  check("speed.fullGpuSmallFast", estimateSpeed("full_gpu", 7) === "fast");
  check("speed.cpuBigVerySlow", estimateSpeed("cpu_only", 32) === "very_slow");
  const coder = BUNDLED_REGISTRY.models.find((x) => x.id === "qwen2.5-coder-7b")!;
  const generic = BUNDLED_REGISTRY.models.find((x) => x.id === "llama3.1-8b")!;
  const coderScore = scoreModel({ model: coder, fit: "full_gpu", speed: "fast", task: "coding", contextTokens: 8192 });
  const genericScore = scoreModel({ model: generic, fit: "full_gpu", speed: "fast", task: "coding", contextTokens: 8192 });
  check("score.codingPrefersCoder", coderScore > genericScore);
  check("score.notRecommendedZero", scoreModel({ model: coder, fit: "not_recommended", speed: "very_slow", task: "coding", contextTokens: 8192 }) === 0);

  // --- static registry ignores remote configuration and never fetches ---
  let fetched = false;
  const throwingFetch = (async () => { fetched = true; throw new Error("must not fetch"); }) as unknown as typeof fetch;
  const loaded = await loadModelRegistry({ fetchImpl: throwingFetch, force: true });
  check("registry.staticBundled", loaded.source === "bundled" && loaded.models.length === BUNDLED_REGISTRY.models.length);
  check("registry.neverFetches", fetched === false);

  // --- end-to-end recommendation (fake hardware, bundled registry) ---
  const beefy = await recommendLocalModels({ task: "coding", contextTokens: 8192, hardware: hw({ totalRamGB: 64, totalVramGB: 24, gpus: [{ name: "RTX 4090", vramGB: 24 }] }), env: {} as NodeJS.ProcessEnv, force: true } as never);
  check("reco.bestIsCodingFullGpu", beefy.best?.fit === "full_gpu" && (beefy.best?.id.includes("coder") ?? false));
  check("reco.hasOllamaCommand", Boolean(beefy.best?.commands.ollama?.run.startsWith("ollama run")));
  check("reco.hasLlamaCli", Boolean(beefy.best?.commands.llamaCpp?.cli.includes("llama-cli") && beefy.best?.commands.llamaCpp?.cli.includes("-ngl")));
  check("reco.hasLlamaServer", Boolean(beefy.best?.commands.llamaCpp?.server.includes("llama-server") && beefy.best?.commands.llamaCpp?.server.includes("--port 8080")));
  check("reco.fullGpuOffloadsAllLayers", beefy.best?.commands.llamaCpp?.gpuLayers === beefy.best?.commands.llamaCpp?.totalLayers);

  // --- precise partial offload: a 32B coder on a 12GB GPU offloads SOME (not all/none) layers ---
  const partial = await recommendLocalModels({ task: "coding", contextTokens: 8192, hardware: hw({ totalRamGB: 64, totalVramGB: 12, gpus: [{ name: "RTX 4070", vramGB: 12 }] }), env: {} as NodeJS.ProcessEnv } as never);
  const partial32b = partial.recommendations.find((r) => r.id === "qwen2.5-coder-32b");
  check("offload.32bIsPartial", partial32b?.fit === "partial_offload");
  check("offload.partialLayersBetween", Boolean(partial32b && partial32b.commands.llamaCpp!.gpuLayers > 0 && partial32b.commands.llamaCpp!.gpuLayers < partial32b.commands.llamaCpp!.totalLayers));

  // --- pure layer math ---
  check("layers.estimate7b", estimateLayers(7) === 32);
  check("gpuLayers.fullAll", computeGpuLayers({ fit: "full_gpu", totalLayers: 40, weightsGB: 8, usableVramGB: 24, kvCacheGB: 2 }) === 40);
  check("gpuLayers.cpuZero", computeGpuLayers({ fit: "cpu_only", totalLayers: 40, weightsGB: 8, usableVramGB: 0, kvCacheGB: 2 }) === 0);
  const pl = computeGpuLayers({ fit: "partial_offload", totalLayers: 64, weightsGB: 19, usableVramGB: 11, kvCacheGB: 3 });
  check("gpuLayers.partialFraction", pl > 0 && pl < 64);

  const tiny = await recommendLocalModels({ task: "chat", contextTokens: 4096, hardware: hw({ totalRamGB: 6, totalVramGB: 0 }), env: {} as NodeJS.ProcessEnv } as never);
  check("reco.tinyMachineSmallModels", tiny.best !== null && tiny.best.paramsB <= 8 && tiny.best.fit === "cpu_only");
  check("reco.tinyExcludesHuge", !tiny.recommendations.some((r) => r.paramsB >= 32));

  const render = renderRecommendations(beefy);
  check("render.hasHeader", render.includes("Local model recommendations") && render.includes("Ollama:"));

  const failed = results.filter((r) => !r.ok);
  console.log(`\nmodel-fit-regression: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.error("Failed:", failed.map((r) => r.name).join(", "));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
