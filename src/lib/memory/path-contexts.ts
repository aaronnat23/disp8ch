// Server-only — do not import in client components.
import path from "node:path";
import { getSqlite } from "@/lib/db";

export type MemoryPathContext = {
  id: string;
  pathPrefix: string;
  contextText: string;
  createdAt: string;
  updatedAt: string;
};

function normalizePathPrefix(input: string): string {
  return path.resolve(input).replace(/\\/g, "/");
}

function encodePathPrefix(input: string, agentId: string): string {
  const normalized = normalizePathPrefix(input);
  return agentId === "default" ? normalized : `${agentId}::${normalized}`;
}

function decodePathPrefix(input: string): string {
  const separator = input.indexOf("::");
  return separator >= 0 ? input.slice(separator + 2) : input;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

export function listPathContexts(agentId = "default"): MemoryPathContext[] {
  const db = getSqlite();
  return db
    .prepare(
      "SELECT id, path_prefix, context_text, created_at, updated_at FROM memory_path_contexts ORDER BY path_prefix ASC"
    )
    .all()
    .filter((row) => {
      const raw = String((row as { path_prefix: string }).path_prefix);
      if (agentId === "default") return !raw.includes("::");
      return raw.startsWith(`${agentId}::`);
    })
    .map((row) => ({
      id: String((row as { id: string }).id),
      pathPrefix: decodePathPrefix(String((row as { path_prefix: string }).path_prefix)),
      contextText: String((row as { context_text: string }).context_text),
      createdAt: String((row as { created_at: string }).created_at),
      updatedAt: String((row as { updated_at: string }).updated_at),
    }));
}

export function upsertPathContext(pathPrefix: string, contextText: string, agentId = "default"): MemoryPathContext {
  const db = getSqlite();
  const normalizedPath = encodePathPrefix(pathPrefix, agentId);
  const trimmedContext = contextText.trim();
  const now = new Date().toISOString();

  const existing = db
    .prepare("SELECT id FROM memory_path_contexts WHERE path_prefix = ?")
    .get(normalizedPath) as { id?: string } | undefined;

  const id = existing?.id ?? `mpc_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT OR REPLACE INTO memory_path_contexts (id, path_prefix, context_text, created_at, updated_at) VALUES (?, ?, ?, COALESCE((SELECT created_at FROM memory_path_contexts WHERE id = ?), ?), ?)"
  ).run(id, normalizedPath, trimmedContext, id, now, now);

  return {
    id,
    pathPrefix: decodePathPrefix(normalizedPath),
    contextText: trimmedContext,
    createdAt: existing ? now : now,
    updatedAt: now,
  };
}

export function deletePathContext(id: string): boolean {
  const db = getSqlite();
  const result = db.prepare("DELETE FROM memory_path_contexts WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getPathContextForFile(filePath: string, agentId = "default"): MemoryPathContext | null {
  const normalized = normalizePathPrefix(filePath);
  const contexts = listPathContexts(agentId).filter((item) => normalized.startsWith(item.pathPrefix));
  if (!contexts.length) return null;
  contexts.sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
  return contexts[0] ?? null;
}

export function scorePathContextBoost(query: string, contextText: string): number {
  const queryTokens = new Set(tokenize(query));
  if (!queryTokens.size) return 0;
  const contextTokens = tokenize(contextText);
  let matches = 0;
  for (const token of contextTokens) {
    if (queryTokens.has(token)) matches++;
  }
  if (!matches) return 0;
  return Math.min(0.2, matches * 0.04);
}
