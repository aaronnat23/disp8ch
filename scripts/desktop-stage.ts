import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const stageRoot = path.join(root, ".desktop-runtime");
const standaloneSource = path.join(root, ".next", "standalone");
const staticSource = path.join(root, ".next", "static");
const desktopBundleSource = path.join(root, ".desktop");

type CopyProfile = "standalone" | "general" | "package";

function ensureExists(target: string, label: string) {
  if (!fs.existsSync(target)) throw new Error(`${label} missing at ${target}`);
}

function shouldSkip(relativePath: string, profile: CopyProfile = "general"): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  if (!normalized) return false;
  if (profile === "package") {
    return base === ".env" || base.startsWith(".env.");
  }
  if (profile === "standalone") {
    const top = normalized.split("/")[0];
    const allowedTop = new Set([".next", "node_modules", "server.js", "package.json"]);
    if (!allowedTop.has(top)) return true;
  }
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (normalized === ".env.local") return true;
  if (
    normalized === "data" ||
    normalized.startsWith("data/") ||
    normalized === "logs" ||
    normalized.startsWith("logs/") ||
    normalized === "dist" ||
    normalized.startsWith("dist/") ||
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized === ".next/cache" ||
    normalized.startsWith(".next/cache/")
  ) {
    return true;
  }
  if (normalized === "docs/improvements" || normalized.startsWith("docs/improvements/")) return true;
  return false;
}

function copyFiltered(src: string, dest: string, base = src, profile: CopyProfile = "general") {
  const rel = path.relative(base, src).replace(/\\/g, "/");
  if (shouldSkip(rel, profile)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyFiltered(path.join(src, entry), path.join(dest, entry), base, profile);
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function removeIfExists(target: string) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function assertNotBundled(target: string) {
  const forbidden = [
    path.join(target, ".next", "standalone", ".env.local"),
    path.join(target, ".next", "standalone", "data"),
    path.join(target, ".next", "standalone", "docs", "improvements"),
    path.join(target, ".next", "standalone", "dist"),
  ];
  for (const item of forbidden) {
    if (fs.existsSync(item)) throw new Error(`desktop stage includes forbidden path: ${item}`);
  }
}

function copyStandalonePackage(packageName: string, packageRoot: string) {
  const packagePath = packageName.split("/");
  const dest = path.join(stageRoot, ".next", "standalone", "node_modules", ...packagePath);
  if (fs.existsSync(path.join(dest, "package.json"))) return;
  copyFiltered(packageRoot, dest, packageRoot, "package");
}

function findRootPnpmPackage(packageName: string): string | null {
  const encoded = packageName.startsWith("@") ? packageName.replace("/", "+") : packageName;
  const rootPnpmStore = path.join(root, "node_modules", ".pnpm");
  if (!fs.existsSync(rootPnpmStore)) return null;
  const match = fs.readdirSync(rootPnpmStore)
    .filter((entry) => entry === encoded || entry.startsWith(`${encoded}@`))
    .sort((a, b) => b.localeCompare(a))[0];
  if (!match) return null;
  const packageRoot = path.join(rootPnpmStore, match, "node_modules", ...packageName.split("/"));
  return fs.existsSync(path.join(packageRoot, "package.json")) ? packageRoot : null;
}

function ensureStandalonePackage(packageName: string) {
  const dest = path.join(stageRoot, ".next", "standalone", "node_modules", ...packageName.split("/"));
  if (fs.existsSync(path.join(dest, "package.json"))) return;
  const rootPackage = findRootPnpmPackage(packageName);
  if (!rootPackage) throw new Error(`Required standalone runtime package missing from root install: ${packageName}`);
  copyStandalonePackage(packageName, rootPackage);
}

function materializeStandalonePnpmPackages() {
  const pnpmStore = path.join(standaloneSource, "node_modules", ".pnpm");
  ensureExists(pnpmStore, "Next standalone pnpm store");
  for (const entry of fs.readdirSync(pnpmStore)) {
    const entryNodeModules = path.join(pnpmStore, entry, "node_modules");
    if (!fs.existsSync(entryNodeModules)) continue;
    for (const child of fs.readdirSync(entryNodeModules)) {
      const childPath = path.join(entryNodeModules, child);
      if (child.startsWith("@")) {
        for (const scopedChild of fs.readdirSync(childPath)) {
          const packageRoot = path.join(childPath, scopedChild);
          if (fs.existsSync(path.join(packageRoot, "package.json"))) {
            copyStandalonePackage(`${child}/${scopedChild}`, packageRoot);
          }
        }
      } else if (fs.existsSync(path.join(childPath, "package.json"))) {
        copyStandalonePackage(child, childPath);
      }
    }
  }
  for (const packageName of ["styled-jsx", "@swc/helpers"]) {
    ensureStandalonePackage(packageName);
  }
}

function main() {
  ensureExists(path.join(standaloneSource, "server.js"), "Next standalone server");
  ensureExists(staticSource, "Next static assets");
  ensureExists(path.join(desktopBundleSource, "main.cjs"), "desktop main bundle");
  ensureExists(path.join(desktopBundleSource, "preload.cjs"), "desktop preload bundle");
  ensureExists(path.join(desktopBundleSource, "ws-server.cjs"), "desktop websocket sidecar");

  removeIfExists(stageRoot);
  copyFiltered(standaloneSource, path.join(stageRoot, ".next", "standalone"), standaloneSource, "standalone");
  materializeStandalonePnpmPackages();
  copyFiltered(staticSource, path.join(stageRoot, ".next", "standalone", ".next", "static"));
  if (fs.existsSync(path.join(root, "public"))) {
    copyFiltered(path.join(root, "public"), path.join(stageRoot, ".next", "standalone", "public"));
  }
  copyFiltered(desktopBundleSource, path.join(stageRoot, ".desktop"));
  for (const dir of ["skills", "optional-skills"]) {
    if (fs.existsSync(path.join(root, dir))) copyFiltered(path.join(root, dir), path.join(stageRoot, dir));
  }
  fs.mkdirSync(path.join(stageRoot, "docs"), { recursive: true });
  if (fs.existsSync(path.join(root, "docs", "INSTALL.md"))) {
    fs.copyFileSync(path.join(root, "docs", "INSTALL.md"), path.join(stageRoot, "docs", "INSTALL.md"));
  }

  assertNotBundled(stageRoot);
  console.log(`desktop-stage: wrote sanitized runtime to ${stageRoot}`);
}

main();
