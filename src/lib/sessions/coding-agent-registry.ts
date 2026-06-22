import { logger } from "@/lib/utils/logger";
import fs from "node:fs";
import path from "node:path";

const log = logger.child("sessions:coding-agent");

// ── ACP-style session limits ──────────────────────────────────────────────────

/** Sessions older than this (from lastUsedAt) are considered expired. */
export const SESSION_TTL_MS = 120 * 60 * 1000; // 120 minutes

/** Maximum concurrent coding-agent sessions (ACP default: 4). */
export const MAX_CONCURRENT_SESSIONS = 4;

// ── Claude binary discovery ───────────────────────────────────────────────────

/**
 * Find the claude CLI binary, checking multiple common paths.
 * Works in Next.js server processes where HOME may not be set.
 */
export function findClaudeBinary(): string {
  const candidates: string[] = [
    // Windows: Claude Desktop installs claude.exe in LOCALAPPDATA
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "AnthropicClaude", "claude.exe")
      : "",
    // Windows: user-specific AppData path (common install location)
    process.platform === "win32" && process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Local", "AnthropicClaude", "claude.exe")
      : "",
    // WSL / Linux — explicit user paths
    process.env.HOME ? path.join(process.env.HOME, ".local", "bin", "claude") : "",
    "/home/aaron/.local/bin/claude",
    "/home/user/.local/bin/claude",
    // Homebrew / macOS
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* skip */ }
  }
  return "claude"; // last resort — rely on PATH
}

export type CodingAgentSession = {
  sessionId: string;
  agent: string;
  label: string;
  createdAt: number;
  lastUsedAt: number;
  /** Absolute timestamp when this session expires (TTL-based). */
  expiresAt: number;
  discordThreadId?: string;
  discordChannelId?: string;
  /** Disp8chTeam-style git worktree path for this session (if worktree isolation was requested). */
  worktreePath?: string;
};

function getSessionRegistry(): Map<string, CodingAgentSession> {
  const g = globalThis as typeof globalThis & {
    __disp8chCodingAgentSessions?: Map<string, CodingAgentSession>;
  };
  if (!g.__disp8chCodingAgentSessions) {
    g.__disp8chCodingAgentSessions = new Map();
  }
  return g.__disp8chCodingAgentSessions;
}

function getThreadBindings(): Map<string, string> {
  const g = globalThis as typeof globalThis & {
    __disp8chDiscordCodingThreadBindings?: Map<string, string>;
  };
  if (!g.__disp8chDiscordCodingThreadBindings) {
    g.__disp8chDiscordCodingThreadBindings = new Map();
  }
  return g.__disp8chDiscordCodingThreadBindings;
}

// ── Discord context (set while processing a Discord message) ─────────────────

type DiscordMessageContext = { channelId: string; guildId: string } | null;

function getDiscordCtxHolder(): { ctx: DiscordMessageContext } {
  const g = globalThis as typeof globalThis & {
    __disp8chCurrentDiscordCtx?: { ctx: DiscordMessageContext };
  };
  if (!g.__disp8chCurrentDiscordCtx) {
    g.__disp8chCurrentDiscordCtx = { ctx: null };
  }
  return g.__disp8chCurrentDiscordCtx;
}

export function setCurrentDiscordContext(ctx: DiscordMessageContext): void {
  getDiscordCtxHolder().ctx = ctx;
}

export function getCurrentDiscordContext(): DiscordMessageContext {
  return getDiscordCtxHolder().ctx;
}

// ── Session registry ──────────────────────────────────────────────────────────

// ── Spawn-depth guard ─────────────────────────────────────────────────────────

function getSpawnDepthHolder(): { depth: number } {
  const g = globalThis as typeof globalThis & {
    __disp8chSpawnDepth?: { depth: number };
  };
  if (!g.__disp8chSpawnDepth) g.__disp8chSpawnDepth = { depth: 0 };
  return g.__disp8chSpawnDepth;
}

/** Returns the current nesting depth of sessions_spawn calls (1 = top-level agent spawned it). */
export function getSpawnDepth(): number {
  return getSpawnDepthHolder().depth;
}

export function incrementSpawnDepth(): void {
  getSpawnDepthHolder().depth++;
}

export function decrementSpawnDepth(): void {
  const h = getSpawnDepthHolder();
  if (h.depth > 0) h.depth--;
}

// ── TTL helpers ───────────────────────────────────────────────────────────────

/** Remove sessions whose TTL has elapsed. */
export function pruneExpiredSessions(): void {
  const registry = getSessionRegistry();
  const now = Date.now();
  for (const [id, session] of registry.entries()) {
    if (session.expiresAt <= now) {
      registry.delete(id);
      log.info("Coding agent session expired and pruned", { sessionId: id });
    }
  }
}

/** Active (non-expired) sessions. */
export function getActiveSessions(): CodingAgentSession[] {
  pruneExpiredSessions();
  return Array.from(getSessionRegistry().values()).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

// ── Session registry ──────────────────────────────────────────────────────────

export function registerCodingAgentSession(session: Omit<CodingAgentSession, "expiresAt"> & { expiresAt?: number }): void {
  pruneExpiredSessions();
  const registry = getSessionRegistry();
  if (registry.size >= MAX_CONCURRENT_SESSIONS) {
    // Evict least-recently-used session to stay within the cap
    const lru = Array.from(registry.values()).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (lru) {
      registry.delete(lru.sessionId);
      log.warn("Max concurrent sessions reached — evicting LRU session", { evicted: lru.sessionId });
    }
  }
  const full: CodingAgentSession = {
    ...session,
    expiresAt: session.expiresAt ?? (Date.now() + SESSION_TTL_MS),
  };
  registry.set(full.sessionId, full);
  log.info("Coding agent session registered", { sessionId: full.sessionId, agent: full.agent });
}

export function getCodingAgentSession(sessionId: string): CodingAgentSession | undefined {
  return getSessionRegistry().get(sessionId);
}

export function touchCodingAgentSession(sessionId: string): void {
  const session = getSessionRegistry().get(sessionId);
  if (session) {
    session.lastUsedAt = Date.now();
    session.expiresAt = Date.now() + SESSION_TTL_MS;
  }
}

export function listCodingAgentSessions(): CodingAgentSession[] {
  pruneExpiredSessions();
  return Array.from(getSessionRegistry().values()).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export function deleteCodingAgentSession(sessionId: string): void {
  const session = getSessionRegistry().get(sessionId);
  getSessionRegistry().delete(sessionId);
  // Clean up worktree if one was attached to this session
  if (session?.worktreePath) {
    try {
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      execFileSync("git", ["worktree", "remove", "--force", session.worktreePath], { timeout: 10000 });
      log.info("Worktree cleaned up on session delete", { worktreePath: session.worktreePath });
    } catch (err) {
      log.warn("Failed to remove worktree on session delete", { worktreePath: session.worktreePath, error: String(err) });
    }
  }
}

// ── Discord thread bindings ───────────────────────────────────────────────────

export function bindDiscordThread(threadChannelId: string, sessionId: string): void {
  getThreadBindings().set(threadChannelId, sessionId);
  const session = getSessionRegistry().get(sessionId);
  if (session) {
    session.discordThreadId = threadChannelId;
  }
  log.info("Discord thread bound to coding session", { threadChannelId, sessionId });
}

export function resolveDiscordThreadSession(threadChannelId: string): string | undefined {
  return getThreadBindings().get(threadChannelId);
}

export function unbindDiscordThread(threadChannelId: string): void {
  getThreadBindings().delete(threadChannelId);
}

export function listThreadBindings(): Array<{ threadChannelId: string; sessionId: string }> {
  return Array.from(getThreadBindings().entries()).map(([threadChannelId, sessionId]) => ({
    threadChannelId,
    sessionId,
  }));
}
