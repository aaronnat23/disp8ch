import crypto from "node:crypto";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import type { HardwareProfileV2, LocalModelArtifact, RuntimeInventory } from "./inventory/types";

export type CalibrationMetrics = {
  loadMs: number | null;
  timeToFirstTokenMs: number | null;
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
  peakVramGB: number | null;
  peakHostRamGB: number | null;
  endpointCorrect: boolean;
  toolJsonCorrect: boolean | null;
  outputTokens: number;
};

export type CalibrationRecord = {
  key: string;
  candidateId: string;
  runtime: string;
  runtimeVersion: string | null;
  contextTokens: number;
  kvType: string;
  metrics: CalibrationMetrics;
  measuredAt: string;
};

function ensureCalibrationTable(): void {
  initializeDatabase();
  getSqlite().exec(`
    CREATE TABLE IF NOT EXISTS model_fit_calibrations (
      calibration_key TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      runtime TEXT NOT NULL,
      runtime_version TEXT,
      context_tokens INTEGER NOT NULL,
      kv_type TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      measured_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_fit_calibrations_candidate
      ON model_fit_calibrations(candidate_id, measured_at DESC);
  `);
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function hardwareFingerprint(hardware: HardwareProfileV2): string {
  return digest({
    platform: hardware.platform,
    arch: hardware.arch,
    cpu: hardware.cpuModel,
    physicalCores: hardware.physicalCores,
    totalRamGB: hardware.totalRamGB,
    gpus: hardware.gpus.map((gpu) => ({
      name: gpu.name,
      vendor: gpu.vendor,
      totalVramGB: gpu.totalVramGB,
      driverVersion: gpu.driverVersion,
    })),
    unifiedMemory: hardware.unifiedMemory,
  });
}

export function localCalibrationKey(input: {
  artifact: LocalModelArtifact;
  runtime: RuntimeInventory["llamaCpp"];
  hardware: HardwareProfileV2;
  contextTokens: number;
  kvType: string;
}): string {
  return digest({
    kind: "local_gguf",
    file: {
      pathHash: digest(input.artifact.path),
      sizeBytes: input.artifact.sizeBytes,
      modifiedAt: input.artifact.modifiedAt,
      quantization: input.artifact.metadata?.quantization ?? null,
    },
    runtimeVersion: input.runtime.version,
    hardware: hardwareFingerprint(input.hardware),
    contextTokens: input.contextTokens,
    kvType: input.kvType,
  });
}

export function ollamaCalibrationKey(input: {
  tag: string;
  sizeBytes: number;
  runtime: RuntimeInventory["ollama"];
  hardware: HardwareProfileV2;
  contextTokens: number;
}): string {
  return digest({
    kind: "ollama",
    tag: input.tag,
    sizeBytes: input.sizeBytes,
    runtimeVersion: input.runtime.version,
    hardware: hardwareFingerprint(input.hardware),
    contextTokens: input.contextTokens,
  });
}

export function getCalibration(key: string): CalibrationRecord | null {
  ensureCalibrationTable();
  const row = getSqlite().prepare(`
    SELECT calibration_key, candidate_id, runtime, runtime_version, context_tokens, kv_type, metrics_json, measured_at
    FROM model_fit_calibrations WHERE calibration_key = ? LIMIT 1
  `).get(key) as {
    calibration_key: string;
    candidate_id: string;
    runtime: string;
    runtime_version: string | null;
    context_tokens: number;
    kv_type: string;
    metrics_json: string;
    measured_at: string;
  } | undefined;
  if (!row) return null;
  try {
    return {
      key: row.calibration_key,
      candidateId: row.candidate_id,
      runtime: row.runtime,
      runtimeVersion: row.runtime_version,
      contextTokens: row.context_tokens,
      kvType: row.kv_type,
      metrics: JSON.parse(row.metrics_json) as CalibrationMetrics,
      measuredAt: row.measured_at,
    };
  } catch {
    return null;
  }
}

export function saveCalibration(record: CalibrationRecord): void {
  ensureCalibrationTable();
  withSqliteWriteRecovery("model-fit:save-calibration", (db) => {
    db.prepare(`
      INSERT INTO model_fit_calibrations (
        calibration_key, candidate_id, runtime, runtime_version, context_tokens, kv_type, metrics_json, measured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(calibration_key) DO UPDATE SET
        candidate_id = excluded.candidate_id,
        runtime = excluded.runtime,
        runtime_version = excluded.runtime_version,
        context_tokens = excluded.context_tokens,
        kv_type = excluded.kv_type,
        metrics_json = excluded.metrics_json,
        measured_at = excluded.measured_at
    `).run(
      record.key,
      record.candidateId,
      record.runtime,
      record.runtimeVersion,
      record.contextTokens,
      record.kvType,
      JSON.stringify(record.metrics),
      record.measuredAt,
    );
  });
}
