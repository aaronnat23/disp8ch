import fs from "node:fs";
import path from "node:path";
import { computeVaultPaths, isInsideVault, type VaultPaths } from "./vault";

// Deterministic, reusable pipeline file operations.
//
// These back the test-run endpoint and the integration tests. They are pure file
// helpers (no model calls) so behavior like the empty-inbox gate, idempotent
// processed-move, and brief archiving can be proven without a provider. Every
// write is guarded to stay inside the vault root.

function guardWrite(paths: VaultPaths, target: string): void {
  if (!isInsideVault(paths.root, target)) {
    throw new Error(`Refusing to write outside vault root: ${target}`);
  }
}

export interface InboxPreflight {
  wakeAgent: boolean;
  count: number;
  files: string[];
}

/** List .md files in the inbox. Empty inbox => wakeAgent false (zero model calls). */
export function preflightInbox(paths: VaultPaths): InboxPreflight {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(paths.inbox);
  } catch {
    entries = [];
  }
  const files = entries.filter((name) => /\.md$/i.test(name)).sort();
  return { wakeAgent: files.length > 0, count: files.length, files };
}

export interface FindingInput {
  sourceUrl: string;
  sourceType: string;
  title: string;
  body: string;
  keyword?: string;
  capturedAt?: string;
  filename?: string;
}

/** Write a raw Scout finding into the inbox. Returns the absolute file path. */
export function writeFinding(paths: VaultPaths, input: FindingInput): string {
  const capturedAt = input.capturedAt || new Date().toISOString();
  const day = capturedAt.slice(0, 10);
  const safeKeyword = (input.keyword || input.sourceType || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const filename = input.filename || `${day}-${safeKeyword}-${Math.random().toString(36).slice(2, 8)}.md`;
  const target = path.join(paths.inbox, filename);
  guardWrite(paths, target);
  const md = [
    "---",
    `source_url: "${input.sourceUrl}"`,
    `source_type: "${input.sourceType}"`,
    `captured_at: "${capturedAt}"`,
    `keyword: "${input.keyword || ""}"`,
    `agent: "Scout"`,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.body.trim(),
    "",
  ].join("\n");
  fs.mkdirSync(paths.inbox, { recursive: true });
  fs.writeFileSync(target, md, "utf-8");
  return target;
}

export interface WikiClaim {
  text: string;
  confidence: "verified" | "likely" | "unverified" | "conflicting";
  sourceTitle: string;
  sourceUrl: string;
}

export interface WikiNoteInput {
  topic: string;
  claims: WikiClaim[];
  sources: string[];
  createdAt?: string;
  filename?: string;
}

/** Write a cited, confidence-tagged Analyst wiki note. Returns absolute path. */
export function writeWikiNote(paths: VaultPaths, input: WikiNoteInput): string {
  const createdAt = input.createdAt || new Date().toISOString();
  const slug = input.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "note";
  const filename = input.filename || `${createdAt.slice(0, 10)}-${slug}.md`;
  const target = path.join(paths.wikiSynthesis, filename);
  guardWrite(paths, target);
  const claimLines = input.claims.map(
    (c) => `- [${c.confidence}] ${c.text} Source: [${c.sourceTitle}](${c.sourceUrl})`,
  );
  const sourceLines = input.sources.map((s) => `  - "${s}"`);
  const md = [
    "---",
    `created_at: "${createdAt}"`,
    `agent: "Analyst"`,
    "sources:",
    ...sourceLines,
    `confidence: "${input.claims[0]?.confidence || "unverified"}"`,
    "---",
    "",
    `# ${input.topic}`,
    "",
    "## Claims",
    "",
    ...claimLines,
    "",
    "## Evidence",
    "",
    "## Related Notes",
    "",
    "## Open Questions",
    "",
  ].join("\n");
  fs.mkdirSync(paths.wikiSynthesis, { recursive: true });
  fs.writeFileSync(target, md, "utf-8");
  return target;
}

export interface ContradictionInput {
  slug: string;
  newClaim: string;
  priorClaim: string;
  sources: string[];
  createdAt?: string;
}

/** Write a contradiction note instead of overwriting prior wiki entries. */
export function writeContradiction(paths: VaultPaths, input: ContradictionInput): string {
  const createdAt = input.createdAt || new Date().toISOString();
  const slug = input.slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "conflict";
  const filename = `${createdAt.slice(0, 10)}-${slug}.md`;
  const target = path.join(paths.wikiContradictions, filename);
  guardWrite(paths, target);
  const md = [
    "---",
    `created_at: "${createdAt}"`,
    `agent: "Analyst"`,
    `kind: "contradiction"`,
    "---",
    "",
    `# Contradiction: ${input.slug}`,
    "",
    `- [conflicting] New: ${input.newClaim}`,
    `- [conflicting] Prior: ${input.priorClaim}`,
    "",
    "## Sources",
    "",
    ...input.sources.map((s) => `- ${s}`),
    "",
  ].join("\n");
  fs.mkdirSync(paths.wikiContradictions, { recursive: true });
  fs.writeFileSync(target, md, "utf-8");
  return target;
}

/**
 * Move processed inbox files to the processed folder. Idempotent: a file already
 * moved (missing from inbox) is skipped, not errored. Never deletes the content.
 */
export function moveProcessed(paths: VaultPaths, filenames: string[]): { moved: string[]; skipped: string[] } {
  const moved: string[] = [];
  const skipped: string[] = [];
  fs.mkdirSync(paths.processed, { recursive: true });
  for (const name of filenames) {
    const from = path.join(paths.inbox, name);
    const to = path.join(paths.processed, name);
    guardWrite(paths, to);
    if (!fs.existsSync(from)) {
      skipped.push(name);
      continue;
    }
    // Move = copy then unlink the inbox copy (the content is preserved in processed).
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
    moved.push(name);
  }
  return { moved, skipped };
}

export interface BriefInput {
  content: string;
  date?: string;
}

/** Archive a brief under wiki/briefs/YYYY-MM-DD.md. Returns absolute path. */
export function archiveBrief(paths: VaultPaths, input: BriefInput): string {
  const day = (input.date || new Date().toISOString()).slice(0, 10);
  const target = path.join(paths.wikiBriefs, `${day}.md`);
  guardWrite(paths, target);
  fs.mkdirSync(paths.wikiBriefs, { recursive: true });
  fs.writeFileSync(target, input.content, "utf-8");
  return target;
}

/** Read recent wiki synthesis notes (most recent first). */
export function readRecentWiki(paths: VaultPaths, limit = 20): Array<{ name: string; content: string }> {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(paths.wikiSynthesis).filter((n) => /\.md$/i.test(n)).sort().reverse();
  } catch {
    entries = [];
  }
  return entries.slice(0, limit).map((name) => ({
    name,
    content: fs.readFileSync(path.join(paths.wikiSynthesis, name), "utf-8"),
  }));
}

/** Convenience: resolve vault paths from a stored vault root. */
export function vaultPathsFor(vaultRoot: string): VaultPaths {
  return computeVaultPaths(vaultRoot);
}

// ── Deterministic (model-free) synthesis & briefing ──────────────────────────
//
// These let the test-run endpoint and integration tests prove the full
// Scout -> Analyst -> Briefer file flow without a model provider. The real
// scheduled workflows use the claude-agent node instead; these are the safe,
// zero-cost equivalents for verification.

function parseFinding(content: string): { sourceUrl: string; title: string; body: string } {
  const fm = content.match(/source_url\s*:\s*"?([^"\n]+)"?/i);
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const bodyStart = content.lastIndexOf("---");
  const body = bodyStart >= 0 ? content.slice(bodyStart + 3).replace(/^#.+$/m, "").trim() : content.trim();
  return {
    sourceUrl: fm ? fm[1].trim() : "",
    title: titleMatch ? titleMatch[1].trim() : "Untitled finding",
    body: body.slice(0, 600),
  };
}

export interface DeterministicSynthesisResult {
  wikiNotePath: string;
  movedFiles: string[];
  claimCount: number;
}

/**
 * Read inbox findings, write one cited [unverified] wiki note, and move the
 * processed findings. Returns the artifacts produced. Makes zero model calls.
 */
export function deterministicSynthesize(paths: VaultPaths, topic: string): DeterministicSynthesisResult | null {
  const preflight = preflightInbox(paths);
  if (!preflight.wakeAgent) return null;

  const claims: WikiClaim[] = [];
  const sources: string[] = [];
  for (const name of preflight.files) {
    const content = fs.readFileSync(path.join(paths.inbox, name), "utf-8");
    const parsed = parseFinding(content);
    claims.push({
      text: `${parsed.title} was captured from the source.`,
      confidence: "unverified",
      sourceTitle: parsed.title,
      sourceUrl: parsed.sourceUrl || `../sources/${name}`,
    });
    sources.push(`../../research/processed/${name}`);
  }

  const wikiNotePath = writeWikiNote(paths, { topic, claims, sources });
  const { moved } = moveProcessed(paths, preflight.files);
  return { wikiNotePath, movedFiles: moved, claimCount: claims.length };
}

/** Build a deterministic <=5 bullet brief from recent wiki notes. */
export function deterministicBrief(paths: VaultPaths, options: { usageLine?: string } = {}): string {
  const recent = readRecentWiki(paths, 5);
  const day = new Date().toISOString().slice(0, 10);
  const bullets: string[] = [];
  for (const note of recent.slice(0, 5)) {
    const claim = note.content.match(/^-\s*\[(verified|likely|unverified|conflicting)\]\s*(.+)$/m);
    const titleMatch = note.content.match(/^#\s+(.+)$/m);
    const tag = claim ? claim[1] : "unverified";
    const finding = titleMatch ? titleMatch[1].trim() : note.name;
    bullets.push(`- [${tag}] ${finding}. Why it matters: relevant to your focus area. Action: review the wiki note.`);
  }
  if (bullets.length === 0) {
    bullets.push("- [unverified] No new findings today. Why it matters: pipeline idle. Action: check Scout schedules.");
  }
  const usage = options.usageLine || "Usage: 0 tokens / $0.00 this run.";
  return [`# Morning Research Brief — ${day}`, "", ...bullets, "", usage, ""].join("\n");
}
