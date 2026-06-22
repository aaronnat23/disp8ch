import fs from "node:fs";
import path from "node:path";

// Vault initializer for a research department.
//
// Generic and reusable: given any root path it creates the canonical markdown
// vault tree and a SCHEMA.md. Path-safety helpers are exported so workflow
// builders and the executor reuse the exact same "stay inside the vault" check.

export const RESEARCH_SUBDIRS = ["research/inbox", "research/processed", "research/rejected", "research/snapshots"] as const;

export const WIKI_SUBDIRS = ["wiki/sources", "wiki/synthesis", "wiki/briefs", "wiki/entities", "wiki/contradictions"] as const;

export interface VaultPaths {
  root: string;
  inbox: string;
  processed: string;
  rejected: string;
  snapshots: string;
  wiki: string;
  wikiSources: string;
  wikiSynthesis: string;
  wikiBriefs: string;
  wikiEntities: string;
  wikiContradictions: string;
  schema: string;
}

/** Lowercase, hyphenated, filesystem-safe slug. Never empty. */
export function sanitizeSlug(raw: string): string {
  const slug = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "research-department";
}

/** Default workspace-relative vault root for a department slug. */
export function defaultVaultRoot(slug: string): string {
  return path.join("data", "workspace", "research-department", sanitizeSlug(slug));
}

/** Resolve a vault root to an absolute path rooted at the process cwd. */
export function resolveVaultRoot(vaultRoot: string): string {
  return path.resolve(process.cwd(), vaultRoot);
}

/**
 * Returns true when `target` is inside `root` (after resolution).
 * Reused by the executor's write guard and the setup safety checks.
 */
export function isInsideVault(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedRoot) return true;
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Validate that a custom vault root is acceptable. Paths inside the default
 * workspace are always allowed; anything else requires explicit confirmation.
 */
export function validateVaultRoot(
  vaultRoot: string,
  options: { allowCustomPath?: boolean } = {},
): { ok: boolean; reason?: string } {
  const resolved = resolveVaultRoot(vaultRoot);
  const workspaceRoot = path.resolve(process.cwd(), "data", "workspace");
  if (isInsideVault(workspaceRoot, resolved) || resolved === workspaceRoot) {
    return { ok: true };
  }
  if (options.allowCustomPath) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `Vault path "${vaultRoot}" is outside the default workspace. Pass allowCustomVaultPath to confirm.`,
  };
}

export function computeVaultPaths(vaultRoot: string): VaultPaths {
  const root = resolveVaultRoot(vaultRoot);
  return {
    root,
    inbox: path.join(root, "research", "inbox"),
    processed: path.join(root, "research", "processed"),
    rejected: path.join(root, "research", "rejected"),
    snapshots: path.join(root, "research", "snapshots"),
    wiki: path.join(root, "wiki"),
    wikiSources: path.join(root, "wiki", "sources"),
    wikiSynthesis: path.join(root, "wiki", "synthesis"),
    wikiBriefs: path.join(root, "wiki", "briefs"),
    wikiEntities: path.join(root, "wiki", "entities"),
    wikiContradictions: path.join(root, "wiki", "contradictions"),
    schema: path.join(root, "wiki", "SCHEMA.md"),
  };
}

function buildSchemaMarkdown(focusArea: string): string {
  const now = new Date().toISOString();
  return `---
created_at: "${now}"
kind: "research-vault-schema"
---

# Research Wiki Schema

**Focus area:** ${focusArea || "(set your niche/topic here)"}

This vault is a local, portable plain-markdown knowledge base maintained by a
disp8ch Research Department. It is plain markdown — open it in any markdown editor.

## Folder map

- \`research/inbox/\` — raw Scout findings awaiting analysis.
- \`research/processed/\` — raw findings already synthesized.
- \`research/rejected/\` — findings discarded as irrelevant.
- \`research/snapshots/\` — page snapshots for competitor diffing.
- \`wiki/sources/\` — per-source reference notes.
- \`wiki/synthesis/\` — Analyst synthesis notes (the knowledge base).
- \`wiki/entities/\` — entity notes (people, products, orgs).
- \`wiki/contradictions/\` — conflict notes when new evidence disagrees.
- \`wiki/briefs/\` — archived daily/weekly briefs (\`YYYY-MM-DD.md\`).

## Conventions

- Every factual claim cites a source file or URL.
- Every claim carries one confidence tag: \`[verified]\`, \`[likely]\`, \`[unverified]\`, or \`[conflicting]\`.
- Notes link related notes with \`[[wikilinks]]\`.
- Source files are never deleted; inbox files move to \`processed/\` only after a wiki write succeeds.
`;
}

export interface InitVaultResult {
  paths: VaultPaths;
  createdSchema: boolean;
}

/**
 * Create the vault folder tree and SCHEMA.md if missing. Idempotent.
 * Throws when the root is outside the workspace and not explicitly confirmed.
 */
export function initializeVault(
  vaultRoot: string,
  options: { focusArea?: string; allowCustomPath?: boolean } = {},
): InitVaultResult {
  const validation = validateVaultRoot(vaultRoot, { allowCustomPath: options.allowCustomPath });
  if (!validation.ok) {
    throw new Error(validation.reason || "Invalid vault root");
  }

  const paths = computeVaultPaths(vaultRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  for (const sub of [...RESEARCH_SUBDIRS, ...WIKI_SUBDIRS]) {
    fs.mkdirSync(path.join(paths.root, sub), { recursive: true });
  }

  let createdSchema = false;
  if (!fs.existsSync(paths.schema)) {
    fs.writeFileSync(paths.schema, buildSchemaMarkdown(options.focusArea || ""), "utf-8");
    createdSchema = true;
  }

  return { paths, createdSchema };
}

/** Best-effort removal of a vault directory (used by setup rollback / temp tests). */
export function removeVault(vaultRoot: string): void {
  const resolved = resolveVaultRoot(vaultRoot);
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    // non-fatal
  }
}
