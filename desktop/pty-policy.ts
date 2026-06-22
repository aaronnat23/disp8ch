import path from "node:path";

/**
 * Pure policy + lifecycle helpers for the optional Developer Workspace terminal
 * (Phase 4). No node-pty import here so the safety rules are unit-testable. The
 * operator terminal is bounded to trusted workspace roots and every PTY must be
 * killed on window close, runtime restart, update, and app exit.
 */

export function isWithinRoot(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export type CwdResolution = { ok: boolean; cwd?: string; reason?: string };

/**
 * Resolve the working directory for a new terminal. When a directory is
 * requested it must resolve inside one of the trusted roots; otherwise we fall
 * back to the first trusted root. Leaving trusted roots is denied.
 */
export function resolveStartCwd(requested: string | undefined, trustedRoots: string[]): CwdResolution {
  const roots = trustedRoots.filter(Boolean);
  if (roots.length === 0) return { ok: false, reason: "no-trusted-roots" };
  if (!requested) return { ok: true, cwd: path.resolve(roots[0]) };
  const resolved = path.resolve(requested);
  const inside = roots.some((root) => isWithinRoot(resolved, root));
  if (!inside) return { ok: false, reason: "outside-trusted-roots" };
  return { ok: true, cwd: resolved };
}

export function defaultShell(platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === "win32") {
    return { file: process.env.COMSPEC || "powershell.exe", args: [] };
  }
  return { file: process.env.SHELL || "/bin/bash", args: ["-l"] };
}

export type TrackedPty = { id: string; kill: () => void };

/** Tracks live PTYs so they can all be terminated on lifecycle events. */
export class PtyRegistry {
  private sessions = new Map<string, TrackedPty>();

  add(session: TrackedPty): void {
    this.sessions.set(session.id, session);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      try {
        session.kill();
      } catch {
        /* already gone */
      }
    }
    this.sessions.clear();
  }
}
