/**
 * Bounds folder ingestion. Folders inside the configured workspace root are
 * allowed without extra confirmation; anything outside requires explicit
 * confirmation so "learn this folder" can never silently index arbitrary
 * filesystem locations.
 */
import path from "node:path";
import { getWorkspaceDir } from "@/lib/workspace/files";

export type WorkspacePathResolution =
  | { allowed: true; path: string; insideWorkspace: boolean }
  | { allowed: false; reason: string; requiresConfirmation: boolean };

export function resolveWorkspacePath(input: string, confirmedOutside: boolean): WorkspacePathResolution {
  const resolved = path.resolve(input);
  let workspaceRoot: string;
  try {
    workspaceRoot = path.resolve(getWorkspaceDir());
  } catch {
    workspaceRoot = path.resolve(process.cwd(), "data/workspace");
  }
  const inside =
    resolved === workspaceRoot ||
    resolved.startsWith(workspaceRoot + path.sep);

  if (inside) {
    return { allowed: true, path: resolved, insideWorkspace: true };
  }
  if (confirmedOutside) {
    return { allowed: true, path: resolved, insideWorkspace: false };
  }
  return {
    allowed: false,
    reason: `Folder is outside the configured workspace (${workspaceRoot}). Confirm to index an external folder.`,
    requiresConfirmation: true,
  };
}
