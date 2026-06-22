#!/usr/bin/env node
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const cliPath = path.resolve(__dirname, "cli.ts");
const projectRoot = path.resolve(__dirname, "..");
const cacheDir = path.join(projectRoot, ".dpc-cache");
const bundlePath = path.join(cacheDir, "cli-bundle.mjs");
const fingerprintPath = path.join(cacheDir, "cli-bundle.sha1");
const buildLockPath = path.join(cacheDir, "cli-bundle.lock");
const FINGERPRINT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]);
const FINGERPRINT_SKIP_DIRS = new Set([".git", ".next", "node_modules", "dist", "coverage", ".dpc-cache"]);

function resolveEsbuildCli() {
  const candidates = [];
  const pnpmRoot = path.join(projectRoot, "node_modules", ".pnpm");

  try {
    candidates.push(require.resolve("esbuild", { paths: [projectRoot] }));
  } catch {}

  candidates.push(path.join(projectRoot, "node_modules", "esbuild", "lib", "main.js"));

  if (fs.existsSync(pnpmRoot)) {
    const pnpmCandidates = fs
      .readdirSync(pnpmRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("esbuild@"))
      .map((entry) => path.join(pnpmRoot, entry.name, "node_modules", "esbuild", "lib", "main.js"))
      .sort()
      .reverse();
    candidates.push(...pnpmCandidates);
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not locate esbuild. Run pnpm install before invoking dpc.");
}

function collectFingerprintFiles(rootPath, out = []) {
  if (!fs.existsSync(rootPath)) return out;
  const stat = fs.statSync(rootPath);
  if (stat.isFile()) {
    if (FINGERPRINT_EXTENSIONS.has(path.extname(rootPath))) out.push(rootPath);
    return out;
  }
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (FINGERPRINT_SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      collectFingerprintFiles(fullPath, out);
    } else if (entry.isFile() && FINGERPRINT_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(fullPath);
    }
  }
  return out;
}

function getFingerprint() {
  const packageJson = path.join(projectRoot, "package.json");
  const tsconfigJson = path.join(projectRoot, "tsconfig.json");
  const parts = collectFingerprintFiles(path.join(projectRoot, "src"))
    .concat([cliPath, packageJson, tsconfigJson])
    .filter((filePath, index, files) => fs.existsSync(filePath) && files.indexOf(filePath) === index)
    .sort()
    .map((filePath) => `${filePath}:${fs.statSync(filePath).mtimeMs}`);
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readCurrentFingerprint() {
  return fs.existsSync(fingerprintPath) ? fs.readFileSync(fingerprintPath, "utf8").trim() : "";
}

function waitForExistingBuild(nextFingerprint) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(buildLockPath)) {
      const currentFingerprint = readCurrentFingerprint();
      if (fs.existsSync(bundlePath) && currentFingerprint === nextFingerprint) {
        return bundlePath;
      }
    }
    sleep(100);
  }
  throw new Error("Timed out waiting for the dpc CLI bundle lock to clear.");
}

function ensureBundledCli() {
  fs.mkdirSync(cacheDir, { recursive: true });
  const nextFingerprint = getFingerprint();
  const currentFingerprint = readCurrentFingerprint();
  if (fs.existsSync(bundlePath) && currentFingerprint === nextFingerprint) {
    return bundlePath;
  }

  try {
    fs.mkdirSync(buildLockPath);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      return waitForExistingBuild(nextFingerprint);
    }
    throw error;
  }

  try {
    const latestFingerprint = readCurrentFingerprint();
    if (fs.existsSync(bundlePath) && latestFingerprint === nextFingerprint) {
      return bundlePath;
    }

    const tempBundlePath = path.join(cacheDir, `cli-bundle.${process.pid}.${Date.now()}.mjs`);
    const esbuild = require(resolveEsbuildCli());
    esbuild.buildSync({
      entryPoints: [cliPath],
      bundle: true,
      platform: "node",
      format: "esm",
      target: ["node18"],
      outfile: tempBundlePath,
      tsconfig: path.join(projectRoot, "tsconfig.json"),
      packages: "external",
      alias: {
        "next/server": "next/server.js",
      },
      logLevel: "error",
    });

    const bundledSource = fs.readFileSync(tempBundlePath, "utf8").replaceAll('"next/server"', '"next/server.js"');
    fs.writeFileSync(tempBundlePath, bundledSource, "utf8");
    fs.renameSync(tempBundlePath, bundlePath);
    fs.writeFileSync(fingerprintPath, nextFingerprint, "utf8");
    return bundlePath;
  } finally {
    try {
      fs.rmSync(buildLockPath, { recursive: true, force: true });
    } catch {}
  }
}

try {
  const compiledCliPath = ensureBundledCli();
  const capture = process.env.DPC_CAPTURE === "1";
  const output = execFileSync(process.execPath, [compiledCliPath, ...process.argv.slice(2)], {
    stdio: capture ? "pipe" : "inherit",
    encoding: capture ? "utf8" : undefined,
    cwd: projectRoot,
  });
  if (capture && output) {
    process.stdout.write(output);
  }
} catch (e) {
  if (process.env.DPC_CAPTURE === "1") {
    if (e && e.stdout) process.stdout.write(String(e.stdout));
    if (e && e.stderr) process.stderr.write(String(e.stderr));
  }
  process.exit(e && e.status ? e.status : 1);
}
