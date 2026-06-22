import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import {
  scanExtensionSource,
  type ExtensionSecurityScanReport,
  type ExtensionSecurityStatus,
} from "@/lib/extensions/security-scan";
import { logger } from "@/lib/utils/logger";

const log = logger.child("skills:installer");

export type ExternalSkillInstallSource = "git" | "local";

type SkillPackManifest = {
  id?: string;
  name?: string;
  description?: string;
  skills?: string[];
};

type StoredSkillPackMetadata = {
  id: string;
  name: string;
  description: string;
  installSource: ExternalSkillInstallSource;
  sourceRef: string;
  installRef: string | null;
  sourceRevision: string | null;
  rootDir: string;
  manifestPath: string | null;
  skillDirs: string[];
  skillCount: number;
  scanStatus: ExtensionSecurityStatus;
  scanSummary: string | null;
  scanFindings: ExtensionSecurityScanReport["findings"];
  scannedAt: string | null;
  installedAt: string;
  updatedAt: string;
};

export type ExternalSkillPackInstall = {
  id: string;
  name: string;
  description: string;
  installSource: ExternalSkillInstallSource;
  sourceRef: string;
  installRef: string | null;
  sourceRevision: string | null;
  rootDir: string;
  manifestPath: string | null;
  skillDirs: string[];
  skillCount: number;
  scanStatus: ExtensionSecurityStatus;
  scanSummary: string | null;
  scanFindings: ExtensionSecurityScanReport["findings"];
  scannedAt: string | null;
  installedAt: string;
  updatedAt: string;
};

export type InstallExternalSkillPackInput = {
  source: string;
  ref?: string | null;
};

const EXTERNAL_ROOT = path.resolve("data", "skills-external");
const MANIFEST_FILE = "disp8ch.skill-pack.json";
const INSTALL_METADATA_FILE = "disp8ch.install.json";
const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".next", "dist", "coverage"]);

function ensureExternalRoot(): string {
  fs.mkdirSync(EXTERNAL_ROOT, { recursive: true });
  return EXTERNAL_ROOT;
}

function sanitizeInstallDirName(skillPackId: string): string {
  const base = skillPackId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base || `skill-pack-${crypto.randomUUID().slice(0, 8)}`;
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
    throw new Error(`${label} path escapes the skill-pack root`);
  }
  return resolved;
}

function removeTree(targetPath: string): void {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyTree(sourceDir: string, targetDir: string): void {
  const stat = fs.lstatSync(sourceDir);
  if (stat.isSymbolicLink()) {
    throw new Error(`Symlinks are not allowed in skill-pack sources: ${sourceDir}`);
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(targetDir, { recursive: true });
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed in skill-pack sources: ${sourcePath}`);
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
  installSource: ExternalSkillInstallSource;
  sourceRef: string;
  installRef: string | null;
  sourceRevision: string | null;
} {
  const sourcePath = path.resolve(source.trim());
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
    throw new Error(`Local skill-pack source not found: ${sourcePath}`);
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
  installSource: ExternalSkillInstallSource;
  sourceRef: string;
  installRef: string | null;
  sourceRevision: string | null;
} {
  const normalized = normalizeGitSource(source);
  const installRef = String(explicitRef || normalized.ref || "").trim() || null;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-skill-pack-"));
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

function stageInstallSource(input: InstallExternalSkillPackInput): {
  rootDir: string;
  cleanup?: () => void;
  installSource: ExternalSkillInstallSource;
  sourceRef: string;
  installRef: string | null;
  sourceRevision: string | null;
} {
  const source = String(input.source || "").trim();
  if (!source) {
    throw new Error("Skill-pack source is required");
  }
  if (fs.existsSync(path.resolve(source))) {
    return stageFromLocal(source);
  }
  if (isLikelyGitSource(source) || isGitHubShorthand(source)) {
    return stageFromGit(source, input.ref);
  }
  throw new Error(`Unsupported skill-pack source: ${source}`);
}

function sanitizePackId(raw: string, fallbackName: string): string {
  const candidate = String(raw || "").trim() || fallbackName;
  const normalized = candidate
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `skill-pack-${crypto.randomUUID().slice(0, 8)}`;
}

function humanizeName(raw: string): string {
  return raw
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function readSkillHeading(skillDir: string): { label: string; description: string } {
  const skillPath = path.join(skillDir, "SKILL.md");
  const content = fs.readFileSync(skillPath, "utf8").trim();
  const lines = content.split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim();
  const description = lines
    .filter((line) => line.trim() && !/^#/.test(line.trim()))
    .slice(0, 2)
    .join(" ")
    .trim();
  return {
    label: heading || humanizeName(path.basename(skillDir)),
    description: description || "Reusable skill pack.",
  };
}

function inferSkillDirs(rootDir: string): string[] {
  const rootSkillPath = path.join(rootDir, "SKILL.md");
  if (fs.existsSync(rootSkillPath) && fs.statSync(rootSkillPath).isFile()) {
    return [rootDir];
  }

  const skillDirs: string[] = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(rootDir, entry.name);
    const skillPath = path.join(candidate, "SKILL.md");
    if (fs.existsSync(skillPath) && fs.statSync(skillPath).isFile()) {
      skillDirs.push(candidate);
    }
  }
  return skillDirs.sort();
}

function resolveSkillDirs(rootDir: string, manifestSkills?: string[]): string[] {
  if (Array.isArray(manifestSkills) && manifestSkills.length > 0) {
    return manifestSkills
      .map((entry) => resolveInside(rootDir, entry, "Skill"))
      .map((skillDir) => {
        const skillPath = path.join(skillDir, "SKILL.md");
        if (!fs.existsSync(skillPath) || !fs.statSync(skillPath).isFile()) {
          throw new Error(`Skill path must contain SKILL.md: ${path.relative(rootDir, skillDir)}`);
        }
        return skillDir;
      });
  }
  const inferred = inferSkillDirs(rootDir);
  if (inferred.length === 0) {
    throw new Error(`No skills found in ${rootDir}. Provide SKILL.md or disp8ch.skill-pack.json.`);
  }
  return inferred;
}

function readManifest(rootDir: string): {
  id: string;
  name: string;
  description: string;
  manifestPath: string | null;
  skillDirs: string[];
} {
  const manifestPath = path.join(rootDir, MANIFEST_FILE);
  const fallbackName = path.basename(rootDir);

  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as SkillPackManifest;
    const skillDirs = resolveSkillDirs(rootDir, manifest.skills);
    const primarySkill = readSkillHeading(skillDirs[0]);
    return {
      id: sanitizePackId(manifest.id || "", fallbackName),
      name: String(manifest.name || "").trim() || primarySkill.label || humanizeName(fallbackName),
      description: String(manifest.description || "").trim() || primarySkill.description,
      manifestPath,
      skillDirs,
    };
  }

  const skillDirs = resolveSkillDirs(rootDir);
  const primarySkill = readSkillHeading(skillDirs[0]);
  return {
    id: sanitizePackId("", fallbackName),
    name: humanizeName(fallbackName) || primarySkill.label,
    description:
      skillDirs.length === 1
        ? primarySkill.description
        : `Skill pack containing ${skillDirs.length} reusable skills.`,
    manifestPath: null,
    skillDirs,
  };
}

function getMetadataPath(rootDir: string): string {
  return path.join(rootDir, INSTALL_METADATA_FILE);
}

function writeInstallMetadata(install: ExternalSkillPackInstall): void {
  const metadata: StoredSkillPackMetadata = {
    ...install,
    skillDirs: install.skillDirs.map((skillDir) => path.relative(install.rootDir, skillDir) || "."),
  };
  fs.writeFileSync(getMetadataPath(install.rootDir), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function normalizeInstall(rootDir: string, metadata: Partial<StoredSkillPackMetadata>): ExternalSkillPackInstall | null {
  try {
    const manifest = readManifest(rootDir);
    const now = new Date().toISOString();
    const normalizedSkillDirs = Array.isArray(metadata.skillDirs) && metadata.skillDirs.length > 0
      ? metadata.skillDirs.map((entry) => resolveInside(rootDir, entry, "Skill"))
      : manifest.skillDirs;
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      installSource: metadata.installSource === "git" ? "git" : "local",
      sourceRef: String(metadata.sourceRef || rootDir),
      installRef: metadata.installRef ? String(metadata.installRef) : null,
      sourceRevision: metadata.sourceRevision ? String(metadata.sourceRevision) : null,
      rootDir,
      manifestPath: manifest.manifestPath,
      skillDirs: normalizedSkillDirs,
      skillCount: normalizedSkillDirs.length,
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

function readInstallMetadata(rootDir: string): StoredSkillPackMetadata | null {
  const metadataPath = getMetadataPath(rootDir);
  if (!fs.existsSync(metadataPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metadataPath, "utf8")) as StoredSkillPackMetadata;
  } catch {
    return null;
  }
}

function inferInstallFromRoot(rootDir: string): ExternalSkillPackInstall | null {
  const metadata = readInstallMetadata(rootDir);
  if (metadata) {
    const normalized = normalizeInstall(rootDir, metadata);
    if (normalized) {
      writeInstallMetadata(normalized);
      return normalized;
    }
  }

  try {
    const stat = fs.statSync(rootDir);
    const normalized = normalizeInstall(rootDir, {
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

export function listExternalSkillPacks(): ExternalSkillPackInstall[] {
  if (!fs.existsSync(EXTERNAL_ROOT)) return [];
  const installs: ExternalSkillPackInstall[] = [];
  for (const entry of fs.readdirSync(EXTERNAL_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rootDir = path.join(EXTERNAL_ROOT, entry.name);
    const install = inferInstallFromRoot(rootDir);
    if (install) installs.push(install);
  }
  return installs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getExternalSkillPack(skillPackId: string): ExternalSkillPackInstall | null {
  return listExternalSkillPacks().find((install) => install.id === skillPackId) ?? null;
}

export function installExternalSkillPack(input: InstallExternalSkillPackInput): ExternalSkillPackInstall {
  ensureExternalRoot();
  const staged = stageInstallSource(input);
  try {
    const manifest = readManifest(staged.rootDir);
    const scan = scanExtensionSource(staged.rootDir);
    if (scan.status === "blocked") {
      throw new Error(`Skill-pack security scan blocked install: ${scan.summary}`);
    }

    const existing = getExternalSkillPack(manifest.id);
    const installDir = path.join(EXTERNAL_ROOT, sanitizeInstallDirName(manifest.id));

    if (existing?.rootDir && path.resolve(existing.rootDir) !== path.resolve(installDir)) {
      removeTree(existing.rootDir);
    }

    removeTree(installDir);
    fs.mkdirSync(installDir, { recursive: true });
    copyTree(staged.rootDir, installDir);

    const finalManifest = readManifest(installDir);
    if (finalManifest.id !== manifest.id) {
      throw new Error(`Installed skill-pack id changed unexpectedly: ${finalManifest.id}`);
    }

    const now = new Date().toISOString();
    const installed: ExternalSkillPackInstall = {
      id: finalManifest.id,
      name: finalManifest.name,
      description: finalManifest.description,
      installSource: staged.installSource,
      sourceRef: staged.sourceRef,
      installRef: staged.installRef,
      sourceRevision: staged.sourceRevision,
      rootDir: installDir,
      manifestPath: finalManifest.manifestPath,
      skillDirs: finalManifest.skillDirs,
      skillCount: finalManifest.skillDirs.length,
      scanStatus: scan.status,
      scanSummary: scan.summary,
      scanFindings: scan.findings,
      scannedAt: scan.scannedAt,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    };
    writeInstallMetadata(installed);

    log.info("Installed external skill pack", {
      skillPackId: installed.id,
      installSource: staged.installSource,
      sourceRef: staged.sourceRef,
      sourceRevision: staged.sourceRevision,
      skillCount: installed.skillCount,
      scanStatus: scan.status,
      scanWarnings: scan.warnings,
      scanErrors: scan.errors,
    });

    return installed;
  } finally {
    staged.cleanup?.();
  }
}

export function updateExternalSkillPack(skillPackId: string): ExternalSkillPackInstall {
  const existing = getExternalSkillPack(skillPackId);
  if (!existing) {
    throw new Error(`External skill pack not found: ${skillPackId}`);
  }
  return installExternalSkillPack({
    source: existing.sourceRef,
    ref: existing.installRef,
  });
}

export function uninstallExternalSkillPack(skillPackId: string): boolean {
  const existing = getExternalSkillPack(skillPackId);
  if (!existing) return false;
  removeTree(existing.rootDir);
  log.info("Uninstalled external skill pack", { skillPackId });
  return true;
}
