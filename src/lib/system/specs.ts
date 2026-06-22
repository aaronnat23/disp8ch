import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function toGiB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10;
}

function readDiskStats(targetPath: string) {
  try {
    const stat = fs.statfsSync(targetPath);
    const totalBytes = stat.bsize * stat.blocks;
    const freeBytes = stat.bsize * stat.bavail;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      path: targetPath,
      totalBytes,
      usedBytes,
      freeBytes,
      freePercent: totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 1000) / 10 : 0,
    };
  } catch {
    return {
      path: targetPath,
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      freePercent: 0,
    };
  }
}

export function getMachineSpecs() {
  const cpus = os.cpus();
  const loadAverage = os.loadavg();
  const workspacePath = path.resolve(process.env.WORKSPACE_PATH || "./data/workspace");
  const disk = readDiskStats(workspacePath);
  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const usedMemBytes = Math.max(0, totalMemBytes - freeMemBytes);

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    type: os.type(),
    release: os.release(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptimeSeconds: Math.round(os.uptime()),
    cpu: {
      model: cpus[0]?.model || "Unknown",
      logicalCores: cpus.length,
      speedMhz: cpus[0]?.speed || 0,
      loadAverage,
    },
    memory: {
      totalBytes: totalMemBytes,
      usedBytes: usedMemBytes,
      freeBytes: freeMemBytes,
      totalGiB: toGiB(totalMemBytes),
      usedGiB: toGiB(usedMemBytes),
      freeGiB: toGiB(freeMemBytes),
      usedPercent: totalMemBytes > 0 ? Math.round((usedMemBytes / totalMemBytes) * 1000) / 10 : 0,
    },
    disk: {
      ...disk,
      totalGiB: toGiB(disk.totalBytes),
      usedGiB: toGiB(disk.usedBytes),
      freeGiB: toGiB(disk.freeBytes),
    },
  };
}
