import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDesktopEnv } from "./security";

export type DesktopUpdateArtifact = {
  file: string;
  platform: string;
  type: string;
  arch: string;
  size: number;
  sha256: string;
  url?: string;
};

export type DesktopUpdateManifest = {
  schemaVersion: 1;
  appId: string;
  productName: string;
  version: string;
  channel: string;
  generatedAt: string;
  artifacts: DesktopUpdateArtifact[];
};

export type DesktopUpdateStatus = {
  ok: boolean;
  enabled: boolean;
  currentVersion: string;
  latestVersion?: string;
  channel: string;
  status: "disabled" | "current" | "available" | "unsupported" | "error";
  message: string;
  manifestUrl?: string;
  generatedAt?: string;
  artifact?: DesktopUpdateArtifact;
  downloadAllowed: boolean;
};

export type DesktopUpdateDownloadResult = {
  ok: boolean;
  status: DesktopUpdateStatus;
  filePath: string;
  sha256: string;
  bytes: number;
  message: string;
};

export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.replace(/^v/i, "").split(/[.-]/).map((part) => {
    const n = Number(part.replace(/\D.*/, ""));
    return Number.isFinite(n) ? n : 0;
  });
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length, 3); i += 1) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function defaultUpdatesDir(env: NodeJS.ProcessEnv = process.env): string {
  const appDir = resolveDesktopEnv("UPDATES_DIR", env);
  if (appDir) return appDir;
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "disp8ch", "updates");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "disp8ch", "updates");
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "disp8ch", "updates");
}

function safeArtifactFilename(file: string): string {
  const base = path.basename(file);
  if (!base || base === "." || base === ".." || base !== file.replaceAll("\\", "/").split("/").pop()) {
    throw new Error("Update artifact has an unsafe filename.");
  }
  return base;
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function readArtifactBytes(url: string, fetchImpl?: typeof fetch): Promise<Buffer> {
  if (url.startsWith("file://")) {
    return fs.readFileSync(path.normalize(fileURLToPath(new URL(url))));
  }
  const response = await (fetchImpl || fetch)(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} while downloading update artifact`);
  return Buffer.from(await response.arrayBuffer());
}

export function resolveDesktopUpdateConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    manifestUrl: resolveDesktopEnv("UPDATE_URL", env) || resolveDesktopEnv("UPDATE_MANIFEST_URL", env) || "",
    channel: resolveDesktopEnv("UPDATE_CHANNEL", env) || env.RELEASE_CHANNEL || "stable",
    platform: resolveDesktopEnv("UPDATE_PLATFORM", env) || process.platform,
    arch: resolveDesktopEnv("UPDATE_ARCH", env) || process.arch,
    allowDownloads: resolveDesktopEnv("ENABLE_DESKTOP_UPDATE_DOWNLOADS", env) === "1",
    updatesDir: defaultUpdatesDir(env),
  };
}

function artifactMatches(artifact: DesktopUpdateArtifact, platform: string, arch: string): boolean {
  if (artifact.platform !== platform) return false;
  if (artifact.type === "blockmap" || artifact.type === "yml") return false;
  return artifact.arch === arch || artifact.arch === "universal" || artifact.arch === "unknown";
}

export function evaluateDesktopUpdateManifest(options: {
  currentVersion: string;
  manifest: DesktopUpdateManifest;
  channel: string;
  platform: string;
  arch: string;
  manifestUrl?: string;
  allowDownloads?: boolean;
}): DesktopUpdateStatus {
  const { currentVersion, manifest, channel, platform, arch } = options;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) {
    return {
      ok: false,
      enabled: true,
      currentVersion,
      channel,
      status: "error",
      message: "Update manifest has an unsupported schema.",
      manifestUrl: options.manifestUrl,
      downloadAllowed: false,
    };
  }

  if (manifest.channel !== channel) {
    return {
      ok: true,
      enabled: true,
      currentVersion,
      latestVersion: manifest.version,
      channel,
      status: "current",
      message: `Update feed channel is ${manifest.channel}; this install is checking ${channel}.`,
      manifestUrl: options.manifestUrl,
      generatedAt: manifest.generatedAt,
      downloadAllowed: false,
    };
  }

  const artifact = manifest.artifacts.find((candidate) => artifactMatches(candidate, platform, arch));
  if (!artifact) {
    return {
      ok: true,
      enabled: true,
      currentVersion,
      latestVersion: manifest.version,
      channel,
      status: "unsupported",
      message: `No ${platform}/${arch} installer artifact is available in the update manifest.`,
      manifestUrl: options.manifestUrl,
      generatedAt: manifest.generatedAt,
      downloadAllowed: false,
    };
  }

  const relation = compareVersions(manifest.version, currentVersion);
  if (relation <= 0) {
    return {
      ok: true,
      enabled: true,
      currentVersion,
      latestVersion: manifest.version,
      channel,
      status: "current",
      message: "disp8ch is up to date.",
      manifestUrl: options.manifestUrl,
      generatedAt: manifest.generatedAt,
      artifact,
      downloadAllowed: false,
    };
  }

  return {
    ok: true,
    enabled: true,
    currentVersion,
    latestVersion: manifest.version,
    channel,
    status: "available",
    message: options.allowDownloads
      ? `disp8ch ${manifest.version} is available. The signed installer can be downloaded and SHA-256 verified, but install/restart remains manual.`
      : `disp8ch ${manifest.version} is available. Download the signed installer manually from the release page.`,
    manifestUrl: options.manifestUrl,
    generatedAt: manifest.generatedAt,
    artifact,
    downloadAllowed: Boolean(options.allowDownloads && artifact.url),
  };
}

export async function checkDesktopUpdates(options: {
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<DesktopUpdateStatus> {
  const config = resolveDesktopUpdateConfig(options.env);
  if (!config.manifestUrl) {
    return {
      ok: true,
      enabled: false,
      currentVersion: options.currentVersion,
      channel: config.channel,
      status: "disabled",
      message: "No desktop update feed is configured. Set DISP8CH_DESKTOP_UPDATE_URL to enable update checks.",
      downloadAllowed: false,
    };
  }

  try {
    const maybeLocalPath = config.manifestUrl.startsWith("file://")
      ? new URL(config.manifestUrl)
      : null;
    const manifest = maybeLocalPath
      ? JSON.parse(fs.readFileSync(path.normalize(fileURLToPath(maybeLocalPath)), "utf8")) as DesktopUpdateManifest
      : await (async () => {
        const response = await (options.fetchImpl || fetch)(config.manifestUrl, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status} from update feed`);
        return await response.json() as DesktopUpdateManifest;
      })();

    return evaluateDesktopUpdateManifest({
      currentVersion: options.currentVersion,
      manifest,
      channel: config.channel,
      platform: config.platform,
      arch: config.arch,
      manifestUrl: config.manifestUrl,
      allowDownloads: config.allowDownloads,
    });
  } catch (error) {
    return {
      ok: false,
      enabled: true,
      currentVersion: options.currentVersion,
      channel: config.channel,
      status: "error",
      message: `Update check failed: ${String(error instanceof Error ? error.message : error)}`,
      manifestUrl: config.manifestUrl,
      downloadAllowed: false,
    };
  }
}

export async function downloadDesktopUpdate(options: {
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  updatesDir?: string;
}): Promise<DesktopUpdateDownloadResult> {
  const status = await checkDesktopUpdates({
    currentVersion: options.currentVersion,
    env: options.env,
    fetchImpl: options.fetchImpl,
  });

  if (!status.downloadAllowed || status.status !== "available" || !status.artifact?.url) {
    throw new Error(status.message || "No downloadable desktop update is available.");
  }

  if (!/^[a-f0-9]{64}$/i.test(status.artifact.sha256 || "")) {
    throw new Error("Update artifact is missing a valid SHA-256 checksum.");
  }

  const filename = safeArtifactFilename(status.artifact.file);
  const targetDir = options.updatesDir || resolveDesktopUpdateConfig(options.env).updatesDir;
  fs.mkdirSync(targetDir, { recursive: true });

  const bytes = await readArtifactBytes(status.artifact.url, options.fetchImpl);
  const digest = sha256Hex(bytes);
  if (digest.toLowerCase() !== status.artifact.sha256.toLowerCase()) {
    throw new Error(`Update artifact checksum mismatch: expected ${status.artifact.sha256}, got ${digest}.`);
  }

  const filePath = path.join(targetDir, filename);
  fs.writeFileSync(filePath, bytes);
  return {
    ok: true,
    status,
    filePath,
    sha256: digest,
    bytes: bytes.byteLength,
    message: `Downloaded and verified ${filename}. Run the signed installer manually to update disp8ch.`,
  };
}
