import { spawnSync } from "node:child_process";
import type { LlamaCppCapabilities } from "../inventory/types";

/**
 * Adapter for `llama-fit-params`, llama.cpp's native fit estimator. It is a
 * bounded, read-only probe (no inference). With `-fitp on` it prints one line
 * per device: `<device> <model> <context> <compute>` in MiB.
 */

export type DeviceMemory = { device: string; modelMiB: number; contextMiB: number; computeMiB: number; totalMiB: number };

export type NativeFitResult = {
  ok: boolean;
  exitStatus: number | null;
  devices: DeviceMemory[];
  host: DeviceMemory | null;
  gpuTotalGB: number;
  hostTotalGB: number;
  raw: string;
  command: string[];
};

const LINE_RE = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/;

/** Parse the `-fitp on` stdout into per-device memory. Version-tolerant. */
export function parseNativeFitOutput(raw: string): { devices: DeviceMemory[]; host: DeviceMemory | null } {
  const devices: DeviceMemory[] = [];
  let host: DeviceMemory | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(LINE_RE);
    if (!m) continue;
    const entry: DeviceMemory = {
      device: m[1],
      modelMiB: Number(m[2]),
      contextMiB: Number(m[3]),
      computeMiB: Number(m[4]),
      totalMiB: Number(m[2]) + Number(m[3]) + Number(m[4]),
    };
    if (/^host$/i.test(entry.device)) host = entry;
    else devices.push(entry);
  }
  return { devices, host };
}

export function buildNativeFitArgs(params: {
  modelPath: string;
  contextTokens: number;
  parallelSlots: number;
  cpuMoe: boolean;
  keyType: string;
  valueType: string;
  capabilities: LlamaCppCapabilities | null;
}): string[] {
  const caps = params.capabilities;
  const args = ["-m", params.modelPath, "-c", String(params.contextTokens), "-np", String(params.parallelSlots)];
  args.push("-ngl", "auto");
  if (!caps || caps.fit) args.push("-fit", "on");
  if (!caps || caps.fitTarget) args.push("-fitt", "1024");
  args.push("-fitp", "on");
  if (caps?.cacheTypeK) args.push("-ctk", params.keyType);
  if (caps?.cacheTypeV) args.push("-ctv", params.valueType);
  if (params.cpuMoe && (!caps || caps.cpuMoe)) args.push("--cpu-moe");
  return args;
}

export type FitRunner = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: FitRunner = (cmd, args) => {
  const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 20000, windowsHide: true });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
};

export function runNativeFit(params: {
  fitParamsPath: string;
  modelPath: string;
  contextTokens: number;
  parallelSlots?: number;
  cpuMoe?: boolean;
  keyType?: string;
  valueType?: string;
  capabilities?: LlamaCppCapabilities | null;
  runner?: FitRunner;
}): NativeFitResult {
  const args = buildNativeFitArgs({
    modelPath: params.modelPath,
    contextTokens: params.contextTokens,
    parallelSlots: params.parallelSlots ?? 1,
    cpuMoe: params.cpuMoe ?? false,
    keyType: params.keyType ?? "f16",
    valueType: params.valueType ?? "f16",
    capabilities: params.capabilities ?? null,
  });
  const runner = params.runner ?? defaultRunner;
  const res = runner(params.fitParamsPath, args);
  const raw = `${res.stdout}\n${res.stderr}`;
  const { devices, host } = parseNativeFitOutput(raw);
  const gpuTotalMiB = devices.reduce((s, d) => s + d.totalMiB, 0);
  const hostTotalMiB = host ? host.totalMiB : 0;
  return {
    ok: res.status === 0 && (devices.length > 0 || host !== null),
    exitStatus: res.status,
    devices,
    host,
    gpuTotalGB: Math.round((gpuTotalMiB / 1024) * 10) / 10,
    hostTotalGB: Math.round((hostTotalMiB / 1024) * 10) / 10,
    raw,
    command: [params.fitParamsPath, ...args],
  };
}
