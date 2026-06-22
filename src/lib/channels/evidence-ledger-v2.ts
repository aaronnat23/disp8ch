import crypto from "node:crypto";
import { classifySourcePurpose, classifySourceUrl } from "@/lib/channels/web/source-candidate-ranker";

export type EvidenceLedgerKind =
  | "web_search_hint"
  | "web_source"
  | "browser_page"
  | "repo_file"
  | "app_state"
  | "memory"
  | "document"
  | "tool_error";

export type EvidenceConfidence = "verified" | "partial" | "inferred" | "failed";

export type EvidenceLedgerEntry = {
  id: string;
  kind: EvidenceLedgerKind;
  tool: string;
  argsHash: string;
  locator: string;
  canonicalLocator: string;
  title?: string;
  sourceDate?: string;
  fetchedAt: string;
  verified: boolean;
  confidence: EvidenceConfidence;
  excerpts: string[];
  summary: string;
  toolResultId?: string;
  metadata?: Record<string, unknown>;
};

export type CitationValidationResult = {
  ok: boolean;
  citedUrls: string[];
  unsupportedUrls: string[];
  supportedUrls: string[];
  searchIndexUrls: string[];
};

function stableHash(value: unknown): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value, Object.keys(value as Record<string, unknown> || {}).sort());
  return crypto.createHash("sha256").update(rendered || "").digest("hex").slice(0, 16);
}

function stripTrackingParams(url: URL): void {
  for (const key of Array.from(url.searchParams.keys())) {
    if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|igshid$|ref$|ref_src$)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
}

export function normalizeUrlForCitation(rawUrl: string): string {
  try {
    const cleaned = rawUrl.trim().replace(/[),.;\]]+$/g, "");
    const url = new URL(cleaned);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    stripTrackingParams(url);
    let rendered = url.toString();
    rendered = rendered.replace(/\/$/, "");
    return rendered;
  } catch {
    return rawUrl.trim().replace(/[),.;\]]+$/g, "").replace(/\/$/, "").toLowerCase();
  }
}

export function normalizeFileLocator(path: string, lineStart?: number, lineEnd?: number): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
  if (lineStart && lineEnd && lineEnd !== lineStart) return `${normalized}:${lineStart}-${lineEnd}`;
  if (lineStart) return `${normalized}:${lineStart}`;
  return normalized;
}

function extractUrls(text: string): string[] {
  return Array.from(new Set((text.match(/https?:\/\/[^\s)\]`,;"'<>]+/g) ?? []).map(normalizeUrlForCitation)));
}

function urlArgs(args: Record<string, unknown>): string[] {
  const urls = Array.isArray(args.urls)
    ? args.urls
    : typeof args.url === "string"
      ? [args.url]
      : [];
  return Array.from(new Set(
    urls
      .map((url) => typeof url === "string" ? url.trim() : "")
      .filter((url) => /^https?:\/\//i.test(url))
      .map(normalizeUrlForCitation),
  ));
}

function extractTitle(text: string): string | undefined {
  const jsonTitle = text.match(/"title"\s*:\s*"([^"]{3,180})"/i)?.[1];
  if (jsonTitle) return jsonTitle;
  const titleLine = text.match(/(?:^|\n)\s*(?:Title|title):\s*(.{3,180})/)?.[1];
  if (titleLine) return titleLine.trim();
  return undefined;
}

function extractDate(text: string): string | undefined {
  return text.match(/\b(?:20\d{2}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+20\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d{2})\b/i)?.[0];
}

function summarize(text: string, max = 360): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function excerpts(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  chunks.push(clean.slice(0, 500));
  if (clean.length > 1200) chunks.push(clean.slice(Math.max(0, clean.length - 500)));
  return chunks;
}

function repoMetadata(output: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const explicitLines = output.match(/\b(?:total_lines|lines?)["':=\s]+(\d{2,6})\b/i)?.[1];
  const numberedLines = Array.from(output.matchAll(/(?:^|\n)\s*(\d{1,6})\|/g))
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  const lineCount = explicitLines ? Number(explicitLines) : numberedLines.length > 0 ? Math.max(...numberedLines) : null;
  if (lineCount) meta.lineCount = lineCount;
  const symbols = Array.from(new Set(
    Array.from(
      output.matchAll(/\b(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g),
      (match) => match[1],
    ),
  )).slice(0, 12);
  if (symbols.length > 0) meta.symbols = symbols;
  const sizeMatch = output.match(/\b(?:file\s*size|size)["':=\s]+(\d{1,10})\s*(?:bytes?|B|KB|MB)\b/i);
  if (sizeMatch) {
    const rawSize = Number(sizeMatch[1]);
    const unit = /KB|kb/i.test(sizeMatch[0]) ? "KB" : /MB|mb/i.test(sizeMatch[0]) ? "MB" : "bytes";
    meta.fileSize = unit === "KB" ? rawSize * 1024 : unit === "MB" ? rawSize * 1024 * 1024 : rawSize;
    meta.fileSizeDisplay = sizeMatch[0].trim();
  } else {
    const charCount = output.replace(/\s+/g, " ").length;
    if (charCount > 100) meta.fileSize = charCount;
  }
  const searchMatches = output.match(/\b(?:matched|found|located|identified)\s+(\d+)\s+(?:match(?:es)?|result|occurrence|file)s?\b/i)?.[1];
  if (searchMatches) meta.matchedSearchTerms = Number(searchMatches);
  return meta;
}

type WebExtractResult = {
  url?: string;
  finalUrl?: string;
  title?: string;
  content?: string;
  text?: string;
  error?: string;
  contentType?: string;
};

function parseJsonObject(text: string): unknown {
  const clean = text.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const parsed = JSON.parse(clean) as unknown;
  if (typeof parsed === "string") {
    return JSON.parse(parsed) as unknown;
  }
  return parsed;
}

function parseTextWebExtractSections(text: string): WebExtractResult[] {
  const sections = text.split(/\n\s*---\s*\n/g).map((section) => section.trim()).filter(Boolean);
  const results: WebExtractResult[] = [];
  for (const section of sections) {
    const url = section.match(/^URL:\s*(.+)$/im)?.[1]?.trim();
    const finalUrl = section.match(/^Final URL:\s*(.+)$/im)?.[1]?.trim();
    if (!url && !finalUrl) continue;
    const title = section.match(/^Title:\s*(.*)$/im)?.[1]?.trim();
    const verifiedRaw = section.match(/^Verified:\s*(true|false)/im)?.[1]?.trim().toLowerCase();
    const error = section.match(/^Error:\s*(.+)$/im)?.[1]?.trim();
    const contentStart = section.search(/\n\s*\n/);
    const content = contentStart >= 0 ? section.slice(contentStart).trim() : section;
    results.push({
      url,
      finalUrl: finalUrl || url,
      title,
      content,
      error: error || (verifiedRaw === "false" ? "Not verified" : undefined),
    });
  }
  return results;
}

function inferKind(tool: string, output: string): EvidenceLedgerKind {
  const trimmed = output.trim();
  if (/^(?:Error:|\[Tool (?:failed|blocked|budget))/i.test(trimmed)) {
    return "tool_error";
  }
  if (tool === "web_search") return "web_search_hint";
  if (tool === "web_extract" || tool === "web_crawl" || tool === "fetch_url") return "web_source";
  if (/^browser_/i.test(tool) || tool === "browser_action") return "browser_page";
  if (/^(read_file|search_files|list_files|code_review)$/i.test(tool)) return "repo_file";
  if (/^(?:timed out|timeout|access denied|captcha|blocked|no results)\b/i.test(trimmed)) {
    return "tool_error";
  }
  if (/memory|session_recall/i.test(tool)) return "memory";
  if (/document/i.test(tool)) return "document";
  return "app_state";
}

function explicitLocator(tool: string, args: Record<string, unknown>, output: string): string {
  const direct = args.url ?? args.path ?? args.file ?? args.query ?? args.scope;
  if (typeof direct === "string" && direct.trim()) {
    if (/^https?:\/\//i.test(direct)) return normalizeUrlForCitation(direct);
    return direct.trim();
  }
  if (Array.isArray(args.urls) && typeof args.urls[0] === "string") {
    return normalizeUrlForCitation(args.urls[0]);
  }
  const url = extractUrls(output)[0];
  if (url) return url;
  const path = output.match(/\b(?:src|docs|app|lib|scripts|data)\/[A-Za-z0-9._/() -]+/)?.[0];
  return path?.trim() || tool;
}

export function createEvidenceFromToolResult(input: {
  tool: string;
  args?: Record<string, unknown>;
  output: string;
  toolResultId?: string;
  metadata?: Record<string, unknown>;
}): EvidenceLedgerEntry[] {
  const args = input.args ?? {};
  const output = String(input.output || "");
  const kind = inferKind(input.tool, output);
  const purposeByUrl = normalizePurposeByUrl(input.metadata?.purposeByUrl);
  const intendedPurpose = typeof input.metadata?.intendedSourcePurpose === "string"
    ? input.metadata.intendedSourcePurpose
    : undefined;
  const purposeForUrl = (url: string, body?: string): string => {
    const normalized = normalizeUrlForCitation(url);
    return purposeByUrl.get(normalized) ?? intendedPurpose ?? classifySourcePurpose(normalized, body);
  };
  if ((input.tool === "web_extract" || input.tool === "web_crawl") && kind === "web_source") {
    const mapWebExtractResults = (results: WebExtractResult[]): EvidenceLedgerEntry[] => {
      const now = new Date().toISOString();
      return results
        .filter((result) => typeof (result.finalUrl || result.url) === "string")
        .slice(0, 12)
        .map((result, index) => {
          const locator = normalizeUrlForCitation(String(result.finalUrl || result.url));
          const sourceClass = classifySourceUrl(locator);
          const isSearchIndex = sourceClass.sourceKind === "search_index";
          const body = [result.title, result.content || result.text, result.error].filter(Boolean).join("\n");
          const verified = !result.error && !isSearchIndex;
          const sourcePurpose = purposeForUrl(locator, body);
          return {
            id: `ev_${stableHash(`${input.tool}:${locator}:${index}:${body.slice(0, 240)}`)}`,
            kind,
            tool: input.tool,
            argsHash: stableHash(args),
            locator,
            canonicalLocator: locator,
            title: result.title?.trim() || extractTitle(body),
            sourceDate: extractDate(body),
            fetchedAt: now,
            verified,
            confidence: result.error ? "failed" : verified ? "verified" : "partial",
            excerpts: excerpts(body),
            summary: summarize(body),
            toolResultId: input.toolResultId,
            metadata: {
              sourceKind: sourceClass.sourceKind,
              sourcePurpose,
              sourceRank: sourceClass.rank,
              sourceReason: sourceClass.reason,
              ...(result.contentType ? { contentType: result.contentType } : {}),
              ...(input.metadata ?? {}),
            },
          };
        });
    };
    try {
      const parsed = parseJsonObject(output) as { results?: WebExtractResult[] };
      if (Array.isArray(parsed.results) && parsed.results.length > 0) {
        return mapWebExtractResults(parsed.results);
      }
    } catch {
      // Fall through to the generic parser for plain-text tool output.
    }
    const textResults = parseTextWebExtractSections(output);
    if (textResults.length > 0) {
      return mapWebExtractResults(textResults);
    }
  }
  const urls = kind === "web_source" || kind === "browser_page" || kind === "web_search_hint"
    ? extractUrls(output)
    : [];
  const argUrls = urlArgs(args);
  const locators = kind === "web_source"
    ? (argUrls.length > 0 ? argUrls.slice(0, 8) : urls.length > 0 ? urls.slice(0, 8) : [explicitLocator(input.tool, args, output)])
    : [explicitLocator(input.tool, args, output)];
  const now = new Date().toISOString();
  return locators.map((locator, index) => {
    const canonicalLocator = /^https?:\/\//i.test(locator) ? normalizeUrlForCitation(locator) : normalizeFileLocator(locator);
    const sourceClass = /^https?:\/\//i.test(canonicalLocator) ? classifySourceUrl(canonicalLocator) : null;
    const isSearchIndex = sourceClass?.sourceKind === "search_index";
    const verified = kind !== "web_search_hint" && kind !== "tool_error" && !isSearchIndex;
    const sourcePurpose = /^https?:\/\//i.test(canonicalLocator)
      ? purposeForUrl(canonicalLocator, output)
      : "generic";
    return {
      id: `ev_${stableHash(`${input.tool}:${canonicalLocator}:${index}:${output.slice(0, 240)}`)}`,
      kind,
      tool: input.tool,
      argsHash: stableHash(args),
      locator,
      canonicalLocator,
      title: extractTitle(output),
      sourceDate: extractDate(output),
      fetchedAt: now,
      verified,
      confidence: kind === "tool_error" ? "failed" : verified ? "verified" : "partial",
      excerpts: excerpts(output),
      summary: summarize(output),
      toolResultId: input.toolResultId,
      metadata: {
        ...(sourceClass ? { sourceKind: sourceClass.sourceKind, sourceRank: sourceClass.rank, sourceReason: sourceClass.reason } : {}),
        sourcePurpose,
        ...(kind === "repo_file" ? repoMetadata(output) : {}),
        ...(input.metadata ?? {}),
      },
    };
  });
}

function normalizePurposeByUrl(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object") return out;
  for (const [url, purpose] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof purpose !== "string") continue;
    out.set(normalizeUrlForCitation(url), purpose);
  }
  return out;
}

export function formatEvidencePackForModel(entries: EvidenceLedgerEntry[], opts: { maxEntries?: number; maxExcerptChars?: number } = {}): string {
  const maxEntries = opts.maxEntries ?? 18;
  const maxExcerptChars = opts.maxExcerptChars ?? 700;
  if (!Array.isArray(entries)) return "";
  const filtered = entries.slice(0, maxEntries).filter((e): e is EvidenceLedgerEntry => e != null && typeof e === "object");
  if (filtered.length === 0) return "";
  const lines = filtered.map((entry, index) => {
    const citationRule = entry.kind === "web_search_hint"
      ? "hint-only; do not cite"
      : entry.verified
        ? "verified"
        : entry.confidence ?? "candidate";
    const title = entry.title ? ` title="${String(entry.title).slice(0, 120)}"` : "";
    const fetchedAtSafe = typeof entry.fetchedAt === "string" ? entry.fetchedAt.slice(0, 10) : "unknown";
    const date = entry.sourceDate ? ` date=${entry.sourceDate}` : ` date=unknown retrieved=${fetchedAtSafe}`;
    const sourceKind = typeof entry.metadata?.sourceKind === "string" ? ` sourceKind=${entry.metadata.sourceKind}` : "";
    const repoMeta = entry.kind === "repo_file"
      ? [
          typeof entry.metadata?.lineCount === "number" ? ` lines=${entry.metadata.lineCount}` : "",
          Array.isArray(entry.metadata?.symbols) && entry.metadata.symbols.length > 0 ? ` symbols=${entry.metadata.symbols.slice(0, 8).join(",")}` : "",
        ].join("")
      : "";
    const excerptsArr = Array.isArray(entry.excerpts) ? entry.excerpts : [];
    const excerptSource = String(excerptsArr[0] ?? entry.summary ?? "");
    const excerpt = excerptSource.slice(0, maxExcerptChars);
    return [
      `${index + 1}. id=${entry.id ?? ""} kind=${entry.kind ?? "unknown"}${sourceKind}${repoMeta} confidence=${citationRule} locator=${entry.canonicalLocator ?? ""}${title}${date}`,
      `   summary: ${entry.summary ?? ""}`,
      excerpt ? `   excerpt: ${excerpt}` : "",
    ].filter(Boolean).join("\n");
  });
  return [
    "Verified evidence pack:",
    ...lines,
    "",
    "Citation rules: cite only entries marked verified web_source/browser_page/document/repo_file. web_search_hint entries are discovery hints only.",
  ].join("\n");
}

export { classifySourcePurpose };

function isExampleUrl(url: string): boolean {
  // Exclude URLs that are clearly example commands (localhost, loopback, example.com/org)
  // rather than real citations, so they don't trigger fake_source_citation.
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|example\.(?:com|org|net))(?::\d+)?(?:\/|$)/i.test(url);
}

export function validateCitations(answer: string, entries: EvidenceLedgerEntry[]): CitationValidationResult {
  const citedUrls = extractUrls(answer).filter((url) => !isExampleUrl(url));
  const searchIndexUrls = citedUrls.filter((url) => classifySourceUrl(url).sourceKind === "search_index");
  const supportedCanonicals = new Set(
    entries
      .filter((entry) => entry.verified && (entry.kind === "web_source" || entry.kind === "browser_page" || entry.kind === "document"))
      .filter((entry) => entry.metadata?.sourceKind !== "search_index")
      .map((entry) => normalizeUrlForCitation(entry.canonicalLocator)),
  );
  const supportedUrls: string[] = [];
  const unsupportedUrls: string[] = [];
  for (const url of citedUrls) {
    const canonical = normalizeUrlForCitation(url);
    if (supportedCanonicals.has(canonical)) {
      supportedUrls.push(url);
      continue;
    }
    const fuzzy = Array.from(supportedCanonicals).some((source) => canonical.startsWith(`${source}/`) || source.startsWith(`${canonical}/`));
    if (fuzzy) supportedUrls.push(url);
    else unsupportedUrls.push(url);
  }
  for (const url of searchIndexUrls) {
    if (!unsupportedUrls.includes(url)) unsupportedUrls.push(url);
  }
  return { ok: unsupportedUrls.length === 0, citedUrls, unsupportedUrls, supportedUrls, searchIndexUrls };
}
