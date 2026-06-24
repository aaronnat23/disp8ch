#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const RAW_FILES = [
  ".env.example",
  ".eslintrc.json",
  ".gitignore",
  ".npmrc",
  "AGENTS.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "drizzle.config.ts",
  "electron-builder.yml",
  "install.js",
  "install.ps1",
  "LICENSE",
  "next.config.mjs",
  "package-lock.json",
  "postcss.config.js",
  "pnpm-lock.yaml",
  "README.md",
  "SECURITY.md",
  "tailwind.config.ts",
  "tsconfig.json",
];

const RAW_DIRECTORIES = [
  ".github",
  "desktop",
  path.join("docs", "readme-assets"),
  "extensions",
  path.join("fixtures", "research-department"),
  "optional-skills",
  "public",
  "server",
  "skills",
  "src",
];

const PUBLIC_SCRIPT_FILES = [
  "cli-bin.js",
  "cli.ts",
  "desktop-build.ts",
  "desktop-dist.ts",
  "desktop-release-manifest.ts",
  "desktop-stage.ts",
  "desktop-standalone-build.ts",
  "dev-warmup.ts",
  "export-public-release.mjs",
  "install-paths.ts",
  "install-windows.ps1",
  "install.sh",
  "package-manager-manifests.ts",
  "runtime-health.ts",
  "runtime-manager.ts",
  "setup.ts",
];

const RELEASE_TEST_SCRIPT_FILES = [
  "agentic-no-shortcuts-regression.ts",
  "api-auth-boundary-regression.ts",
  "attention-center-regression.ts",
  "automation-guided-setup-regression.ts",
  "background-subagents-activity-regression.ts",
  "command-palette-shortcuts-regression.ts",
  "design-studio-import-ui-smoke.ts",
  "desktop-data-import-regression.ts",
  "desktop-dist-regression.ts",
  "desktop-hardening-regression.ts",
  "desktop-installer-smoke.ts",
  "desktop-launch-smoke.ts",
  "desktop-packaged-health-smoke.ts",
  "desktop-prefs-regression.ts",
  "desktop-release-manifest-regression.ts",
  "desktop-update-regression.ts",
  "deeplink-regression.ts",
  "install-doctor-regression.ts",
  "install-paths-regression.ts",
  "install-update-regression.ts",
  "installer-script-regression.ts",
  "image-edit-asset-regression.ts",
  "image-edit-provider-regression.ts",
  "local-ui-medium-regression.ts",
  "memory-atomic-operations-regression.ts",
  "memory-candidates-deepseek-live.ts",
  "memory-candidates-regression.ts",
  "mcp-call-approval-regression.ts",
  "mcp-guardian-regression.ts",
  "mcp-posture-regression.ts",
  "model-fit-regression.ts",
  "model-fit-trust-advisory-calibration-regression.ts",
  "model-fit-v2-regression.ts",
  "model-fit-ui-smoke.ts",
  "documents-notebook-ui-smoke.ts",
  "onboarding-provider-regression.ts",
  "package-manager-manifests-regression.ts",
  "portable-node-regression.ts",
  "portable-node.ts",
  "provider-async-delegation-regression.ts",
  "pty-policy-regression.ts",
  "release-gap-ui-smoke.ts",
  "release-notes-regression.ts",
  "release-regression.ts",
  "release-ui-simplification-regression.ts",
  "research-department-integration-regression.ts",
  "organization-capability-preset-regression.ts",
  "research-department-output-contract-regression.ts",
  "research-department-template-regression.ts",
  "research-department-ui-smoke.ts",
  "research-department-vault-regression.ts",
  "runtime-manager-regression.ts",
  "simple-calculator-and-format-regression.ts",
  "skills-browser-preview-regression.ts",
  "tool-markup-guard-regression.ts",
  "tool-invocation-routing-regression.ts",
  "continuation-fast-path-regression.ts",
  "webchat-completion-notification-smoke.ts",
  "workflow-node-connectivity-regression.ts",
  "workflow-effect-classification-regression.ts",
  "workflow-effect-enforcement-regression.ts",
  "workflow-memory-scope-regression.ts",
  "workflow-approval-memory-deepseek-live.ts",
  "workflow-new-templates-live-regression.ts",
  "workflow-template-catalog-regression.ts",
  "workflow-secret-redaction-regression.ts",
  "work-monitor-regression.ts",
];

function shouldSkipReleasePath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  if (!normalized) return false;
  return (
    base === ".DS_Store" ||
    base === "Thumbs.db" ||
    base === "__pycache__" ||
    base === "tsconfig.tsbuildinfo" ||
    base.endsWith(".tsbuildinfo") ||
    base.endsWith(".pyc") ||
    base.endsWith(".pyo")
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let destination = "";
  let label = "";
  let includeReleaseTests = false;
  let includeTestScripts = false;

  for (const arg of args) {
    if (arg.startsWith("--label=")) {
      label = arg.slice("--label=".length).trim();
      continue;
    }
    if (arg === "--include-test-scripts") {
      includeTestScripts = true;
      continue;
    }
    if (arg === "--include-release-tests") {
      includeReleaseTests = true;
      continue;
    }
    if (!destination) {
      destination = arg;
    }
  }

  if (!destination) {
    throw new Error("Usage: node scripts/export-public-release.mjs <destination> [--label=final1] [--include-release-tests] [--include-test-scripts]");
  }

  return {
    destination: path.resolve(destination),
    label: label || "v1.1.1",
    includeReleaseTests,
    includeTestScripts,
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Release export source file is missing: ${path.relative(projectRoot, sourcePath)}`);
  }
  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
}

function copyDirectory(sourceDir, destinationDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Release export source directory is missing: ${path.relative(projectRoot, sourceDir)}`);
  }
  ensureDir(destinationDir);
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    const relativePath = path.relative(projectRoot, sourcePath);
    if (shouldSkipReleasePath(relativePath)) continue;
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      copyFile(sourcePath, destinationPath);
    }
  }
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, contents) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents, "utf8");
}

function transformPackageJson(includeReleaseTests, includeTestScripts) {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const parsed = JSON.parse(readText(packageJsonPath));

  const scripts = {
    dev: parsed.scripts?.dev,
    "dev:warm": parsed.scripts?.["dev:warm"],
    build: parsed.scripts?.build,
    start: parsed.scripts?.start,
    setup: parsed.scripts?.setup,
    "playwright:install": parsed.scripts?.["playwright:install"],
    "playwright:install:linux": parsed.scripts?.["playwright:install:linux"],
    "runtime:health": parsed.scripts?.["runtime:health"],
    "runtime:start": parsed.scripts?.["runtime:start"],
    "desktop:build": parsed.scripts?.["desktop:build"],
    "desktop:standalone-build": parsed.scripts?.["desktop:standalone-build"],
    "desktop:dev": parsed.scripts?.["desktop:dev"],
    "desktop:pack": parsed.scripts?.["desktop:pack"],
    "desktop:dist": parsed.scripts?.["desktop:dist"],
    "desktop:stage": parsed.scripts?.["desktop:stage"],
    "desktop:manifest": parsed.scripts?.["desktop:manifest"],
    "desktop:package-manifests": parsed.scripts?.["desktop:package-manifests"],
    "export:public": parsed.scripts?.["export:public"],
    dpc: parsed.scripts?.dpc,
    "link-cli": parsed.scripts?.["link-cli"],
    "db:migrate": parsed.scripts?.["db:migrate"],
    "db:studio": parsed.scripts?.["db:studio"],
    lint: parsed.scripts?.lint,
  };

  if (includeReleaseTests || includeTestScripts) {
    Object.assign(scripts, {
      "install:test": parsed.scripts?.["install:test"],
      "test:release": parsed.scripts?.["test:release"],
      "desktop:smoke": parsed.scripts?.["desktop:smoke"],
      "desktop:packaged-smoke": parsed.scripts?.["desktop:packaged-smoke"],
      "desktop:installer-smoke": parsed.scripts?.["desktop:installer-smoke"],
      "test:ui-medium": parsed.scripts?.["test:ui-medium"],
    });
  }
  if (includeTestScripts) {
    Object.assign(scripts, {
      test: parsed.scripts?.test,
    });
  }

  parsed.scripts = Object.fromEntries(Object.entries(scripts).filter(([, value]) => Boolean(value)));

  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function createScriptsDirectory(destinationRoot, includeReleaseTests, includeTestScripts) {
  const destinationScriptsDir = path.join(destinationRoot, "scripts");
  if (includeTestScripts) {
    copyDirectory(path.join(projectRoot, "scripts"), destinationScriptsDir);
    return;
  }

  ensureDir(destinationScriptsDir);
  const scripts = new Set(PUBLIC_SCRIPT_FILES);
  if (includeReleaseTests) {
    for (const scriptName of RELEASE_TEST_SCRIPT_FILES) {
      scripts.add(scriptName);
    }
  }
  for (const scriptName of Array.from(scripts).sort()) {
    copyFile(path.join(projectRoot, "scripts", scriptName), path.join(destinationScriptsDir, scriptName));
  }
}

function createCleanDataNotice(destinationRoot) {
  const dataDir = path.join(destinationRoot, "data");
  ensureDir(dataDir);
  writeText(
    path.join(dataDir, ".gitkeep"),
    "",
  );
  writeText(
    path.join(dataDir, "README.md"),
    [
      "# Runtime Data",
      "",
      "This directory is intentionally empty in the public release.",
      "",
      "disp8ch creates local runtime state here on first run, including:",
      "- SQLite databases",
      "- workspace files",
      "- memories",
      "- documents",
      "- logs",
      "- imports and backups",
      "",
      "This file is only here so the folder exists after cloning.",
      "",
    ].join("\n"),
  );
}

function createReleaseMetadata(destinationRoot, label, includeReleaseTests) {
  if (!label) return;
  writeText(
    path.join(destinationRoot, "PUBLIC_RELEASE.md"),
    [
      `# Public Release ${label}`,
      "",
      "Generated from the working development repo with the public export script.",
      "",
      "Included:",
      "- runtime source",
      "- bundled skills and extensions",
      "- install scripts",
      "- public README and assets",
      "",
      "Removed:",
      "- local databases and memory",
      "- auth state and secrets",
      "- uploaded documents and chat history",
      includeReleaseTests
        ? "- local runtime state, credentials, and generated data (release validation scripts retained)"
        : "- regression suites and private testing artifacts",
      "",
    ].join("\n"),
  );
}

function walkFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files;
}

function validatePublicRelease(destinationRoot) {
  const legacyProviderName = ["co", "dex"].join("");
  const prohibitedNames = [
    ["her", "mes"].join(""),
    ["nous", "research"].join(""),
    ["cl", "aw"].join(""),
  ];
  const privateBackendMarkers = [
    ["chatgpt.com/backend-api", legacyProviderName].join("/"),
  ];
  const secretShapes = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\b\d{8,12}:[A-Za-z0-9_-]{25,}\b/,
    /\bAIza[0-9A-Za-z_-]{25,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{15,}\b/,
    /\bya29\.[A-Za-z0-9_-]{20,}\b/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/,
  ];
  const forbiddenPathPatterns = [
    /(^|\/)node_modules(\/|$)/,
    /(^|\/)\.next(\/|$)/,
    /(^|\/)\.git(\/|$)/,
    /(^|\/)data\/workspace(\/|$)/,
    /(^|\/)data\/db-backups(\/|$)/,
    /(^|\/)\.env\.local$/,
    /(^|\/)auth\.json$/,
    /\.(?:db|sqlite|sqlite3|log|pem|p12|pfx|tsbuildinfo)$/,
    /\.db-(?:wal|shm)$/,
  ];

  const errors = [];
  for (const filePath of walkFiles(destinationRoot)) {
    const relativePath = path.relative(destinationRoot, filePath).replace(/\\/g, "/");
    if (forbiddenPathPatterns.some((pattern) => pattern.test(relativePath))) {
      errors.push(`forbidden release path: ${relativePath}`);
      continue;
    }
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    const lower = text.toLowerCase();
    for (const prohibited of prohibitedNames) {
      if (lower.includes(prohibited)) errors.push(`prohibited name '${prohibited}' in ${relativePath}`);
    }
    for (const marker of privateBackendMarkers) {
      if (lower.includes(marker.toLowerCase())) errors.push(`private backend marker in ${relativePath}`);
    }
    if (secretShapes.some((pattern) => pattern.test(text))) {
      errors.push(`credential-shaped value in ${relativePath}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Public release validation failed:\n${errors.slice(0, 50).join("\n")}`);
  }
}

function exportRelease(options) {
  if (fs.existsSync(options.destination)) {
    fs.rmSync(options.destination, { recursive: true, force: true });
  }
  ensureDir(options.destination);

  for (const relativeFile of RAW_FILES) {
    copyFile(path.join(projectRoot, relativeFile), path.join(options.destination, relativeFile));
  }

  for (const relativeDir of RAW_DIRECTORIES) {
    copyDirectory(path.join(projectRoot, relativeDir), path.join(options.destination, relativeDir));
  }

  createScriptsDirectory(options.destination, options.includeReleaseTests, options.includeTestScripts);
  writeText(path.join(options.destination, "package.json"), transformPackageJson(options.includeReleaseTests, options.includeTestScripts));
  createCleanDataNotice(options.destination);
  createReleaseMetadata(options.destination, options.label, options.includeReleaseTests);
  validatePublicRelease(options.destination);
}

function main() {
  const options = parseArgs(process.argv);
  exportRelease(options);
  process.stdout.write(`Public release exported to ${options.destination}\n`);
}

main();
