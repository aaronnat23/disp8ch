import path from "node:path";

export const PROTECTED_PROFILE_FILE_NAMES = [
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "TOOLS.md",
  "MEMORY.md",
  "BOOT.md",
] as const;

const PROTECTED_NAMES = new Set<string>(PROTECTED_PROFILE_FILE_NAMES.map((name) => name.toLowerCase()));

function normalized(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

export function isProtectedProfileFile(
  resolvedPath: string,
  workspacePath?: string | null,
): boolean {
  const name = path.basename(resolvedPath).toLowerCase();
  if (!PROTECTED_NAMES.has(name)) return false;

  const parent = normalized(path.dirname(resolvedPath));
  const roots = new Set<string>([
    normalized(workspacePath || path.resolve("data/workspace")),
    normalized(path.resolve("data/workspace")),
  ]);
  return roots.has(parent) || /\/agents\/[^/]+$/.test(parent);
}

export function protectedProfilePathReason(
  resolvedPath: string,
  workspacePath?: string | null,
): string | null {
  if (!isProtectedProfileFile(resolvedPath, workspacePath)) return null;
  return `${path.basename(resolvedPath)} is a protected startup profile. Use the Agents workspace-file editor so the change is confirmed, revisioned, and recoverable.`;
}
