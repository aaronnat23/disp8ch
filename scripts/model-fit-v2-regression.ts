#!/usr/bin/env tsx
/**
 * model-fit advisor V2 regression: GGUF reader/normalize (dense + MoE + malformed),
 * architecture estimator (MoE storage vs active compute), native-fit parser,
 * command generation (exact paths, -np 1, no unsupported flags, injection-safe),
 * catalog validation/freshness, and ranking lanes (local MoE wins quality lane,
 * capability filters, legacy not preferred, catalog cannot outrank local).
 *
 * Uses synthesized GGUF fixtures + injected hardware — no user files or real machine.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGgufMetadata } from "@/lib/model-fit/metadata/gguf-reader";
import { normalizeGguf } from "@/lib/model-fit/metadata/normalize";
import { estimateArchitectureMemory, classifyArchitectureFit } from "@/lib/model-fit/fit/architecture";
import { parseNativeFitOutput } from "@/lib/model-fit/fit/llama-native";
import { buildLlamaServerCommand, buildOllamaCommand } from "@/lib/model-fit/fit/commands";
import { validateCatalogModel, freshnessState } from "@/lib/model-fit/catalog/schema";
import { BUNDLED_CATALOG, loadCatalog, recommendableCatalogModels } from "@/lib/model-fit/catalog/load";
import { recommendLocalModelsV2 } from "@/lib/model-fit/recommend-v2";
import type { HardwareProfileV2, RuntimeInventory, LocalModelArtifact } from "@/lib/model-fit/inventory/types";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

// ── GGUF fixture builder ──
function gstr(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(b.length));
  return Buffer.concat([len, b]);
}
function kvString(key: string, val: string): Buffer {
  return Buffer.concat([gstr(key), u32(8), gstr(val)]);
}
function kvU32(key: string, val: number): Buffer {
  return Buffer.concat([gstr(key), u32(4), u32(val)]);
}
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function u64(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function buildGguf(kvs: Buffer[]): Buffer {
  const header = Buffer.concat([Buffer.from("GGUF", "ascii"), u32(3), u64(0), u64(kvs.length)]);
  return Buffer.concat([header, ...kvs]);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-mf-"));

  // ── GGUF reader + normalize: MoE ──
  const moePath = path.join(tmp, "moe.gguf");
  fs.writeFileSync(moePath, buildGguf([
    kvString("general.architecture", "qwen35moe"),
    kvString("general.name", "TestQwen 35B-A3B"),
    kvString("general.size_label", "35B-A3B"),
    kvU32("general.file_type", 15),
    kvU32("qwen35moe.block_count", 41),
    kvU32("qwen35moe.embedding_length", 2048),
    kvU32("qwen35moe.attention.head_count", 16),
    kvU32("qwen35moe.attention.head_count_kv", 2),
    kvU32("qwen35moe.context_length", 262144),
    kvU32("qwen35moe.expert_count", 256),
    kvU32("qwen35moe.expert_used_count", 8),
  ]));
  const moe = normalizeGguf(readGgufMetadata(moePath), "moe.gguf");
  check("gguf.moeArch", moe.architecture === "qwen35moe" && moe.isMoe === true);
  check("gguf.moeTotalActive", moe.totalParamsB === 35 && moe.activeParamsB === 3);
  check("gguf.moeMetadataConfidence", moe.paramConfidence === "metadata");
  check("gguf.moeLayersKv", moe.blockCount === 41 && moe.headCountKv === 2 && moe.quantization === "Q4_K_M");

  // ── GGUF dense ──
  const densePath = path.join(tmp, "dense.gguf");
  fs.writeFileSync(densePath, buildGguf([
    kvString("general.architecture", "llama"),
    kvString("general.size_label", "8B"),
    kvU32("general.file_type", 15),
    kvU32("llama.block_count", 32),
    kvU32("llama.attention.head_count_kv", 8),
  ]));
  const dense = normalizeGguf(readGgufMetadata(densePath), "dense.gguf");
  check("gguf.denseActiveEqualsTotal", dense.totalParamsB === 8 && dense.activeParamsB === 8 && !dense.isMoe);
  const bf16Path = path.join(tmp, "bf16.gguf");
  fs.writeFileSync(bf16Path, buildGguf([
    kvString("general.architecture", "llama"),
    kvString("general.size_label", "8B"),
    kvU32("general.file_type", 32),
  ]));
  check("gguf.currentBf16Enum", normalizeGguf(readGgufMetadata(bf16Path), "bf16.gguf").quantization === "BF16");

  // ── malformed ──
  const badPath = path.join(tmp, "bad.gguf");
  fs.writeFileSync(badPath, Buffer.concat([Buffer.from("XXXX"), u32(3), u64(0), u64(0)]));
  let threw = false;
  try { readGgufMetadata(badPath); } catch { threw = true; }
  check("gguf.malformedThrows", threw);

  // ── architecture estimator: MoE storage uses total, active separate ──
  const est = estimateArchitectureMemory({ totalParamsB: 35, activeParamsB: 3, isMoe: true, blockCount: 41, headCountKv: 2, headDim: 128, quant: "Q4_K_M", fileSizeBytes: 21.1 * 1024 ** 3, contextTokens: 65536, parallelSlots: 1, cacheType: "q8_0" });
  check("arch.moeWeightsFromFile", est.weightsGB > 20 && est.weightsGB < 22);
  check("arch.moeActiveLessThanTotal", est.activeWeightsGB < est.weightsGB && est.activeWeightsGB < 3);
  check("arch.kvNotZero", est.kvCacheGB > 0);
  const cls = classifyArchitectureFit({ estimate: est, freeVramGB: 15.9, freeRamGB: 31, hostReserveGB: 6, gpuReserveGB: 1, isMoe: true, supportsCpuMoe: true });
  check("arch.moeIsHybridNotRejected", cls.fitClass === "hybrid_fast" || cls.fitClass === "hybrid_workable");
  check("arch.moeCpuMoe", cls.cpuMoe === true);

  // ── native-fit parser ──
  const parsed = parseNativeFitOutput("0.00 I llama_fit_params: ...\nCUDA0 21087 1342 497 \nHost 515 0 136\n");
  check("native.parseDevices", parsed.devices.length === 1 && parsed.devices[0].device === "CUDA0" && parsed.devices[0].totalMiB === 21087 + 1342 + 497);
  check("native.parseHost", parsed.host !== null && parsed.host.modelMiB === 515);

  // ── command generation ──
  const caps = { ngedAuto: true, fit: true, fitTarget: true, cacheTypeK: true, cacheTypeV: true, cpuMoe: true, nCpuMoe: true, splitMode: true, tensorSplit: true, specType: true };
  const cmd = buildLlamaServerCommand({ modelPath: "C:\\Models\\Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", contextTokens: 65536, parallelSlots: 1, gpuLayers: "auto", cpuMoe: true, keyType: "q8_0", valueType: "q8_0", capabilities: caps, serverPath: "C:\\llama.cpp\\bin\\llama-server.exe", port: 8081 });
  check("cmd.exactQuotedPath", cmd.includes('"C:\\Models\\Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"'));
  check("cmd.np1", /\-np 1\b/.test(cmd));
  check("cmd.nglAutoFit", cmd.includes("-ngl auto") && cmd.includes("--fit on"));
  check("cmd.cpuMoe", cmd.includes("--cpu-moe"));
  check("cmd.cacheTypeWhenNotF16", cmd.includes("--cache-type-k q8_0"));
  check("cmd.loopbackPort", cmd.includes("--host 127.0.0.1 --port 8081"));
  // injection safety
  let unsafeRejected = false;
  try {
    buildLlamaServerCommand({ modelPath: 'C:\\m\\" & whoami.gguf', contextTokens: 8192, parallelSlots: 1, gpuLayers: "auto", cpuMoe: false, keyType: "f16", valueType: "f16", capabilities: caps });
  } catch {
    unsafeRejected = true;
  }
  check("cmd.injectionRejected", unsafeRejected);
  // unsupported flags excluded
  const noCaps = buildLlamaServerCommand({ modelPath: "/m/x.gguf", contextTokens: 8192, parallelSlots: 1, gpuLayers: "auto", cpuMoe: true, keyType: "f16", valueType: "f16", capabilities: { ...caps, cpuMoe: false } });
  check("cmd.noUnsupportedCpuMoe", !noCaps.includes("--cpu-moe"));
  // ollama tag validation
  check("ollama.validTag", buildOllamaCommand("qwen3.6:35b-a3b", 8192)?.run === "ollama run qwen3.6:35b-a3b");
  check("ollama.nullTagNoCommand", buildOllamaCommand(null, 8192) === null);
  check("ollama.unsafeTagRejected", buildOllamaCommand("qwen3.6:7b & whoami", 8192) === null);
  check("ollama.largeCtxNote", Boolean(buildOllamaCommand("gemma4:12b", 65536)?.note?.includes("num_ctx")));

  // ── catalog ──
  check("catalog.bundledHasModernFamilies", BUNDLED_CATALOG.models.some((m) => m.id === "qwen3.6-35b-a3b") && BUNDLED_CATALOG.models.some((m) => m.family === "gemma"));
  check("catalog.allBundledEntriesValidate", BUNDLED_CATALOG.models.length === 7 && BUNDLED_CATALOG.models.every(validateCatalogModel));
  check("catalog.validateRejectsBad", !validateCatalogModel({ id: "x" }));
  check("catalog.validateRejectsDupVariant", !validateCatalogModel({
    ...BUNDLED_CATALOG.models[0],
    id: "duplicate-test",
    variants: [
      { runtime: "ollama", exactId: "safe:tag", quantization: "Q4_K_M", sourceUrl: "https://example.com/a", sizeBytes: null },
      { runtime: "ollama", exactId: "safe:tag", quantization: "Q4_K_M", sourceUrl: "https://example.com/a", sizeBytes: null },
    ],
  }));
  check("catalog.freshness", freshnessState(new Date().toISOString()) === "fresh" && freshnessState("2020-01-01T00:00:00Z") === "stale");
  check("catalog.recommendableExcludesDiscovered", !recommendableCatalogModels({ ...BUNDLED_CATALOG, models: [{ ...BUNDLED_CATALOG.models[0], status: "discovered" }] }).length);
  check("catalog.recommendableExcludesCatalogued", !recommendableCatalogModels({ ...BUNDLED_CATALOG, models: [{ ...BUNDLED_CATALOG.models[0], status: "catalogued" }] }).length);
  check("catalog.officialExactTags", BUNDLED_CATALOG.models.some((m) => m.id === "gemma4-12b" && m.variants.some((v) => v.exactId === "gemma4:12b-it-q4_K_M")) && !JSON.stringify(BUNDLED_CATALOG).includes("gemma4:27b"));
  check("catalog.gemmaMoeCorrect", BUNDLED_CATALOG.models.some((m) => m.id === "gemma4-26b-a4b" && m.architecture === "moe" && m.activeParamsB === 4));

  const staticCatalog = await loadCatalog({
    force: true,
    fetchImpl: async () => { throw new Error("The static catalog must not fetch"); },
  });
  check("catalog.staticReleaseList", staticCatalog.source === "bundled" && staticCatalog.models.length === BUNDLED_CATALOG.models.length);

  // ── ranking lanes (injected inventory, no native fitter → architecture estimator) ──
  const hw: HardwareProfileV2 = { platform: "win32", arch: "x64", cpuModel: "Test", logicalCores: 16, physicalCores: 8, totalRamGB: 31, freeRamGB: 28, recommendedHostReserveGB: 6, gpus: [{ index: 0, name: "RTX 5070 Ti", vendor: "nvidia", totalVramGB: 15.9, freeVramGB: 14.5, driverVersion: "1" }], unifiedMemory: false, detectionNotes: [] };
  const rt: RuntimeInventory = { llamaCpp: { available: true, binDir: "C:\\llama.cpp\\bin", serverPath: "C:\\llama.cpp\\bin\\llama-server.exe", cliPath: null, fitParamsPath: null, version: "1", capabilities: caps }, ollama: { available: true, version: "0.30", serviceUp: true, endpoint: "http://127.0.0.1:11434" }, notes: [] };
  const local35b: LocalModelArtifact = { id: "local:q35", displayName: "Qwen3.6-35B-A3B", path: "C:\\Models\\Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", sizeBytes: 21.1 * 1024 ** 3, format: "gguf", discoveredFrom: "C:\\Models", readable: true, modifiedAt: new Date().toISOString(), metadata: { architecture: "qwen35moe", family: "qwen3", displayName: "Qwen3.6-35B-A3B", quantization: "Q4_K_M", fileType: 15, totalParamsB: 35, activeParamsB: 3, isMoe: true, blockCount: 41, embeddingLength: 2048, headCount: 16, headCountKv: 2, headDim: 128, contextLength: 262144, expertCount: 256, expertUsedCount: 8, ropeFreqBase: null, visionProjector: false, sources: ["gguf_metadata"], paramConfidence: "metadata" } };

  return Promise.all([
    (async () => {
      const r = await recommendLocalModelsV2({ task: "coding", preference: "quality", contextTokens: 65536, env: {} as NodeJS.ProcessEnv, hardware: hw, runtimes: rt, localArtifacts: [local35b], ollamaModels: [{ tag: "qwen2.5-coder:7b", sizeBytes: 4.7e9, family: "qwen2", parameterSize: "7B", quantization: "Q4_K_M", contextLength: 32768, capabilities: ["completion", "tools"] }] });
      check("rank.localMoeInQualityLane", r.lanes.quality?.modelId === "local:q35");
      check("rank.qualityIsHybridNotFullGpu", r.lanes.quality?.fitClass.startsWith("hybrid") === true);
      check("rank.qualityNotHidden", r.allCandidates.some((c) => c.modelId === "local:q35" && c.fitClass !== "cannot_load"));
      check("rank.qualityUsesRamAndVram", (r.lanes.quality?.hostGB ?? 0) > 0 && (r.lanes.quality?.gpuGB ?? 0) > 0);
      check("rank.qualityCommandExactPath", Boolean(r.lanes.quality?.commands.llamaServer?.includes('"C:\\Models\\Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"')));
      check("rank.localCapabilitiesNotTaskFabricated", r.allCandidates.find((c) => c.modelId === "local:q35")?.capabilities.includes("coding") === true);

      const lowMemoryHw = { ...hw, freeRamGB: 10 };
      const lowMemory = await recommendLocalModelsV2({ task: "coding", contextTokens: 65536, env: {} as NodeJS.ProcessEnv, hardware: lowMemoryHw, runtimes: rt, localArtifacts: [local35b], ollamaModels: [] });
      const lowMemoryLocal = lowMemory.allCandidates.find((c) => c.modelId === "local:q35");
      check("rank.currentFreeRamAffectsFit", lowMemoryLocal?.fitClass === "memory_risky" || lowMemoryLocal?.fitClass === "cpu_heavy" || lowMemoryLocal?.fitClass === "cannot_load");

      const loadedRt: RuntimeInventory = {
        ...rt,
        llamaCpp: {
          ...rt.llamaCpp,
          endpoint: "http://127.0.0.1:8080",
          serviceUp: true,
          loadedModels: ["Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"],
        },
      };
      const alreadyLoaded = await recommendLocalModelsV2({
        task: "general",
        contextTokens: 8192,
        env: {} as NodeJS.ProcessEnv,
        hardware: { ...lowMemoryHw, freeRamGB: 4, gpus: [{ ...hw.gpus[0], freeVramGB: 2.1 }] },
        runtimes: loadedRt,
        localArtifacts: [local35b],
        ollamaModels: [],
      });
      check("rank.loadedModelRemainsEligible", alreadyLoaded.lanes.quality?.modelId === "local:q35");
      check("rank.loadedModelUsesLiveEvidence", alreadyLoaded.lanes.quality?.fitSource === "llama_server_live");
      check(
        "rank.loadedModelAvoidsRepeatedCardProse",
        alreadyLoaded.lanes.quality?.reasons.every((reason) => !reason.includes("Already loaded and responding")) === true,
      );

      const small = await recommendLocalModelsV2({ task: "chat", preference: "speed", contextTokens: 8192, env: {} as NodeJS.ProcessEnv, hardware: hw, runtimes: rt, localArtifacts: [local35b], ollamaModels: [{ tag: "qwen2.5:3b", sizeBytes: 2e9, family: "qwen2", parameterSize: "3B", quantization: "Q4_K_M", contextLength: 32768, capabilities: ["completion"] }] });
      check("rank.fastPrefersSmallFullGpu", (small.lanes.fast?.totalParamsB ?? 99) <= 8);

      const visionReq = await recommendLocalModelsV2({ task: "vision", contextTokens: 8192, env: {} as NodeJS.ProcessEnv, hardware: hw, runtimes: rt, localArtifacts: [local35b], ollamaModels: [{ tag: "qwen2.5vl:7b", sizeBytes: 6e9, family: "qwen2", parameterSize: "7B", quantization: "Q4_K_M", contextLength: 128000, capabilities: ["completion", "vision"] }], visionRequired: true });
      check("rank.visionFilterExcludesNonVision", visionReq.lanes.quality === null || visionReq.lanes.quality.capabilities.includes("vision"));

      const toolsReq = await recommendLocalModelsV2({ task: "chat", contextTokens: 8192, env: {} as NodeJS.ProcessEnv, hardware: hw, runtimes: rt, localArtifacts: [], ollamaModels: [{ tag: "notools:7b", sizeBytes: 4e9, family: "x", parameterSize: "7B", quantization: "Q4_K_M", contextLength: 8192, capabilities: ["completion"] }, { tag: "withtools:7b", sizeBytes: 4e9, family: "y", parameterSize: "7B", quantization: "Q4_K_M", contextLength: 8192, capabilities: ["completion", "tools"] }], toolsRequired: true });
      check("rank.toolsFilterExcludesNoTool", toolsReq.allCandidates.filter((c) => c.lane).every((c) => c.capabilities.includes("tools")));

      const tooLong = await recommendLocalModelsV2({ task: "chat", contextTokens: 65536, env: {} as NodeJS.ProcessEnv, hardware: hw, runtimes: rt, localArtifacts: [], ollamaModels: [{ tag: "short:7b", sizeBytes: 4e9, family: "short", parameterSize: "7B", quantization: "Q4_K_M", contextLength: 8192, capabilities: ["completion"] }] });
      check("rank.contextLimitEnforced", ![tooLong.lanes.quality, tooLong.lanes.balanced, tooLong.lanes.fast].some((m) => m?.modelId === "ollama:short:7b"));

      // Embedding-only model must never win a chat lane; tiny "137M" must parse as 0.137B (not 137B).
      const withEmbed = await recommendLocalModelsV2({ task: "general", contextTokens: 8192, env: {} as NodeJS.ProcessEnv, hardware: hw, runtimes: rt, localArtifacts: [local35b], ollamaModels: [{ tag: "nomic-embed-text:latest", sizeBytes: 1.4e8, family: "nomic-bert", parameterSize: "137M", quantization: "F16", contextLength: 2048, capabilities: ["embedding"] }] });
      check("rank.embeddingExcludedFromQuality", withEmbed.lanes.quality?.modelId !== "ollama:nomic-embed-text:latest");
      check("rank.embeddingExcludedAllLanes", ![withEmbed.lanes.quality, withEmbed.lanes.balanced, withEmbed.lanes.fast].some((m) => m?.modelId === "ollama:nomic-embed-text:latest"));
      check("rank.qualityIsLocal35bWithEmbedPresent", withEmbed.lanes.quality?.modelId === "local:q35");
      const embedCand = withEmbed.allCandidates.find((c) => c.modelId === "ollama:nomic-embed-text:latest");
      check("rank.tinyParamParsedCorrectly", (embedCand?.totalParamsB ?? 99) < 1);

      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      const failed = results.filter((x) => !x.ok);
      console.log(`\nmodel-fit-v2-regression: ${results.length - failed.length}/${results.length} passed`);
      if (failed.length > 0) { console.error("Failed:", failed.map((x) => x.name).join(", ")); process.exit(1); }
    })(),
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
