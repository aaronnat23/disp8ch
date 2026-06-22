import fs from "node:fs";
import path from "node:path";

export type SensitivePathMatch = {
  path: string;
  reason: string;
};

const SENSITIVE_PATH_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: "/etc system config", pattern: /(^|\/)etc(\/|$)/i },
  { label: "/boot system files", pattern: /(^|\/)boot(\/|$)/i },
  { label: "SSH credentials", pattern: /(^|\/)\.ssh(\/|$)/i },
  { label: "Docker socket", pattern: /docker\.sock$/i },
  { label: "environment file", pattern: /(^|\/)\.env(\.[a-z0-9._-]+)?$/i },
  { label: "app database", pattern: /(^|\/)data\/disp8ch\.db$/i },
  { label: "security audit log", pattern: /(^|\/)data\/tool-audit\.jsonl$/i },
  { label: "operator secret store", pattern: /(^|\/)data\/app_secrets(\/|$)/i },
];

function normalizeForMatch(targetPath: string): string {
  return path.resolve(String(targetPath || "")).replace(/\\/g, "/").toLowerCase();
}

function findNearestExistingAncestor(candidatePath: string): string | null {
  let current = path.resolve(candidatePath);
  while (true) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function getSensitivePathMatch(targetPath: string): SensitivePathMatch | null {
  const normalized = normalizeForMatch(targetPath);
  if (!normalized) return null;
  for (const rule of SENSITIVE_PATH_RULES) {
    if (rule.pattern.test(normalized)) {
      return { path: path.resolve(targetPath), reason: rule.label };
    }
  }
  return null;
}

export function extractSensitivePathMatchesFromCommand(command: string): SensitivePathMatch[] {
  const value = String(command || "");
  const candidates = new Set<string>();
  const regex = /(?:"([^"]+)"|'([^']+)'|(^|[\s=;])((?:~|\/|\.\.?\/)[^\s"'`;|&]+|\.env(?:\.[a-z0-9._-]+)?))/gi;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(value)) !== null) {
    const raw = match[1] || match[2] || match[4] || "";
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith("/") ||
      trimmed.startsWith("~/") ||
      trimmed.startsWith("./") ||
      trimmed.startsWith("../") ||
      /^\.env(?:\.[a-z0-9._-]+)?$/i.test(trimmed)
    ) {
      const expanded = trimmed.startsWith("~/")
        ? path.join(process.env.HOME || process.env.USERPROFILE || "~", trimmed.slice(2))
        : trimmed;
      candidates.add(expanded);
    }
  }
  const matches: SensitivePathMatch[] = [];
  for (const candidate of candidates) {
    const sensitive = getSensitivePathMatch(candidate);
    if (sensitive) matches.push(sensitive);
  }
  return matches;
}

export function assertCanonicalPathInsideRoot(candidatePath: string, rootPath: string): string {
  const resolvedRoot = fs.existsSync(rootPath)
    ? fs.realpathSync.native(rootPath)
    : path.resolve(rootPath);
  const absoluteCandidate = path.resolve(candidatePath);
  const ancestor = findNearestExistingAncestor(absoluteCandidate);
  const resolvedAncestor = ancestor
    ? fs.realpathSync.native(ancestor)
    : path.dirname(absoluteCandidate);
  const relativeSuffix = ancestor ? path.relative(ancestor, absoluteCandidate) : path.basename(absoluteCandidate);
  const canonicalCandidate = path.resolve(resolvedAncestor, relativeSuffix);
  const relativeToRoot = path.relative(resolvedRoot, canonicalCandidate);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(`Path escapes its allowed root after canonical resolution: ${candidatePath}`);
  }
  return canonicalCandidate;
}

export function assertNoSymlinkedSensitiveTarget(targetPath: string): void {
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.lstatSync(targetPath);
  if (!stat.isSymbolicLink()) return;
  const sensitive = getSensitivePathMatch(targetPath);
  if (sensitive) {
    throw new Error(`Sensitive target cannot be a symlink: ${sensitive.path} (${sensitive.reason})`);
  }
}
