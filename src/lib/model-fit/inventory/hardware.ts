import os from "node:os";
import { spawnSync } from "node:child_process";
import type { GpuVendor, HardwareProfileV2 } from "./types";

/**
 * Hardware inventory V2: adds physical cores, free VRAM, driver versions, and a
 * recommended host RAM reserve. nvidia-smi gives accurate total/free VRAM; other
 * vendors fall back to name-only detection. Read-only.
 */

function run(cmd: string, args: string[]): string {
  try {
    const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 4000, windowsHide: true });
    return res.status === 0 && typeof res.stdout === "string" ? res.stdout : "";
  } catch {
    return "";
  }
}

const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

function detectNvidia(notes: string[]): HardwareProfileV2["gpus"] {
  const out = run("nvidia-smi", ["--query-gpu=index,name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"]);
  if (!out.trim()) return [];
  const gpus: HardwareProfileV2["gpus"] = [];
  for (const line of out.trim().split(/\r?\n/)) {
    const [index, name, total, free, driver] = line.split(",").map((s) => s.trim());
    gpus.push({
      index: Number(index) || gpus.length,
      name,
      vendor: "nvidia",
      totalVramGB: Math.round((Number(total) / 1024) * 10) / 10,
      freeVramGB: Number.isFinite(Number(free)) ? Math.round((Number(free) / 1024) * 10) / 10 : null,
      driverVersion: driver || null,
    });
  }
  if (gpus.length) notes.push("GPU(s) detected via nvidia-smi (total + free VRAM).");
  return gpus;
}

function physicalCores(): number | null {
  if (process.platform === "win32") {
    const out = run("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum"]);
    const n = Number(out.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

export function detectHardwareV2(): HardwareProfileV2 {
  const notes: string[] = [];
  const cpus = os.cpus?.() ?? [];
  const totalRamGB = gb(os.totalmem());
  const freeRamGB = gb(os.freemem());

  let gpus = detectNvidia(notes);
  let unifiedMemory = false;
  if (gpus.length === 0) {
    if (process.platform === "darwin" && process.arch === "arm64") {
      unifiedMemory = true;
      gpus = [{ index: 0, name: "Apple Silicon GPU (unified memory)", vendor: "apple", totalVramGB: Math.round(totalRamGB * 0.7 * 10) / 10, freeVramGB: null, driverVersion: null }];
      notes.push("Apple Silicon unified memory.");
    } else {
      const name = process.platform === "win32"
        ? run("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"]).trim().split(/\r?\n/)[0]
        : run("sh", ["-c", "lspci | grep -iE 'vga|3d' | head -1"]).replace(/^.*:\s*/, "").trim();
      if (name) {
        const vendor: GpuVendor = /nvidia/i.test(name) ? "nvidia" : /amd|radeon/i.test(name) ? "amd" : /intel/i.test(name) ? "intel" : "unknown";
        gpus = [{ index: 0, name, vendor, totalVramGB: 0, freeVramGB: null, driverVersion: null }];
        notes.push("GPU name detected; VRAM unknown without nvidia-smi.");
      } else {
        notes.push("No GPU detected; CPU-only inference assumed.");
      }
    }
  }

  const recommendedHostReserveGB = process.platform === "win32" ? 6 : 4;

  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model?.trim() || "unknown",
    logicalCores: cpus.length,
    physicalCores: physicalCores(),
    totalRamGB,
    freeRamGB,
    recommendedHostReserveGB,
    gpus,
    unifiedMemory,
    detectionNotes: notes,
  };
}
