import fs from "node:fs";
import path from "node:path";
import { readGgufMetadata } from "../metadata/gguf-reader";
import { normalizeGguf } from "../metadata/normalize";
import type { LocalModelArtifact } from "./types";

/**
 * Bounded local model discovery. Scans only explicit, well-known roots (never the
 * whole drive) at most one directory level deep, and parses GGUF metadata for
 * each artifact. Split GGUF sets are grouped and sized as one model.
 */

export function defaultScanRoots(env: NodeJS.ProcessEnv = process.env, extraRoots: string[] = []): string[] {
  const roots = new Set<string>();
  for (const r of extraRoots) if (r) roots.add(r);
  const configured = env.DISP8CH_MODEL_DIRS || env.MODEL_DIRS;
  if (configured) {
    const windowsPath = /^[A-Za-z]:[\\/]/.test(configured.trim());
    const delimiter = configured.includes(";") || process.platform === "win32" || windowsPath ? ";" : path.delimiter;
    for (const r of configured.split(delimiter).map((s) => s.trim()).filter(Boolean)) roots.add(r);
  }
  if (process.platform === "win32") {
    roots.add("C:\\Models");
    roots.add("C:\\llama.cpp\\models");
  } else {
    if (env.HOME) {
      roots.add(path.join(env.HOME, "models"));
      roots.add(path.join(env.HOME, ".cache", "llama.cpp"));
      roots.add(path.join(env.HOME, ".cache", "lm-studio", "models"));
    }
  }
  return [...roots].filter((r) => {
    try { return fs.statSync(r).isDirectory(); } catch { return false; }
  });
}

const SPLIT_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

function listGgufFiles(root: string, maxFiles: number): Array<{ file: string; from: string }> {
  const out: Array<{ file: string; from: string }> = [];
  const visit = (dir: string, depth: number) => {
    if (out.length >= maxFiles) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && /\.gguf$/i.test(entry.name)) out.push({ file: full, from: root });
      else if (entry.isDirectory() && depth < 1 && !entry.name.startsWith(".")) visit(full, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

export function discoverLocalModels(options?: {
  roots?: string[];
  env?: NodeJS.ProcessEnv;
  maxFilesPerRoot?: number;
}): LocalModelArtifact[] {
  const roots = options?.roots ?? defaultScanRoots(options?.env);
  const maxFiles = options?.maxFilesPerRoot ?? 200;
  const artifacts: LocalModelArtifact[] = [];
  const splitGroups = new Map<string, { paths: string[]; from: string; expected: number; shardNumbers: Set<number> }>();

  for (const root of roots) {
    for (const { file, from } of listGgufFiles(root, maxFiles)) {
      const base = path.basename(file);
      const split = base.match(SPLIT_RE);
      if (split) {
        const key = path.join(path.dirname(file), split[1]);
        const expected = Number(split[3]);
        const group = splitGroups.get(key) ?? { paths: [], from, expected, shardNumbers: new Set<number>() };
        if (group.expected !== expected) continue;
        group.paths.push(file);
        group.shardNumbers.add(Number(split[2]));
        splitGroups.set(key, group);
        continue;
      }
      artifacts.push(buildArtifact(file, from, "gguf"));
    }
  }

  // Collapse split sets into one artifact (metadata from the first shard).
  for (const [key, group] of splitGroups) {
    if (
      group.paths.length !== group.expected ||
      group.shardNumbers.size !== group.expected ||
      !Array.from({ length: group.expected }, (_, index) => index + 1).every((part) => group.shardNumbers.has(part))
    ) {
      continue;
    }
    const sorted = group.paths.sort();
    const first = sorted[0];
    const artifact = buildArtifact(first, group.from, "gguf_split");
    artifact.id = `local:${path.basename(key)}`;
    artifact.displayName = path.basename(key);
    artifact.path = first;
    artifact.sizeBytes = sorted.reduce((sum, p) => sum + safeSize(p), 0);
    artifacts.push(artifact);
  }

  // De-dupe by resolved path, locals ranked by size desc as a stable default.
  const seen = new Set<string>();
  return artifacts
    .filter((a) => { const r = path.resolve(a.path); if (seen.has(r)) return false; seen.add(r); return true; })
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function safeSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function buildArtifact(file: string, from: string, format: LocalModelArtifact["format"]): LocalModelArtifact {
  let sizeBytes = 0;
  let modifiedAt = new Date(0).toISOString();
  let readable = false;
  try {
    const st = fs.statSync(file);
    sizeBytes = st.size;
    modifiedAt = st.mtime.toISOString();
    fs.accessSync(file, fs.constants.R_OK);
    readable = true;
  } catch { /* unreadable */ }

  let metadata = null;
  if (readable) {
    try {
      metadata = normalizeGguf(readGgufMetadata(file), path.basename(file));
    } catch { metadata = null; }
  }

  return {
    id: `local:${path.basename(file)}`,
    displayName: metadata?.displayName || path.basename(file),
    path: file,
    sizeBytes,
    format,
    discoveredFrom: from,
    readable,
    modifiedAt,
    metadata,
  };
}
