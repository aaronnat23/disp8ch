import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type DesktopReleaseArtifact = {
  file: string;
  platform: "win32" | "darwin" | "linux" | "metadata" | "unknown";
  type: "nsis" | "dmg" | "zip" | "appimage" | "deb" | "rpm" | "yml" | "blockmap" | "other";
  arch: "x64" | "arm64" | "universal" | "unknown";
  size: number;
  sha256: string;
  url?: string;
};

export type DesktopReleaseManifest = {
  schemaVersion: 1;
  appId: string;
  productName: string;
  version: string;
  channel: string;
  generatedAt: string;
  artifacts: DesktopReleaseArtifact[];
};

const root = process.cwd();
const ignoredFileNames = new Set(["disp8ch-release-manifest.json", "SHA256SUMS", "builder-debug.yml", "builder-effective-config.yaml"]);
const artifactExtensions = new Set([".exe", ".dmg", ".zip", ".appimage", ".deb", ".rpm", ".yml", ".yaml", ".blockmap"]);

function parseArgs(argv: string[]) {
  const valueAfter = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    distDir: path.resolve(valueAfter("--dist") || path.join(root, "dist", "desktop")),
    channel: valueAfter("--channel") || process.env.RELEASE_CHANNEL || "beta",
    baseUrl: (valueAfter("--base-url") || process.env.RELEASE_BASE_URL || "").replace(/\/+$/, ""),
    allowEmpty: argv.includes("--allow-empty"),
  };
}

function readPackageJson(): { appId: string; productName: string; version: string } {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    version?: string;
  };
  return {
    appId: "app.disp8ch.desktop",
    productName: "disp8ch AI",
    version: pkg.version || "0.0.0",
  };
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function inferArch(fileName: string): DesktopReleaseArtifact["arch"] {
  const lower = fileName.toLowerCase();
  if (/(^|[-_.])arm64($|[-_.])/.test(lower)) return "arm64";
  if (/(^|[-_.])x64($|[-_.])/.test(lower) || /amd64/.test(lower)) return "x64";
  if (/universal/.test(lower)) return "universal";
  return "unknown";
}

function classifyArtifact(fileName: string): Pick<DesktopReleaseArtifact, "platform" | "type" | "arch"> {
  const lower = fileName.toLowerCase();
  const arch = inferArch(fileName);
  if (lower.endsWith(".exe")) return { platform: "win32", type: "nsis", arch };
  if (lower.endsWith(".dmg")) return { platform: "darwin", type: "dmg", arch };
  if (lower.endsWith(".appimage")) return { platform: "linux", type: "appimage", arch };
  if (lower.endsWith(".deb")) return { platform: "linux", type: "deb", arch };
  if (lower.endsWith(".rpm")) return { platform: "linux", type: "rpm", arch };
  if (lower.endsWith(".zip")) return { platform: lower.includes("mac") || lower.includes("darwin") ? "darwin" : "unknown", type: "zip", arch };
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return { platform: "metadata", type: "yml", arch: "unknown" };
  if (lower.endsWith(".blockmap")) return { platform: "metadata", type: "blockmap", arch: "unknown" };
  return { platform: "unknown", type: "other", arch };
}

function walkArtifacts(distDir: string, base = distDir): string[] {
  if (!fs.existsSync(distDir)) return [];
  const stat = fs.statSync(distDir);
  if (!stat.isDirectory()) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(distDir)) {
    const full = path.join(distDir, entry);
    const entryStat = fs.statSync(full);
    if (entryStat.isDirectory()) {
      if (entry.endsWith("-unpacked") || entry === "win-unpacked" || entry === "linux-unpacked" || entry === "mac") continue;
      files.push(...walkArtifacts(full, base));
      continue;
    }
    const rel = path.relative(base, full).replace(/\\/g, "/");
    if (ignoredFileNames.has(path.basename(rel))) continue;
    const lower = rel.toLowerCase();
    const ext = path.extname(lower);
    if (artifactExtensions.has(ext) || lower.endsWith(".appimage")) files.push(rel);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export function buildDesktopReleaseManifest(options: {
  distDir: string;
  channel: string;
  baseUrl?: string;
  generatedAt?: string;
}): DesktopReleaseManifest {
  const pkg = readPackageJson();
  const artifacts = walkArtifacts(options.distDir).map((rel): DesktopReleaseArtifact => {
    const full = path.join(options.distDir, rel);
    const classified = classifyArtifact(path.basename(rel));
    const artifact: DesktopReleaseArtifact = {
      file: rel,
      ...classified,
      size: fs.statSync(full).size,
      sha256: sha256File(full),
    };
    if (options.baseUrl) artifact.url = `${options.baseUrl}/${rel.split("/").map(encodeURIComponent).join("/")}`;
    return artifact;
  });
  return {
    schemaVersion: 1,
    appId: pkg.appId,
    productName: pkg.productName,
    version: pkg.version,
    channel: options.channel,
    generatedAt: options.generatedAt || new Date().toISOString(),
    artifacts,
  };
}

function writeManifest(distDir: string, manifest: DesktopReleaseManifest) {
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "disp8ch-release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(distDir, "SHA256SUMS"),
    manifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.file}`).join("\n") + (manifest.artifacts.length ? "\n" : ""),
    "utf8",
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = buildDesktopReleaseManifest({
    distDir: args.distDir,
    channel: args.channel,
    baseUrl: args.baseUrl || undefined,
  });
  if (!args.allowEmpty && manifest.artifacts.length === 0) {
    throw new Error(`No release artifacts found in ${args.distDir}`);
  }
  writeManifest(args.distDir, manifest);
  console.log(`desktop-release-manifest: wrote ${manifest.artifacts.length} artifact(s) to ${args.distDir}`);
}

if (process.argv[1] && path.parse(process.argv[1]).name === "desktop-release-manifest") {
  main();
}
