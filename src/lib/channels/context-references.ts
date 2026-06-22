/**
 * Context References — parse and expand @file, @folder, @diff, @staged,
 * @git:N, and @url
 * references in incoming chat messages.
 *
 * When a user types `@file:src/main.ts what does this do?`, the reference is
 * expanded inline so the agent receives the file content as context.
 *
 * Supported syntax:
 *   @file:path/to/file           — inject full file content
 *   @file:path/to/file:10-20     — inject lines 10–20 only
 *   @folder:path/to/dir          — inject directory listing
 *   @diff                        — inject `git diff` output
 *   @diff:staged                 — inject `git diff --staged`
 *   @staged                      — inject `git diff --staged`
 *   @git:3                       — inject `git log -3 -p`
 *   @url:https://example.com     — fetch URL and inject text content
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { estimateContextTokens } from "@/lib/agents/context/compaction";
import { getModelContextWindow } from "@/lib/agents/context-windows";
import { getModelConfig } from "@/lib/agents/model-router";
import { extractTitleFromHtml, htmlToText, limitText } from "@/lib/documents/store";
import { assertAllowedWebsiteUrl } from "@/lib/security/website-policy";
import { logger } from "@/lib/utils/logger";

const log = logger.child("context-references");

/* ── Types ──────────────────────────────────────────────────────────────── */

export type ContextReference = {
  type: "file" | "folder" | "diff" | "staged" | "git" | "url";
  raw: string;           // the full matched token, e.g. "@file:src/main.ts:10-20"
  target: string;        // path, URL, or "staged" for diff
  lineStart?: number;
  lineEnd?: number;
  start?: number;
  end?: number;
};

export type ExpandedReference = ContextReference & {
  content: string;
  truncated: boolean;
  error?: string;
};

export type ContextReferenceResult = {
  expandedMessage: string;
  references: ExpandedReference[];
  totalCharsInjected: number;
  warnings: string[];
};

/* ── Constants ──────────────────────────────────────────────────────────── */

/** Hard limit: max chars injected from all references combined */
const MAX_TOTAL_INJECT_CHARS = 100_000;

/** Per-reference limit */
const MAX_PER_REF_CHARS = 50_000;

/** Max directory entries to list */
const MAX_DIR_ENTRIES = 200;
const SOFT_CONTEXT_RATIO = 0.25;
const HARD_CONTEXT_RATIO = 0.5;

/* ── Regex ──────────────────────────────────────────────────────────────── */

const REF_PATTERN = /(?:^|\s)(@(?:file|folder|diff|staged|git|url):?[^\s]*)/g;
const TRAILING_PUNCTUATION = ",.;:!?";

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Parse context references from a message string.
 */
export function parseContextReferences(message: string): ContextReference[] {
  const refs: ContextReference[] = [];
  const seen = new Set<string>();

  for (const match of message.matchAll(REF_PATTERN)) {
    const matchedText = match[1]?.trim();
    if (!matchedText) continue;
    const raw = stripTrailingPunctuation(matchedText);
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);

    const parsed = parseOneReference(raw);
    if (parsed) {
      const matchText = match[0] ?? "";
      const tokenOffset = matchText.lastIndexOf(matchedText);
      const tokenStart = (match.index ?? 0) + Math.max(0, tokenOffset);
      parsed.start = tokenStart;
      parsed.end = tokenStart + raw.length;
      refs.push(parsed);
    }
  }

  return refs;
}

/**
 * Expand context references in a message, injecting content inline.
 * Returns the modified message with references replaced by their content,
 * plus metadata about what was injected.
 */
export async function expandContextReferences(
  message: string,
  cwd?: string,
): Promise<ContextReferenceResult> {
  const refs = parseContextReferences(message);
  if (refs.length === 0) {
    return { expandedMessage: message, references: [], totalCharsInjected: 0, warnings: [] };
  }

  const workingDir = cwd || process.env.WORKSPACE_ROOT || process.cwd();
  let totalInjected = 0;
  const expanded: ExpandedReference[] = [];
  const warnings: string[] = [];
  const blocks: string[] = [];

  for (const ref of refs) {
    const remaining = MAX_TOTAL_INJECT_CHARS - totalInjected;
    if (remaining <= 0) {
      const limitedRef = { ...ref, content: "", truncated: true, error: "Total injection limit reached" };
      expanded.push(limitedRef);
      warnings.push(`${ref.raw}: total injection limit reached`);
      continue;
    }

    const limit = Math.min(MAX_PER_REF_CHARS, remaining);
    const expandedRef = await expandOneReference(ref, workingDir, limit);
    expanded.push(expandedRef);
    totalInjected += expandedRef.content.length;

    if (expandedRef.content) {
      blocks.push(buildContextBlock(ref, expandedRef));
    }
    if (expandedRef.error) {
      warnings.push(`${ref.raw}: ${expandedRef.error}`);
    }
  }

  const injectedTokens = estimateContextTokens(blocks);
  const contextWindow = resolveContextWindow();
  const hardLimit = Math.max(1, Math.floor(contextWindow * HARD_CONTEXT_RATIO));
  const softLimit = Math.max(1, Math.floor(contextWindow * SOFT_CONTEXT_RATIO));
  if (injectedTokens > hardLimit) {
    warnings.push(`context injection refused: ${injectedTokens} tokens exceeds the 50% hard limit (${hardLimit})`);
    return {
      expandedMessage: message,
      references: expanded,
      totalCharsInjected: totalInjected,
      warnings,
    };
  }
  if (injectedTokens > softLimit) {
    warnings.push(`context injection warning: ${injectedTokens} tokens exceeds the 25% soft limit (${softLimit})`);
  }

  const strippedMessage = removeReferenceTokens(message, refs);
  let result = strippedMessage;
  if (warnings.length > 0) {
    result += `${result ? "\n\n" : ""}--- Context Warnings ---\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
  }
  if (blocks.length > 0) {
    result += `${result ? "\n\n" : ""}--- Attached Context ---\n\n${blocks.join("\n\n")}`;
  }

  return {
    expandedMessage: result.trim(),
    references: expanded,
    totalCharsInjected: totalInjected,
    warnings,
  };
}

/* ── Parsers ────────────────────────────────────────────────────────────── */

function parseOneReference(raw: string): ContextReference | null {
  // @file:path/to/file:10-20
  const fileMatch = raw.match(/^@file:(.+?)(?::(\d+)-(\d+))?$/);
  if (fileMatch) {
    return {
      type: "file",
      raw,
      target: fileMatch[1] ?? "",
      lineStart: fileMatch[2] ? parseInt(fileMatch[2], 10) : undefined,
      lineEnd: fileMatch[3] ? parseInt(fileMatch[3], 10) : undefined,
    };
  }

  // @folder:path/to/dir
  const folderMatch = raw.match(/^@folder:(.+)$/);
  if (folderMatch) {
    return { type: "folder", raw, target: folderMatch[1] ?? "" };
  }

  // @diff or @diff:staged
  const diffMatch = raw.match(/^@diff(?::(.+))?$/);
  if (diffMatch) {
    return { type: "diff", raw, target: diffMatch[1] ?? "" };
  }

  // @staged
  if (raw === "@staged") {
    return { type: "staged", raw, target: "staged" };
  }

  // @git:3
  const gitMatch = raw.match(/^@git:(\d+)$/);
  if (gitMatch) {
    return { type: "git", raw, target: gitMatch[1] ?? "1" };
  }

  // @url:https://example.com
  const urlMatch = raw.match(/^@url:(https?:\/\/.+)$/);
  if (urlMatch) {
    return { type: "url", raw, target: urlMatch[1] ?? "" };
  }

  return null;
}

/* ── Expanders ──────────────────────────────────────────────────────────── */

async function expandOneReference(
  ref: ContextReference,
  cwd: string,
  charLimit: number,
): Promise<ExpandedReference> {
  try {
    switch (ref.type) {
      case "file":
        return expandFile(ref, cwd, charLimit);
      case "folder":
        return expandFolder(ref, cwd, charLimit);
      case "diff":
        return expandDiff(ref, cwd, charLimit);
      case "staged":
        return expandGitCommand(ref, cwd, ["diff", "--staged"], charLimit);
      case "git":
        return expandGitLog(ref, cwd, charLimit);
      case "url":
        return await expandUrl(ref, charLimit);
      default:
        return { ...ref, content: "", truncated: false, error: `Unknown ref type: ${ref.type}` };
    }
  } catch (err) {
    log.error("Context ref expansion failed", { ref: ref.raw, error: String(err) });
    return { ...ref, content: "", truncated: false, error: String(err) };
  }
}

function expandFile(ref: ContextReference, cwd: string, charLimit: number): ExpandedReference {
  const filePath = path.resolve(cwd, ref.target);

  // Security: validate within workspace
  const root = process.env.WORKSPACE_ROOT;
  if (root) {
    const normalizedRoot = path.resolve(root) + path.sep;
    const normalizedPath = path.resolve(filePath);
    if (normalizedPath !== path.resolve(root) && !normalizedPath.startsWith(normalizedRoot)) {
      return { ...ref, content: "", truncated: false, error: `Path outside workspace: ${ref.target}` };
    }
  }

  if (!fs.existsSync(filePath)) {
    return { ...ref, content: "", truncated: false, error: `File not found: ${ref.target}` };
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return { ...ref, content: "", truncated: false, error: `Not a file: ${ref.target}` };
  }

  let content = fs.readFileSync(filePath, "utf-8");

  // Line range
  if (ref.lineStart !== undefined && ref.lineEnd !== undefined) {
    const lines = content.split("\n");
    const start = Math.max(1, ref.lineStart) - 1;
    const end = Math.min(lines.length, ref.lineEnd);
    content = lines.slice(start, end).join("\n");
  }

  const truncated = content.length > charLimit;
  if (truncated) {
    content = content.slice(0, charLimit) + "\n[...truncated]";
  }

  return { ...ref, content, truncated };
}

function expandFolder(ref: ContextReference, cwd: string, charLimit: number): ExpandedReference {
  const dirPath = path.resolve(cwd, ref.target);

  // Security: validate within workspace
  const root = process.env.WORKSPACE_ROOT;
  if (root) {
    const normalizedRoot = path.resolve(root) + path.sep;
    const normalizedPath = path.resolve(dirPath);
    if (normalizedPath !== path.resolve(root) && !normalizedPath.startsWith(normalizedRoot)) {
      return { ...ref, content: "", truncated: false, error: `Path outside workspace: ${ref.target}` };
    }
  }

  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return { ...ref, content: "", truncated: false, error: `Directory not found: ${ref.target}` };
  }

  const entries = fs.readdirSync(dirPath).slice(0, MAX_DIR_ENTRIES);
  const lines = entries.map((entry) => {
    try {
      const fullPath = path.join(dirPath, entry);
      return fs.statSync(fullPath).isDirectory() ? `[DIR] ${entry}` : entry;
    } catch {
      return entry;
    }
  });

  let content = lines.join("\n");
  const truncated = content.length > charLimit;
  if (truncated) {
    content = content.slice(0, charLimit) + "\n[...truncated]";
  }

  return { ...ref, content, truncated };
}

function expandDiff(ref: ContextReference, cwd: string, charLimit: number): ExpandedReference {
  const args = ref.target === "staged" ? ["diff", "--staged"] : ["diff"];
  return expandGitCommand(ref, cwd, args, charLimit);
}

function expandGitLog(ref: ContextReference, cwd: string, charLimit: number): ExpandedReference {
  const count = Math.max(1, Math.min(Number(ref.target) || 1, 10));
  return expandGitCommand(ref, cwd, ["log", `-${count}`, "-p"], charLimit);
}

function expandGitCommand(
  ref: ContextReference,
  cwd: string,
  args: string[],
  charLimit: number,
): ExpandedReference {
  try {
    const output = execFileSync("git", args, {
      cwd,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
      windowsHide: true,
    });

    let content = output.trim();
    if (!content) {
      return { ...ref, content: "(no changes)", truncated: false };
    }

    const truncated = content.length > charLimit;
    if (truncated) {
      content = content.slice(0, charLimit) + "\n[...truncated]";
    }

    return { ...ref, content, truncated };
  } catch (err) {
    return { ...ref, content: "", truncated: false, error: `git command failed: ${String(err)}` };
  }
}

async function expandUrl(ref: ContextReference, charLimit: number): Promise<ExpandedReference> {
  try {
    const url = assertAllowedWebsiteUrl(ref.target, "context reference");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "disp8ch-context-reference-fetcher/1.0",
        "Accept": "text/plain,text/html,application/json,text/markdown,*/*;q=0.1",
      },
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      return { ...ref, content: "", truncated: false, error: `URL fetch failed: HTTP ${response.status}` };
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const rawText = await response.text();
    let content = "";
    if (contentType.includes("text/html")) {
      const title = extractTitleFromHtml(rawText);
      const body = htmlToText(rawText);
      content = title ? `Title: ${title}\n\n${body}` : body;
    } else if (contentType.includes("application/json")) {
      try {
        content = JSON.stringify(JSON.parse(rawText), null, 2);
      } catch {
        content = rawText.trim();
      }
    } else {
      content = rawText.trim();
    }

    if (!content) {
      content = "(empty response body)";
    }

    content = limitText(content);
    const truncated = content.length > charLimit;
    if (truncated) {
      content = content.slice(0, charLimit) + "\n[...truncated]";
    }

    return { ...ref, content, truncated };
  } catch (err) {
    return { ...ref, content: "", truncated: false, error: `URL fetch failed: ${String(err)}` };
  }
}

function buildContextBlock(ref: ContextReference, expandedRef: ExpandedReference): string {
  const label = ref.type === "file" || ref.type === "folder" || ref.type === "url"
    ? `${ref.type}:${ref.target}`
    : ref.type === "staged"
      ? "staged"
      : ref.type === "git"
        ? `git:${ref.target}`
        : "diff";
  return `<context ref="${label}"${expandedRef.truncated ? " truncated" : ""}>\n${expandedRef.content}\n</context>`;
}

function stripTrailingPunctuation(value: string): string {
  let stripped = value.trim().replace(new RegExp(`[${escapeRegExp(TRAILING_PUNCTUATION)}]+$`), "");
  while (stripped.endsWith(")") || stripped.endsWith("]") || stripped.endsWith("}")) {
    const closer = stripped[stripped.length - 1];
    const opener = closer === ")" ? "(" : closer === "]" ? "[" : "{";
    const closers = stripped.split(closer).length - 1;
    const openers = stripped.split(opener).length - 1;
    if (closers > openers) {
      stripped = stripped.slice(0, -1);
      continue;
    }
    break;
  }
  return stripped;
}

function removeReferenceTokens(message: string, refs: ContextReference[]): string {
  const sorted = refs
    .filter((ref): ref is ContextReference & { start: number; end: number } => typeof ref.start === "number" && typeof ref.end === "number")
    .sort((a, b) => a.start - b.start);

  if (sorted.length === 0) {
    return message.trim();
  }

  const pieces: string[] = [];
  let cursor = 0;
  for (const ref of sorted) {
    pieces.push(message.slice(cursor, ref.start));
    cursor = ref.end;
  }
  pieces.push(message.slice(cursor));

  return pieces
    .join("")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveContextWindow(): number {
  try {
    const envWindow = Number(process.env.DISP8CH_CONTEXT_REF_CONTEXT_WINDOW || "");
    if (Number.isFinite(envWindow) && envWindow > 0) {
      return Math.floor(envWindow);
    }

    try {
      const { getSqlite } = require("@/lib/db") as { getSqlite: () => import("better-sqlite3").Database };
      const db = getSqlite();
      const row = db.prepare("SELECT context_window FROM app_config WHERE id = 'default'").get() as { context_window?: number } | undefined;
      if (row?.context_window && row.context_window > 0) {
        return row.context_window;
      }
    } catch {
      // Fall back to model-derived defaults when config is unavailable.
    }

    const model = getModelConfig();
    return getModelContextWindow(model.modelId) ?? 200_000;
  } catch {
    return 200_000;
  }
}
