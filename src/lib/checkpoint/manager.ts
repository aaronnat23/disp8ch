/**
 * Checkpoint Manager — transparent filesystem snapshots via shadow git repos.
 *
 * Stores a dedicated shadow repo outside the workspace, then points git at the
 * real workspace using GIT_DIR + GIT_WORK_TREE. This avoids leaking git state
 * into the project and makes rollback/diff behave consistently on the live app
 * root.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { logger } from "@/lib/utils/logger";

const log = logger.child("checkpoint");

export type CheckpointEntry = {
  id: string;
  label: string;
  timestamp: string;
};

export type CheckpointDiff = {
  id: string;
  diff: string;
};

const MAX_CHECKPOINTS = 200;
const AUTO_CHECKPOINT_DEDUPE_MS = 30_000;
const GIT_OPERATION_TIMEOUT_MS = 90_000;
const GIT_INIT_TIMEOUT_MS = 30_000;
const DEFAULT_EXCLUDES = [
  ".claude/",
  "node_modules/",
  ".next/",
  ".tmp/",
  ".tools/",
  ".dpc-cache/",
  "archive/",
  "dist/",
  "build/",
  "backups/",
  "disp8ch_images/",
  "coverage/",
  "crew-output/",
  "data/",
  "release/",
  "screenshot/",
  "screenshots/",
  "test-results/",
  "tmp/",
  "dev_server.log",
  "server_startup.log",
  "tsconfig.tsbuildinfo",
  "webchat-*.json",
  "webchat-*.md",
  "checkpoint-speed-*.txt",
  "probe-checkpoint-*.txt",
  "*.tar",
  "*.tar.gz",
  "*.tgz",
  "*.zip",
  "*.7z",
  "*.rar",
];
const PURGE_TRACKED_PATHS = [
  ".claude",
  ".next",
  ".tmp",
  ".tools",
  ".dpc-cache",
  "archive",
  "backups",
  "disp8ch_images",
  "coverage",
  "crew-output",
  "data",
  "dist",
  "build",
  "node_modules",
  "release",
  "screenshot",
  "screenshots",
  "test-results",
  "tmp",
  "dev_server.log",
  "server_startup.log",
  "tsconfig.tsbuildinfo",
];
const DEFAULT_TRACKED_DIRS = new Set([
  "extensions",
  "optional-skills",
  "public",
  "scripts",
  "server",
  "skills",
  "src",
]);
const DEFAULT_TRACKED_FILE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const DEFAULT_TRACKED_FILES = new Set([
  ".env.example",
  ".eslintrc.json",
  ".gitignore",
  ".npmrc",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
]);
const recentAutoCheckpointSignatures = new Map<string, number>();

function getWorkspaceRoot(): string {
  return path.resolve(process.env.WORKSPACE_ROOT || process.cwd());
}

function getCheckpointBaseDir(): string {
  return path.join(
    process.env.DISP8CH_CHECKPOINT_HOME || path.join(os.homedir(), ".disp8ch"),
    "checkpoints",
  );
}

function getWorkspaceHash(): string {
  return crypto.createHash("sha256").update(getWorkspaceRoot()).digest("hex").slice(0, 16);
}

function getShadowRepoPath(): string {
  return path.join(getCheckpointBaseDir(), getWorkspaceHash());
}

function getShadowGitDir(): string {
  return path.join(getShadowRepoPath(), ".git");
}

function gitInShadow(args: string[], options?: { maxBuffer?: number }): string {
  return execFileSync("git", args, {
    timeout: GIT_OPERATION_TIMEOUT_MS,
    maxBuffer: options?.maxBuffer ?? 2 * 1024 * 1024,
    encoding: "utf-8",
    windowsHide: true,
    cwd: getWorkspaceRoot(),
    env: {
      ...process.env,
      GIT_DIR: getShadowGitDir(),
      GIT_WORK_TREE: getWorkspaceRoot(),
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "disp8ch",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "disp8ch@local",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "disp8ch",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "disp8ch@local",
    },
  }).trim();
}

function hasStagedCheckpointChanges(): boolean {
  try {
    gitInShadow(["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    return true;
  }
}

function writeShadowExcludeFile(): void {
  const excludePath = path.join(getShadowGitDir(), "info", "exclude");
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  fs.writeFileSync(excludePath, DEFAULT_EXCLUDES.join("\n") + "\n", "utf-8");
}

function configureShadowRepo(): void {
  gitInShadow(["config", "user.email", "disp8ch@local"]);
  gitInShadow(["config", "user.name", "disp8ch Checkpoint"]);
  gitInShadow(["config", "core.autocrlf", "false"]);
  gitInShadow(["config", "core.eol", "lf"]);
}

function ensureShadowRepo(): void {
  const shadowRepo = getShadowRepoPath();
  const gitDir = getShadowGitDir();

  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(shadowRepo, { recursive: true });
    execFileSync("git", ["init", shadowRepo], {
      timeout: GIT_INIT_TIMEOUT_MS,
      encoding: "utf-8",
      windowsHide: true,
    });
    configureShadowRepo();
    writeShadowExcludeFile();
    log.info("Shadow checkpoint repo initialized", { path: shadowRepo, workspace: getWorkspaceRoot() });
    return;
  }

  configureShadowRepo();
  writeShadowExcludeFile();
}

function purgeExcludedTrackedPaths(): void {
  const markerPath = path.join(getShadowGitDir(), "info", "disp8ch-exclude-purge-v2");
  if (fs.existsSync(markerPath)) return;

  try {
    gitInShadow(["rm", "-r", "--cached", "--ignore-unmatch", "--", ...PURGE_TRACKED_PATHS], {
      maxBuffer: 10 * 1024 * 1024,
    });
    fs.writeFileSync(markerPath, new Date().toISOString(), "utf-8");
  } catch (err) {
    log.warn("Checkpoint tracked exclude purge skipped", { error: String(err) });
  }
}

function isCheckpointEnabled(): boolean {
  try {
    const { getSqlite } = require("@/lib/db") as { getSqlite: () => import("better-sqlite3").Database };
    const db = getSqlite();
    const row = db.prepare("SELECT checkpoint_enabled FROM app_config WHERE id = 'default'").get() as { checkpoint_enabled?: number } | undefined;
    return row?.checkpoint_enabled !== 0;
  } catch {
    return true;
  }
}

function tryReadHead(): CheckpointEntry | null {
  try {
    const head = gitInShadow(["log", "-1", "--format=%h|%s|%aI"]);
    if (!head) return null;
    const [id = "", label = "", timestamp = ""] = head.split("|");
    return { id, label, timestamp };
  } catch {
    return null;
  }
}

function normalizeTrackedPaths(paths?: string[]): string[] {
  if (!paths?.length) return [];
  const root = getWorkspaceRoot();
  const rootWithSep = root + path.sep;
  return paths
    .map((item) => path.resolve(item))
    .filter((item) => item === root || item.startsWith(rootWithSep))
    .map((item) => path.relative(root, item));
}

function normalizeGitPath(relativePath: string): string {
  if (relativePath === "") return ".";
  return relativePath.split(path.sep).join("/");
}

function existingRelativePaths(relativePaths: string[]): string[] {
  const root = getWorkspaceRoot();
  return relativePaths
    .filter((item) => fs.existsSync(path.join(root, item)))
    .map(normalizeGitPath);
}

function getDefaultTrackedRelativePaths(): string[] {
  const root = getWorkspaceRoot();
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => {
      if (entry.isDirectory()) return DEFAULT_TRACKED_DIRS.has(entry.name);
      if (!entry.isFile()) return false;
      if (entry.name === "next-env.d.ts") return false;
      if (DEFAULT_TRACKED_FILES.has(entry.name)) return true;
      if (/^webchat-.*\.(?:json|md)$/i.test(entry.name)) return false;
      if (/^(?:checkpoint-speed-|probe-checkpoint-)/i.test(entry.name)) return false;
      return DEFAULT_TRACKED_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
    })
    .map((entry) => entry.name)
    .sort();
}

function buildAddArgs(paths?: string[]): string[] | null {
  const relativePaths = existingRelativePaths(normalizeTrackedPaths(paths));
  if (paths?.length) {
    if (relativePaths.length === 0) return null;
    return ["add", "-A", "-f", "--", ...relativePaths];
  }

  const defaultPaths = existingRelativePaths(getDefaultTrackedRelativePaths());
  if (defaultPaths.length === 0) return null;
  return ["add", "-A", "--", ...defaultPaths];
}

export function createCheckpoint(label?: string, trackedPaths?: string[]): CheckpointEntry | null {
  if (!isCheckpointEnabled()) {
    return null;
  }

  try {
    ensureShadowRepo();
    const commitLabel = label || `auto-checkpoint ${new Date().toISOString()}`;

    purgeExcludedTrackedPaths();
    const addArgs = buildAddArgs(trackedPaths);
    if (!addArgs) {
      return tryReadHead();
    }
    gitInShadow(addArgs);
    if (!hasStagedCheckpointChanges()) {
      return tryReadHead();
    }

    gitInShadow(["commit", "-m", `checkpoint: ${commitLabel}`]);
    const head = tryReadHead();
    if (head) {
      log.info("Checkpoint created", { id: head.id, label: commitLabel });
    }
    return head;
  } catch (err) {
    log.error("Checkpoint create failed", { error: String(err) });
    return null;
  }
}

export function listCheckpoints(limit?: number): CheckpointEntry[] {
  try {
    ensureShadowRepo();
    const count = Math.min(limit ?? 20, MAX_CHECKPOINTS);
    const raw = gitInShadow(["log", `--max-count=${count}`, "--format=%h|%s|%aI"]);
    if (!raw) return [];
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id = "", label = "", timestamp = ""] = line.split("|");
        return { id, label, timestamp };
      });
  } catch (err) {
    log.error("Checkpoint list failed", { error: String(err) });
    return [];
  }
}

export function diffCheckpoint(checkpointId: string): CheckpointDiff {
  try {
    ensureShadowRepo();
    try {
      const addArgs = buildAddArgs();
      if (addArgs) {
        gitInShadow(addArgs);
      }
    } catch {
      // Best effort: if staging fails we still try to diff tracked state.
    }
    const diff = gitInShadow(["diff", checkpointId, "--cached"], { maxBuffer: 5 * 1024 * 1024 });
    try {
      gitInShadow(["reset", "HEAD", "--quiet"]);
    } catch {
      // ignore index cleanup failures
    }
    return { id: checkpointId, diff: diff || "(no differences)" };
  } catch (err) {
    return { id: checkpointId, diff: `Error: ${String(err)}` };
  }
}

export function rollbackToCheckpoint(checkpointId: string): {
  success: boolean;
  safetyCheckpoint?: CheckpointEntry | null;
  error?: string;
  restoredPath?: string;
} {
  return rollbackToCheckpointPath(checkpointId);
}

export function rollbackToCheckpointPath(checkpointId: string, filePath?: string): {
  success: boolean;
  safetyCheckpoint?: CheckpointEntry | null;
  error?: string;
  restoredPath?: string;
} {
  try {
    ensureShadowRepo();
    const safety = createCheckpoint("pre-rollback safety snapshot");

    const relativeRestorePath = filePath ? normalizeTrackedPaths([filePath])[0] : undefined;
    if (filePath && !relativeRestorePath) {
      return { success: false, safetyCheckpoint: safety, error: `Path outside workspace: ${filePath}` };
    }

    if (relativeRestorePath) {
      gitInShadow(["checkout", checkpointId, "--", relativeRestorePath]);
    } else {
      gitInShadow(["reset", "--hard", checkpointId]);
      try {
        gitInShadow(["clean", "-fdx"]);
      } catch (err) {
        log.warn("Checkpoint cleanup skipped after restore", { to: checkpointId, error: String(err) });
      }
    }
    log.info("Checkpoint rollback completed", { to: checkpointId, safety: safety?.id, path: relativeRestorePath });
    return { success: true, safetyCheckpoint: safety, restoredPath: relativeRestorePath };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export function rollbackLast(): { success: boolean; safetyCheckpoint?: CheckpointEntry | null; error?: string } {
  try {
    ensureShadowRepo();
    const checkpoints = listCheckpoints(2);
    if (checkpoints.length < 2) {
      return { success: false, error: "No previous checkpoint to roll back to" };
    }
    // Roll back to HEAD~1 (the checkpoint before the latest)
    const prevId = checkpoints[1].id;
    return rollbackToCheckpointPath(prevId);
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export function autoCheckpoint(operation: string, filePath?: string): void {
  if (!isCheckpointEnabled()) return;

  try {
    const signature = computeAutoCheckpointSignature(operation, filePath);
    const now = Date.now();
    const previous = recentAutoCheckpointSignatures.get(signature) ?? 0;
    if (now - previous < AUTO_CHECKPOINT_DEDUPE_MS) {
      return;
    }

    const label = filePath ? `before ${operation}: ${path.basename(filePath)}` : `before ${operation}`;
    const checkpoint = createCheckpoint(label, filePath ? [filePath] : undefined);
    if (checkpoint) {
      recentAutoCheckpointSignatures.set(signature, now);
      pruneRecentAutoCheckpointSignatures(now);
    }
  } catch {
    // Non-fatal — do not block the underlying file operation.
  }
}

function computeAutoCheckpointSignature(operation: string, filePath?: string): string {
  if (!filePath) {
    return `workspace:${operation}:${tryReadHead()?.id || "no-head"}`;
  }

  const resolved = path.resolve(filePath);
  try {
    const stat = fs.statSync(resolved);
    return `file:${operation}:${resolved}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch {
    return `file:${operation}:${resolved}:missing`;
  }
}

function pruneRecentAutoCheckpointSignatures(now: number): void {
  for (const [signature, seenAt] of recentAutoCheckpointSignatures.entries()) {
    if (now - seenAt > AUTO_CHECKPOINT_DEDUPE_MS) {
      recentAutoCheckpointSignatures.delete(signature);
    }
  }
}

const checkpointManager = {
  autoCheckpoint,
  createCheckpoint,
  diffCheckpoint,
  listCheckpoints,
  rollbackLast,
  rollbackToCheckpoint,
};

export default checkpointManager;
