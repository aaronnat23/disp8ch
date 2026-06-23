import os from "node:os";
import { spawnSync } from "node:child_process";

/**
 * Best-effort local hardware detection for model-fit advice. Everything degrades
 * gracefully: if a probe is unavailable we record a note and continue. Detection
 * is read-only (it never installs anything).
 */

export type GpuInfo = { name: string; vramGB: number };

export type HardwareProfile = {
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalRamGB: number;
  freeRamGB: number;
  gpus: GpuInfo[];
  totalVramGB: number;
  unifiedMemory: boolean;
  detectionNotes: string[];
};

function run(cmd: string, args: string[]): string {
  try {
    const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 4000, windowsHide: true });
    if (res.status === 0 && typeof res.stdout === "string") return res.stdout;
  } catch {
    /* probe unavailable */
  }
  return "";
}

function gb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** Try nvidia-smi for accurate VRAM (works cross-platform when present). */
function detectNvidia(notes: string[]): GpuInfo[] {
  const out = run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  if (!out.trim()) return [];
  const gpus: GpuInfo[] = [];
  for (const line of out.trim().split(/\r?\n/)) {
    const [name, mb] = line.split(",").map((s) => s.trim());
    const vramGB = Math.round((Number(mb) / 1024) * 10) / 10;
    if (name) gpus.push({ name, vramGB: Number.isFinite(vramGB) ? vramGB : 0 });
  }
  if (gpus.length) notes.push("Detected NVIDIA GPU(s) via nvidia-smi.");
  return gpus;
}

function detectWindowsGpuName(notes: string[]): GpuInfo[] {
  const out = run("powershell", [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
  ]);
  const names = out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (names.length) notes.push("Detected GPU name via Win32_VideoController (VRAM unknown without nvidia-smi).");
  return names.map((name) => ({ name, vramGB: 0 }));
}

function detectMacGpu(notes: string[], ramGB: number, arch: string): { gpus: GpuInfo[]; unified: boolean } {
  if (arch === "arm64") {
    notes.push("Apple Silicon: unified memory — the GPU can use a large share of system RAM.");
    return { gpus: [{ name: "Apple Silicon GPU (unified memory)", vramGB: Math.round(ramGB * 0.7 * 10) / 10 }], unified: true };
  }
  const out = run("system_profiler", ["SPDisplaysDataType"]);
  const m = out.match(/Chipset Model:\s*(.+)/);
  if (m) {
    notes.push("Detected GPU via system_profiler.");
    return { gpus: [{ name: m[1].trim(), vramGB: 0 }], unified: false };
  }
  return { gpus: [], unified: false };
}

function detectLinuxGpuName(notes: string[]): GpuInfo[] {
  const out = run("sh", ["-c", "lspci | grep -iE 'vga|3d|display'"]);
  const names = out.trim().split(/\r?\n/).map((l) => l.replace(/^.*:\s*/, "").trim()).filter(Boolean);
  if (names.length) notes.push("Detected GPU name via lspci (VRAM unknown without nvidia-smi).");
  return names.map((name) => ({ name, vramGB: 0 }));
}

export function detectHardware(): HardwareProfile {
  const notes: string[] = [];
  const platform = process.platform;
  const arch = process.arch;
  const cpus = os.cpus?.() ?? [];
  const totalRamGB = gb(os.totalmem());
  const freeRamGB = gb(os.freemem());

  let gpus: GpuInfo[] = [];
  let unifiedMemory = false;

  // nvidia-smi gives the most reliable VRAM across platforms.
  gpus = detectNvidia(notes);

  if (gpus.length === 0) {
    if (platform === "darwin") {
      const mac = detectMacGpu(notes, totalRamGB, arch);
      gpus = mac.gpus;
      unifiedMemory = mac.unified;
    } else if (platform === "win32") {
      gpus = detectWindowsGpuName(notes);
    } else {
      gpus = detectLinuxGpuName(notes);
    }
  }

  if (gpus.length === 0) notes.push("No GPU detected; assuming CPU-only inference.");

  const totalVramGB = Math.round(gpus.reduce((sum, g) => sum + (g.vramGB || 0), 0) * 10) / 10;

  return {
    platform,
    arch,
    cpuModel: cpus[0]?.model?.trim() || "unknown",
    cpuCores: cpus.length,
    totalRamGB,
    freeRamGB,
    gpus,
    totalVramGB,
    unifiedMemory,
    detectionNotes: notes,
  };
}
