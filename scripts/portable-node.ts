import os from "node:os";

export const REQUIRED_NODE_MAJOR = 22;
export const REQUIRED_NODE_MIN_VERSION = "22.13.0";

export type PortableNodeTarget = {
  platform: NodeJS.Platform;
  arch: string;
  archiveExt: ".zip" | ".tar.xz";
  nodePlatform: "win" | "darwin" | "linux";
  nodeArch: "x64" | "arm64";
};

export function currentNodeSatisfies(version = process.version): boolean {
  const clean = version.replace(/^v/, "");
  const actual = clean.split(".").map((part) => Number(part));
  const required = REQUIRED_NODE_MIN_VERSION.split(".").map((part) => Number(part));
  for (let index = 0; index < required.length; index += 1) {
    const actualPart = Number.isFinite(actual[index]) ? actual[index] : 0;
    const requiredPart = required[index] || 0;
    if (actualPart > requiredPart) return true;
    if (actualPart < requiredPart) return false;
  }
  return true;
}

export function resolvePortableNodeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = os.arch(),
): PortableNodeTarget {
  const nodeArch = arch === "arm64" ? "arm64" : "x64";
  if (platform === "win32") {
    return { platform, arch, archiveExt: ".zip", nodePlatform: "win", nodeArch };
  }
  if (platform === "darwin") {
    return { platform, arch, archiveExt: ".tar.xz", nodePlatform: "darwin", nodeArch };
  }
  return { platform, arch, archiveExt: ".tar.xz", nodePlatform: "linux", nodeArch };
}

export function latestNodeIndexUrl(): string {
  return `https://nodejs.org/dist/latest-v${REQUIRED_NODE_MAJOR}.x/`;
}

export function buildNodeArchivePattern(target: PortableNodeTarget): RegExp {
  const ext = target.archiveExt.replace(".", "\\.");
  return new RegExp(`node-v${REQUIRED_NODE_MAJOR}\\.\\d+\\.\\d+-${target.nodePlatform}-${target.nodeArch}${ext}`, "i");
}
