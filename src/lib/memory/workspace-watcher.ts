// Server-only — do not import in client components.
// Watches agent-scoped workspace + memory directories for .md changes and reports
// them back to the memory manager runtime.

import fs from "node:fs";
import path from "node:path";
import { logger } from "@/lib/utils/logger";
import { resolveAtomicMemoryDir } from "./simple";

const log = logger.child("memory:workspace-watcher");

const DEBOUNCE_MS = 2000;
const POLL_INTERVAL_MS = 4000;
const IGNORED_NAMES = new Set([".git", "node_modules", ".next", "agents"]);

type WatcherStartOptions = {
  agentId?: string;
  workspacePath?: string;
  onChange?: (filePath: string) => void;
  onError?: (error: unknown) => void;
};

type WatcherScope = {
  key: string;
  agentId: string;
  workspacePath: string;
  startedAt: string;
  watchers: fs.FSWatcher[];
  pollers: Array<ReturnType<typeof setInterval>>;
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  fileSnapshots: Map<string, number>;
  watchDirs: string[];
  pollingFallback: boolean;
  lastEventAt: string | null;
  lastChangedPath: string | null;
  onChange?: (filePath: string) => void;
  onError?: (error: unknown) => void;
};

const watcherScopes = new Map<string, WatcherScope>();

function buildScopeKey(agentId: string, workspacePath: string): string {
  return `${agentId}:${path.resolve(workspacePath)}`;
}

function shouldIgnore(filePath: string): boolean {
  const parts = filePath.split(path.sep);
  return parts.some((part) => IGNORED_NAMES.has(part));
}

function computeSnapshotKey(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    return Math.floor(stat.mtimeMs);
  } catch {
    return null;
  }
}

function scanMarkdownFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (shouldIgnore(fullPath)) continue;
      if (entry.isDirectory()) {
        results.push(...scanMarkdownFilesRecursive(fullPath));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  } catch {
    // Best-effort scan.
  }
  return results;
}

function getWatchDirs(agentId: string, workspacePath: string): string[] {
  const resolvedWorkspace = path.resolve(workspacePath);
  const dirs = [
    resolvedWorkspace,
    path.join(resolvedWorkspace, "memory"),
    resolveAtomicMemoryDir(agentId),
  ];
  return Array.from(new Set(dirs.map((dir) => path.resolve(dir))));
}

function scheduleScopeChange(scope: WatcherScope, filePath: string): void {
  if (!filePath.endsWith(".md")) return;
  if (shouldIgnore(filePath)) return;

  const existing = scope.debounceTimers.get(filePath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    scope.debounceTimers.delete(filePath);
    scope.lastEventAt = new Date().toISOString();
    scope.lastChangedPath = filePath;
    try {
      scope.onChange?.(filePath);
    } catch (error) {
      scope.onError?.(error);
    }
  }, DEBOUNCE_MS);

  scope.debounceTimers.set(filePath, timer);
}

function startPollingDir(scope: WatcherScope, dir: string): void {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) return;

  for (const filePath of scanMarkdownFilesRecursive(resolved)) {
    const snapshot = computeSnapshotKey(filePath);
    if (snapshot !== null) scope.fileSnapshots.set(filePath, snapshot);
  }

  const poller = setInterval(() => {
    const seen = new Set<string>();
    for (const filePath of scanMarkdownFilesRecursive(resolved)) {
      seen.add(filePath);
      const snapshot = computeSnapshotKey(filePath);
      if (snapshot === null) continue;
      const previous = scope.fileSnapshots.get(filePath);
      if (previous === undefined) {
        scope.fileSnapshots.set(filePath, snapshot);
        scheduleScopeChange(scope, filePath);
        continue;
      }
      if (previous !== snapshot) {
        scope.fileSnapshots.set(filePath, snapshot);
        scheduleScopeChange(scope, filePath);
      }
    }

    for (const trackedPath of Array.from(scope.fileSnapshots.keys())) {
      if (!trackedPath.startsWith(`${resolved}${path.sep}`) && trackedPath !== resolved) continue;
      if (!seen.has(trackedPath) && !fs.existsSync(trackedPath)) {
        scope.fileSnapshots.delete(trackedPath);
      }
    }
  }, POLL_INTERVAL_MS);

  scope.pollers.push(poller);
  scope.pollingFallback = true;
  log.info("Polling directory for memory changes", {
    agentId: scope.agentId,
    dir: resolved,
    intervalMs: POLL_INTERVAL_MS,
  });
}

function watchDir(scope: WatcherScope, dir: string): void {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) return;

  try {
    const watcher = fs.watch(resolved, (_event, filename) => {
      if (!filename) return;
      scheduleScopeChange(scope, path.join(resolved, filename));
    });

    watcher.on("error", (error) => {
      scope.onError?.(error);
    });

    scope.watchers.push(watcher);
    log.info("Watching directory for memory changes", {
      agentId: scope.agentId,
      dir: resolved,
    });
  } catch (error) {
    scope.onError?.(error);
    log.warn("Could not watch directory", {
      agentId: scope.agentId,
      dir: resolved,
      error: String(error),
    });
  }

  startPollingDir(scope, resolved);
}

export function startWorkspaceWatcher(options?: WatcherStartOptions): void {
  const agentId = options?.agentId || "default";
  const workspacePath = options?.workspacePath || "./data/workspace";
  const key = buildScopeKey(agentId, workspacePath);
  const existing = watcherScopes.get(key);
  if (existing) {
    if (options?.onChange) existing.onChange = options.onChange;
    if (options?.onError) existing.onError = options.onError;
    return;
  }

  const scope: WatcherScope = {
    key,
    agentId,
    workspacePath: path.resolve(workspacePath),
    startedAt: new Date().toISOString(),
    watchers: [],
    pollers: [],
    debounceTimers: new Map(),
    fileSnapshots: new Map(),
    watchDirs: getWatchDirs(agentId, workspacePath),
    pollingFallback: false,
    lastEventAt: null,
    lastChangedPath: null,
    onChange: options?.onChange,
    onError: options?.onError,
  };

  watcherScopes.set(key, scope);
  for (const dir of scope.watchDirs) {
    watchDir(scope, dir);
  }
}

export function stopWorkspaceWatcher(options?: { agentId?: string; workspacePath?: string }): void {
  const keys = options
    ? [buildScopeKey(options.agentId || "default", options.workspacePath || "./data/workspace")]
    : Array.from(watcherScopes.keys());
  for (const key of keys) {
    const scope = watcherScopes.get(key);
    if (!scope) continue;
    for (const watcher of scope.watchers) {
      try {
        watcher.close();
      } catch {
        // okay
      }
    }
    for (const poller of scope.pollers) {
      clearInterval(poller);
    }
    for (const timer of scope.debounceTimers.values()) {
      clearTimeout(timer);
    }
    watcherScopes.delete(key);
  }
}

export function getWorkspaceWatcherStatus(options?: {
  agentId?: string;
  workspacePath?: string;
}): {
  started: boolean;
  startedAt: string | null;
  watchDirs: string[];
  pollingFallback: boolean;
  lastEventAt: string | null;
  lastChangedPath: string | null;
} {
  const key = buildScopeKey(options?.agentId || "default", options?.workspacePath || "./data/workspace");
  const scope = watcherScopes.get(key);
  if (!scope) {
    return {
      started: false,
      startedAt: null,
      watchDirs: [],
      pollingFallback: false,
      lastEventAt: null,
      lastChangedPath: null,
    };
  }
  return {
    started: true,
    startedAt: scope.startedAt,
    watchDirs: scope.watchDirs,
    pollingFallback: scope.pollingFallback,
    lastEventAt: scope.lastEventAt,
    lastChangedPath: scope.lastChangedPath,
  };
}
