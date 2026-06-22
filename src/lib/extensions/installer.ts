import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { getSqlite, initializeDatabase } from "@/lib/db";
import {
  scanExtensionSource,
  type ExtensionSecurityScanReport,
  type ExtensionSecurityStatus,
} from "@/lib/extensions/security-scan";
import { logger } from "@/lib/utils/logger";

const log = logger.child("extensions:installer");

export type ExternalInstallSource = "git" | "local";

type ExtensionManifest = {
  id: string;
  name: string;
  description: string;
  skills?: string[];
  runtime?: string;
  configSchema?: Record<string, unknown>;
  uiHints?: Record<string, unknown>;
};

type LegacyExtensionInstallRow = {
  extension_id: string;
  install_source: ExternalInstallSource;
  source_ref: string;
  install_ref: string | null;
  source_revision: string | null;
  root_dir: string;
  manifest_path: string;
  runtime_path: string | null;
  scan_status: ExtensionSecurityStatus | null;
  scan_summary: string | null;
  scan_findings: string | null;
  scanned_at: string | null;
  installed_at: string;
  updated_at: string;
};

type StoredExtensionInstallMetadata = {
  id: string;
  installSource: ExternalInstallSource;
  sourceRef: string;
  installRef: string | null;
  sourceRevision: string | null;
  rootDir: string;
  manifestPath: string;
  runtimePath: string | null;
  scanStatus: ExtensionSecurityStatus;
  scanSummary: string | null;
  scanFindings: ExtensionSecurityScanReport["findings"];
  scannedAt: string | null;
  installedAt: string;
  updatedAt: string;
};

export type ExternalExtensionInstall = {
  id: string;
  installSource: ExternalInstallSource;
  sourceRef: string;
  installRef: string | null;
  sourceRevision: string | null;
  rootDir: string;
  manifestPath: string;
  runtimePath: string | null;
  scanStatus: ExtensionSecurityStatus;
  scanSummary: string | null;
  scanFindings: ExtensionSecurityScanReport["findings"];
  scannedAt: string | null;
  installedAt: string;
  updatedAt: string;
};

export type InstallExternalExtensionInput = {
  source: string;
  ref?: string | null;
};

const EXTERNAL_ROOT = path.resolve("data", "extensions-external");
const BUNDLED_ROOT = path.resolve("extensions");
const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".next", "dist", "coverage"]);
const MANIFEST_FILE = "disp8ch.plugin.json";
const INSTALL_METADATA_FILE = "disp8ch.install.json";

function ensureExternalRoot(): string {
  fs.mkdirSync(EXTERNAL_ROOT, { recursive: true });
  return EXTERNAL_ROOT;
}

function resolveInside(rootDir: string, relPath: string, label: string): string {
  const trimmed = String(relPath || "").trim();
  if (!trimmed) {
    throw new Error(`${label} path is required`);
  }
  if (path.isAbsolute(trimmed)) {
    throw new Error(`${label} path must be relative`);
  }
  const resolvedRoot = path.resolve(rootDir);
  const resolved = path.resolve(resolvedRoot, trimmed);
  const normalizedRoot = `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`${label} path escapes the extension root`);
  }
  return resolved;
}

function sanitizeInstallDirName(extensionId: string): string {
  const base = extensionId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base || `extension-${crypto.randomUUID().slice(0, 8)}`;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function readManifest(rootDir: string): { manifest: ExtensionManifest; manifestPath: string; runtimePath: string | null } {
  const manifestPath = path.join(rootDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing ${MANIFEST_FILE} in ${rootDir}`);
  }
  const manifest = readJsonFile<ExtensionManifest>(manifestPath);
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Extension manifest must be a JSON object");
  }
  const id = String(manifest.id || "").trim();
  const name = String(manifest.name || "").trim();
  const description = String(manifest.description || "").trim();
  if (!id) throw new Error("Extension manifest id is required");
  if (!name) throw new Error(`Extension ${id} is missing a name`);
  if (!description) throw new Error(`Extension ${id} is missing a description`);
  for (const rel of manifest.skills ?? []) {
    const skillDir = resolveInside(rootDir, String(rel || ""), "Skill");
    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
      throw new Error(`Skill path does not exist or is not a directory: ${rel}`);
    }
  }

  let runtimePath: string | null = null;
  if (manifest.runtime) {
    runtimePath = resolveInside(rootDir, manifest.runtime, "Runtime");
    if (!fs.existsSync(runtimePath) || !fs.statSync(runtimePath).isFile()) {
      throw new Error(`Runtime file does not exist: ${manifest.runtime}`);
    }
  } else {
    for (const candidate of ["runtime.mjs", "runtime.js", "runtime.cjs"]) {
      const filePath = path.join(rootDir, candidate);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        runtimePath = filePath;
        break;
      }
    }
  }

  return {
    manifest: {
      ...manifest,
      id,
      name,
      description,
      skills: Array.isArray(manifest.skills) ? manifest.skills.map((entry) => String(entry || "")) : [],
      runtime: manifest.runtime ? String(manifest.runtime) : undefined,
    },
    manifestPath,
    runtimePath,
  };
}

function removeTree(targetPath: string): void {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyTree(sourceDir: string, targetDir: string): void {
  const stat = fs.lstatSync(sourceDir);
  if (stat.isSymbolicLink()) {
    throw new Error(`Symlinks are not allowed in extension sources: ${sourceDir}`);
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(targetDir, { recursive: true });
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed in extension sources: ${sourcePath}`);
      }
      if (entry.isDirectory()) {
        copyTree(sourcePath, targetPath);
      } else if (entry.isFile()) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
    return;
  }
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.copyFileSync(sourceDir, targetDir);
  }
}

function isLikelyGitSource(source: string): boolean {
  const trimmed = source.trim();
  return /^https?:\/\//i.test(trimmed) || /^git@/i.test(trimmed) || trimmed.endsWith(".git");
}

function isGitHubShorthand(source: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.+)?$/.test(source.trim());
}

function normalizeGitSource(source: string): { url: string; ref: string | null } {
  const trimmed = source.trim();
  if (isLikelyGitSource(trimmed)) {
    const hashIndex = trimmed.lastIndexOf("#");
    if (hashIndex > trimmed.indexOf("://")) {
      return {
        url: trimmed.slice(0, hashIndex),
        ref: trimmed.slice(hashIndex + 1).trim() || null,
      };
    }
    return { url: trimmed, ref: null };
  }
  const match = trimmed.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#(.+))?$/);
  if (!match) {
    throw new Error(`Unsupported git source: ${source}`);
  }
  return {
    url: `https://github.com/${match[1]}.git`,
    ref: match[2] ? match[2].trim() : null,
  };
}

function stageFromLocal(source: string): {
  rootDir: string;
  installSource: ExternalInstallSource;
  sourceRef: string;
  installRef: string | null;
  sourceRevision: string | null;
} {
  const sourcePath = path.resolve(source.trim());
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
    throw new Error(`Local extension source not found: ${sourcePath}`);
  }
  const stat = fs.statSync(sourcePath);
  return {
    rootDir: sourcePath,
    installSource: "local",
    sourceRef: sourcePath,
    installRef: null,
    sourceRevision: stat.mtimeMs ? String(Math.round(stat.mtimeMs)) : null,
  };
}

function stageFromGit(source: string, explicitRef?: string | null): {
  rootDir: string;
  cleanup: () => void;
  installSource: ExternalInstallSource;
  sourceRef: string;
  installRef: string | null;
  sourceRevision: string | null;
} {
  const normalized = normalizeGitSource(source);
  const installRef = String(explicitRef || normalized.ref || "").trim() || null;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-extension-"));
  const args = ["clone", "--depth", "1"];
  if (installRef) args.push("--branch", installRef);
  args.push(normalized.url, tempRoot);
  execFileSync("git", args, { stdio: "ignore" });
  const revision = execFileSync("git", ["-C", tempRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return {
    rootDir: tempRoot,
    cleanup: () => removeTree(tempRoot),
    installSource: "git",
    sourceRef: normalized.url,
    installRef,
    sourceRevision: revision || null,
  };
}

function stageInstallSource(input: InstallExternalExtensionInput): {
  rootDir: string;
  cleanup?: () => void;
  installSource: ExternalInstallSource;
  sourceRef: string;
  installRef: string | null;
  sourceRevision: string | null;
} {
  const source = String(input.source || "").trim();
  if (!source) {
    throw new Error("Extension source is required");
  }
  if (fs.existsSync(path.resolve(source))) {
    return stageFromLocal(source);
  }
  if (isLikelyGitSource(source) || isGitHubShorthand(source)) {
    return stageFromGit(source, input.ref);
  }
  throw new Error(`Unsupported extension source: ${source}`);
}

function rowToInstall(row: LegacyExtensionInstallRow): ExternalExtensionInstall {
  let parsedFindings: ExtensionSecurityScanReport["findings"] = [];
  if (row.scan_findings) {
    try {
      parsedFindings = JSON.parse(row.scan_findings) as ExtensionSecurityScanReport["findings"];
    } catch {
      parsedFindings = [];
    }
  }
  return {
    id: row.extension_id,
    installSource: row.install_source,
    sourceRef: row.source_ref,
    installRef: row.install_ref,
    sourceRevision: row.source_revision,
    rootDir: row.root_dir,
    manifestPath: row.manifest_path,
    runtimePath: row.runtime_path,
    scanStatus: row.scan_status === "blocked" || row.scan_status === "warn" ? row.scan_status : "pass",
    scanSummary: row.scan_summary,
    scanFindings: parsedFindings,
    scannedAt: row.scanned_at,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

function bundledExtensionIdExists(extensionId: string): boolean {
  if (!fs.existsSync(BUNDLED_ROOT)) return false;
  for (const entry of fs.readdirSync(BUNDLED_ROOT)) {
    const manifestPath = path.join(BUNDLED_ROOT, entry, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = readJsonFile<ExtensionManifest>(manifestPath);
      if (String(manifest.id || "").trim() === extensionId) {
        return true;
      }
    } catch {
      // Ignore malformed bundled manifests.
    }
  }
  return false;
}

function getMetadataPath(rootDir: string): string {
  return path.join(rootDir, INSTALL_METADATA_FILE);
}

function writeInstallMetadata(install: ExternalExtensionInstall): void {
  const metadata: StoredExtensionInstallMetadata = { ...install };
  fs.writeFileSync(getMetadataPath(install.rootDir), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function readInstallMetadata(rootDir: string): StoredExtensionInstallMetadata | null {
  const metadataPath = getMetadataPath(rootDir);
  if (!fs.existsSync(metadataPath)) return null;
  try {
    return readJsonFile<StoredExtensionInstallMetadata>(metadataPath);
  } catch {
    return null;
  }
}

function readLegacyDbInstall(extensionId: string): ExternalExtensionInstall | null {
  try {
    initializeDatabase();
    const db = getSqlite();
    const row = db
      .prepare(`
        SELECT extension_id, install_source, source_ref, install_ref, source_revision,
               root_dir, manifest_path, runtime_path, scan_status, scan_summary, scan_findings, scanned_at, installed_at, updated_at
        FROM extension_installs
        WHERE extension_id = ?
        LIMIT 1
      `)
      .get(extensionId) as LegacyExtensionInstallRow | undefined;
    return row ? rowToInstall(row) : null;
  } catch {
    return null;
  }
}

function normalizeInstall(rootDir: string, metadata: Partial<StoredExtensionInstallMetadata>): ExternalExtensionInstall | null {
  try {
    const { manifest, manifestPath, runtimePath } = readManifest(rootDir);
    const now = new Date().toISOString();
    return {
      id: manifest.id,
      installSource: metadata.installSource === "git" ? "git" : "local",
      sourceRef: String(metadata.sourceRef || rootDir),
      installRef: metadata.installRef ? String(metadata.installRef) : null,
      sourceRevision: metadata.sourceRevision ? String(metadata.sourceRevision) : null,
      rootDir,
      manifestPath,
      runtimePath,
      scanStatus:
        metadata.scanStatus === "warn" || metadata.scanStatus === "blocked" || metadata.scanStatus === "pass"
          ? metadata.scanStatus
          : "pass",
      scanSummary: metadata.scanSummary ? String(metadata.scanSummary) : null,
      scanFindings: Array.isArray(metadata.scanFindings) ? metadata.scanFindings : [],
      scannedAt: metadata.scannedAt ? String(metadata.scannedAt) : null,
      installedAt: metadata.installedAt ? String(metadata.installedAt) : now,
      updatedAt: metadata.updatedAt ? String(metadata.updatedAt) : now,
    };
  } catch {
    return null;
  }
}

function inferInstallFromRoot(rootDir: string): ExternalExtensionInstall | null {
  let normalized = normalizeInstall(rootDir, readInstallMetadata(rootDir) ?? {});
  if (normalized) {
    writeInstallMetadata(normalized);
    return normalized;
  }

  try {
    const { manifest } = readManifest(rootDir);
    const legacy = readLegacyDbInstall(manifest.id);
    if (legacy) {
      normalized = normalizeInstall(rootDir, legacy);
      if (normalized) {
        writeInstallMetadata(normalized);
        return normalized;
      }
    }
    const stat = fs.statSync(rootDir);
    normalized = normalizeInstall(rootDir, {
      installSource: "local",
      sourceRef: rootDir,
      installRef: null,
      sourceRevision: stat.mtimeMs ? String(Math.round(stat.mtimeMs)) : null,
      scanStatus: "pass",
      scanSummary: "Imported from filesystem install.",
      scanFindings: [],
      scannedAt: null,
      installedAt: new Date(stat.birthtimeMs || stat.mtimeMs || Date.now()).toISOString(),
      updatedAt: new Date(stat.mtimeMs || Date.now()).toISOString(),
    });
    if (normalized) {
      writeInstallMetadata(normalized);
    }
    return normalized;
  } catch {
    return null;
  }
}

export function getExternalExtensionInstall(extensionId: string): ExternalExtensionInstall | null {
  return listExternalExtensionInstalls().find((install) => install.id === extensionId) ?? null;
}

export function listExternalExtensionInstalls(): ExternalExtensionInstall[] {
  if (!fs.existsSync(EXTERNAL_ROOT)) return [];
  const installs: ExternalExtensionInstall[] = [];
  for (const entry of fs.readdirSync(EXTERNAL_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rootDir = path.join(EXTERNAL_ROOT, entry.name);
    const install = inferInstallFromRoot(rootDir);
    if (install) installs.push(install);
  }
  return installs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function installExternalExtension(input: InstallExternalExtensionInput): ExternalExtensionInstall {
  ensureExternalRoot();
  const staged = stageInstallSource(input);
  try {
    const { manifest, runtimePath } = readManifest(staged.rootDir);
    const scan = scanExtensionSource(staged.rootDir);
    if (scan.status === "blocked") {
      throw new Error(`Extension security scan blocked install: ${scan.summary}`);
    }
    const extensionId = manifest.id;
    if (bundledExtensionIdExists(extensionId)) {
      throw new Error(`Extension id conflicts with a bundled extension: ${extensionId}`);
    }

    const existing = getExternalExtensionInstall(extensionId);
    const installDir = path.join(EXTERNAL_ROOT, sanitizeInstallDirName(extensionId));

    if (existing?.rootDir && path.resolve(existing.rootDir) !== path.resolve(installDir)) {
      removeTree(existing.rootDir);
    }

    removeTree(installDir);
    fs.mkdirSync(installDir, { recursive: true });
    copyTree(staged.rootDir, installDir);

    const finalManifest = readManifest(installDir);
    if (finalManifest.manifest.id !== extensionId) {
      throw new Error(`Installed extension id changed unexpectedly: ${finalManifest.manifest.id}`);
    }

    const now = new Date().toISOString();
    const installed: ExternalExtensionInstall = {
      id: extensionId,
      installSource: staged.installSource,
      sourceRef: staged.sourceRef,
      installRef: staged.installRef,
      sourceRevision: staged.sourceRevision,
      rootDir: installDir,
      manifestPath: path.join(installDir, MANIFEST_FILE),
      runtimePath: finalManifest.runtimePath ?? runtimePath,
      scanStatus: scan.status,
      scanSummary: scan.summary,
      scanFindings: scan.findings,
      scannedAt: scan.scannedAt,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    };
    writeInstallMetadata(installed);

    log.info("Installed external extension", {
      extensionId,
      installSource: staged.installSource,
      sourceRef: staged.sourceRef,
      runtimePath: finalManifest.runtimePath,
      sourceRevision: staged.sourceRevision,
      scanStatus: scan.status,
      scanWarnings: scan.warnings,
      scanErrors: scan.errors,
    });

    return installed;
  } finally {
    staged.cleanup?.();
  }
}

export function updateExternalExtension(extensionId: string): ExternalExtensionInstall {
  const existing = getExternalExtensionInstall(extensionId);
  if (!existing) {
    throw new Error(`External extension not found: ${extensionId}`);
  }
  return installExternalExtension({
    source: existing.sourceRef,
    ref: existing.installRef,
  });
}

export function uninstallExternalExtension(extensionId: string): boolean {
  const existing = getExternalExtensionInstall(extensionId);
  if (!existing) return false;
  removeTree(existing.rootDir);
  log.info("Uninstalled external extension", { extensionId });
  return true;
}
