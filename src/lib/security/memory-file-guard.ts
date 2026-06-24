import path from "node:path";

export type MemoryFileGuardRuntime = {
  agentId?: string | null;
  workspacePath?: string | null;
};

function resolveAtomicMemoryBaseDir(): string {
  const raw = process.env.MEMORY_PATH || "./data/memories";
  const resolved = path.resolve(raw);
  const basename = path.basename(resolved).toLowerCase();
  if (basename === "memory.md" || path.extname(resolved).toLowerCase() === ".md") {
    return path.join(path.dirname(resolved), "memories");
  }
  return resolved;
}

function resolveAtomicMemoryDir(agentId?: string | null): string {
  const normalizedAgent = String(agentId || "default").trim() || "default";
  const baseDir = resolveAtomicMemoryBaseDir();
  return normalizedAgent === "default"
    ? baseDir
    : path.resolve(path.join(baseDir, "agents", normalizedAgent));
}

function normalizeForPathCompare(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

function isPathInsideOrEqual(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeForPathCompare(candidate);
  const normalizedRoot = normalizeForPathCompare(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export function protectedMemoryPathReason(resolvedPath: string, runtime?: MemoryFileGuardRuntime): string | null {
  const normalizedCandidate = normalizeForPathCompare(resolvedPath);
  if (
    /(?:^|\/)agents\/[^/]+\/(?:memory(?:\/|$)|memory\.md$|MEMORY\.md$)/i.test(normalizedCandidate) ||
    /(?:^|\/)data\/workspace\/(?:memory(?:\/|$)|memory\.md$|MEMORY\.md$)/i.test(normalizedCandidate)
  ) {
    return "Memory storage is protected from generic file tools. Use memory_search or memory_get so workflow and agent scopes are enforced.";
  }

  const roots = new Set<string>();
  roots.add(resolveAtomicMemoryDir(runtime?.agentId));

  const workspaceRoot = String(runtime?.workspacePath || "").trim();
  if (workspaceRoot) {
    roots.add(path.join(workspaceRoot, "MEMORY.md"));
    roots.add(path.join(workspaceRoot, "memory.md"));
    roots.add(path.join(workspaceRoot, "memory"));
  }

  for (const root of roots) {
    if (root && isPathInsideOrEqual(resolvedPath, root)) {
      return "Memory storage is protected from generic file tools. Use memory_search or memory_get so workflow and agent scopes are enforced.";
    }
  }
  return null;
}
