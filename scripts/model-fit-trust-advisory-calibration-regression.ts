#!/usr/bin/env tsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-model-fit-gaps-"));
process.env.DATABASE_PATH = path.join(tmp, "test.db");

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean): void {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

async function main(): Promise<void> {
  const [{ BUNDLED_CATALOG, loadCatalog }, calibration, advisory] = await Promise.all([
    import("@/lib/model-fit/catalog/load"),
    import("@/lib/model-fit/calibration"),
    import("@/lib/model-fit/advisory"),
  ]);
  const staticCatalog = await loadCatalog({
    force: true,
    fetchImpl: async () => { throw new Error("Static catalog must not fetch"); },
  });
  check("catalog.staticListUsedOffline", staticCatalog.source === "bundled" && staticCatalog.models.length === BUNDLED_CATALOG.models.length);

  const hardware = {
    platform: "win32",
    arch: "x64",
    cpuModel: "Test CPU",
    logicalCores: 16,
    physicalCores: 8,
    totalRamGB: 32,
    freeRamGB: 24,
    recommendedHostReserveGB: 6,
    gpus: [{ index: 0, name: "Test GPU", vendor: "nvidia" as const, totalVramGB: 16, freeVramGB: 14, driverVersion: "1" }],
    unifiedMemory: false,
    detectionNotes: [],
  };
  const artifact = {
    id: "local:test.gguf",
    displayName: "Test GGUF",
    path: "C:\\Models\\test.gguf",
    sizeBytes: 4_000_000_000,
    format: "gguf" as const,
    discoveredFrom: "C:\\Models",
    readable: true,
    modifiedAt: "2026-06-23T00:00:00.000Z",
    metadata: null,
  };
  const runtime = {
    available: true,
    binDir: "C:\\llama.cpp",
    serverPath: "C:\\llama.cpp\\llama-server.exe",
    cliPath: null,
    fitParamsPath: null,
    version: "100",
    capabilities: null,
  };
  const key8k = calibration.localCalibrationKey({ artifact, runtime, hardware, contextTokens: 8192, kvType: "f16" });
  const key32k = calibration.localCalibrationKey({ artifact, runtime, hardware, contextTokens: 32768, kvType: "q8_0" });
  check("calibration.contextChangesKey", key8k !== key32k);
  calibration.saveCalibration({
    key: key8k,
    candidateId: artifact.id,
    runtime: "llama.cpp",
    runtimeVersion: runtime.version,
    contextTokens: 8192,
    kvType: "f16",
    metrics: {
      loadMs: 1000,
      timeToFirstTokenMs: 250,
      promptTokensPerSecond: null,
      generationTokensPerSecond: 42.5,
      peakVramGB: 5,
      peakHostRamGB: 2,
      endpointCorrect: true,
      toolJsonCorrect: null,
      outputTokens: 40,
    },
    measuredAt: new Date().toISOString(),
  });
  check("calibration.roundTrip", calibration.getCalibration(key8k)?.metrics.generationTokensPerSecond === 42.5);

  const baseModel = {
    source: "ollama_installed" as const,
    modelId: "ollama:test:8b",
    displayName: "test:8b",
    family: "test",
    totalParamsB: 8,
    activeParamsB: 8,
    isMoe: false,
    quant: "Q4_K_M",
    contextMax: 32768,
    capabilities: ["chat"],
    path: null,
    ollamaTag: "test:8b",
    sizeBytes: 4_000_000_000,
    fitClass: "full_gpu" as const,
    confidence: "runtime_estimated" as const,
    fitSource: "ollama_show",
    gpuGB: 5,
    hostGB: 0,
    cpuMoe: false,
    gpuLayers: "auto" as const,
    commands: {},
    reasons: [],
    warnings: [],
    performance: { generationTokensPerSecond: null, timeToFirstTokenMs: null, measuredAt: null },
    score: 1,
    lane: "balanced" as const,
  };
  const recommendation = {
    hardware,
    runtimes: {
      llamaCpp: runtime,
      ollama: { available: true, version: "1", serviceUp: true, endpoint: "http://127.0.0.1:11434" },
      notes: [],
    },
    task: "general" as const,
    preference: "balanced" as const,
    contextTokens: 8192,
    installed: [baseModel],
    lanes: {
      quality: { ...baseModel, modelId: "ollama:quality:14b", displayName: "quality:14b", ollamaTag: "quality:14b", totalParamsB: 14 },
      balanced: baseModel,
      fast: { ...baseModel, modelId: "ollama:fast:3b", displayName: "fast:3b", ollamaTag: "fast:3b", totalParamsB: 3 },
    },
    allCandidates: [baseModel],
    constrained: [],
    catalog: { source: "bundled", state: "fresh" as const, generatedAt: new Date().toISOString() },
    notes: [],
  };
  const report = await advisory.createModelAdvisory({
    modelRowId: "model-row",
    provider: "ollama",
    modelId: "test:8b",
    latencyMs: 300,
    recommendation,
  });
  check("advisory.createdAfterCallableEvidence", report?.callable === true && (report.suggestions.length ?? 0) >= 1);
  check("advisory.persisted", advisory.listModelAdvisories("model-row")[0]?.id === report?.id);
  advisory.updateAdvisoryPreference({ advisoryId: report?.id, action: "dismiss" });
  check("advisory.dismissed", advisory.listModelAdvisories("model-row")[0]?.status === "dismissed");

  let confirmationRejected = false;
  const benchmark = await import("@/lib/model-fit/benchmark");
  try {
    benchmark.startBenchmark({ candidateId: "local:test", contextTokens: 8192, confirmed: false });
  } catch {
    confirmationRejected = true;
  }
  check("benchmark.requiresExplicitConfirmation", confirmationRejected);
  const queued = benchmark.startBenchmark({ candidateId: "missing:test", contextTokens: 8192, confirmed: true });
  const cancelled = benchmark.cancelBenchmark(queued.id);
  check("benchmark.cancelPersists", cancelled?.status === "cancelled" && benchmark.getBenchmarkJob(queued.id)?.status === "cancelled");

  const failed = results.filter((result) => !result.ok);
  console.log(`\nmodel-fit-trust-advisory-calibration-regression: ${results.length - failed.length}/${results.length} passed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* SQLite remains open until process exit on Windows. */ }
  if (failed.length > 0) process.exit(1);
}

void main();
