import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSqlite } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import { getWorkspaceDir } from "@/lib/workspace/files";

const log = logger.child("hooks");
const nativeImport = async (url: string): Promise<Record<string, unknown>> =>
  import(/* webpackIgnore: true */ url);

export interface HookEvent {
  type: string;
  ts: string;
  data: Record<string, unknown>;
}

export function getHooksDir(): string {
  return path.join(getWorkspaceDir(), "hooks");
}

export function isHooksEnabled(): boolean {
  try {
    const db = getSqlite();
    const row = db.prepare("SELECT hooks_enabled FROM app_config WHERE id = 'default'").get() as
      | { hooks_enabled?: number | null }
      | undefined;
    return (row?.hooks_enabled ?? 1) !== 0;
  } catch {
    return true;
  }
}

export function ensureHooksDirectory(): string {
  const dir = getHooksDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listHookFiles(): string[] {
  const dir = ensureHooksDirectory();
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(mjs|js|cjs)$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

export function getHookFileState(filePath: string): { enabled: boolean; note: string | null; updatedAt: string | null } {
  try {
    const row = getSqlite()
      .prepare("SELECT enabled, note, updated_at FROM hook_file_state WHERE hook_path = ?")
      .get(filePath) as { enabled?: number | null; note?: string | null; updated_at?: string | null } | undefined;
    return {
      enabled: (row?.enabled ?? 1) !== 0,
      note: row?.note ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  } catch {
    return { enabled: true, note: null, updatedAt: null };
  }
}

export function setHookFileEnabled(filePath: string, enabled: boolean): void {
  const allowed = new Set(listHookFiles());
  if (!allowed.has(filePath)) {
    throw new Error("Hook file is not in the workspace hooks directory");
  }
  const now = new Date().toISOString();
  getSqlite().prepare(
    `INSERT INTO hook_file_state(hook_path, enabled, note, updated_at)
     VALUES(?, ?, NULL, ?)
     ON CONFLICT(hook_path) DO UPDATE SET
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).run(filePath, enabled ? 1 : 0, now);
}

async function runSingleHook(filePath: string, event: HookEvent): Promise<void> {
  const fileUrl = pathToFileURL(filePath).href;
  let mod: Record<string, unknown>;
  try {
    mod = await nativeImport(`${fileUrl}?v=${Date.now()}`);
  } catch (error) {
    // Some runtimes reject file URL query params. Fall back to plain import.
    mod = await nativeImport(fileUrl);
  }
  const handler = typeof mod.default === "function"
    ? mod.default
    : typeof mod.onEvent === "function"
      ? mod.onEvent
      : null;
  if (!handler) return;

  // Keep hook execution bounded to avoid stalling workflow execution.
  await Promise.race([
    Promise.resolve(handler(event)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Hook timed out after 2000ms")), 2000)),
  ]);
}

export type HookRunResult = {
  filePath: string;
  status: "ok" | "skipped" | "failed";
  durationMs: number;
  error: string | null;
};

function persistHookRunState(type: string, result: HookRunResult) {
  try {
    const now = new Date().toISOString();
    getSqlite().prepare(
      `INSERT INTO hook_run_state(hook_path, last_event_type, last_status, last_error, last_duration_ms, last_run_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hook_path) DO UPDATE SET
         last_event_type = excluded.last_event_type,
         last_status = excluded.last_status,
         last_error = excluded.last_error,
         last_duration_ms = excluded.last_duration_ms,
         last_run_at = excluded.last_run_at,
         updated_at = excluded.updated_at`,
    ).run(result.filePath, type, result.status, result.error, result.durationMs, now, now);
  } catch {
    // Hook state is diagnostic only.
  }
}

export async function runHooksWithReport(type: string, data: Record<string, unknown>): Promise<HookRunResult[]> {
  if (!isHooksEnabled()) return [];
  const results: HookRunResult[] = [];
  try {
    const files = listHookFiles();
    if (files.length === 0) return results;

    const event: HookEvent = {
      type,
      ts: new Date().toISOString(),
      data,
    };

    for (const filePath of files) {
      const startedAt = Date.now();
      if (!getHookFileState(filePath).enabled) {
        const result: HookRunResult = { filePath, status: "skipped", durationMs: 0, error: "Hook disabled" };
        results.push(result);
        persistHookRunState(type, result);
        continue;
      }
      try {
        await runSingleHook(filePath, event);
        const result: HookRunResult = { filePath, status: "ok", durationMs: Date.now() - startedAt, error: null };
        results.push(result);
        persistHookRunState(type, result);
      } catch (error) {
        const result: HookRunResult = { filePath, status: "failed", durationMs: Date.now() - startedAt, error: String(error) };
        results.push(result);
        persistHookRunState(type, result);
        log.warn("Hook execution failed", { filePath, type, error: String(error) });
      }
    }
  } catch (error) {
    log.warn("Hook discovery failed", { type, error: String(error) });
  }
  return results;
}

export async function runHooks(type: string, data: Record<string, unknown>): Promise<void> {
  await runHooksWithReport(type, data);
}
