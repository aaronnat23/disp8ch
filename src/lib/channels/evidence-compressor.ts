import type { EvidenceItem } from "@/lib/channels/evidence-ledger";

const DEFAULT_COMPRESSED_CHARS = 9000;
const MAX_PER_ITEM = 1200;

type CompressedEntry = {
  kind: string;
  locator: string;
  metadata: string;
  summary: string;
  confidence: string;
};

function extractStructuredMetadata(item: EvidenceItem): string {
  const entry = item.ledgerEntry;
  const parts: string[] = [];
  if (entry?.kind === "repo_file" || item.kind === "repo_file") {
    const text = [entry?.summary, ...(entry?.excerpts ?? []), item.summary].filter(Boolean).join("\n");
    const explicitLines = text.match(/\b(?:total_lines|lines?)["':=\s]+(\d{2,6})\b/i)?.[1];
    const numberedLines = Array.from(text.matchAll(/(?:^|\n)\s*(\d{1,6})\|/g)).map((m) => Number(m[1])).filter(Number.isFinite);
    const lineCount = explicitLines ? Number(explicitLines) : numberedLines.length > 0 ? Math.max(...numberedLines) : null;
    if (lineCount) parts.push(`${lineCount} lines`);
    const symbols = Array.from(new Set(Array.from(text.matchAll(/\b(?:function|class|const|let|var|export function|export const|export class)\s+([A-Za-z_$][\w$]*)/g), (m) => m[1]))).slice(0, 8);
    if (symbols.length > 0) parts.push(`symbols: ${symbols.join(", ")}`);
    if (entry?.metadata?.lineCount && typeof entry.metadata.lineCount === "number" && !lineCount) {
      parts.push(`${entry.metadata.lineCount} lines`);
    }
    if (Array.isArray(entry?.metadata?.symbols) && entry.metadata.symbols.length > 0 && symbols.length === 0) {
      parts.push(`symbols: ${entry.metadata.symbols.slice(0, 8).join(", ")}`);
    }
    if (typeof entry?.metadata?.fileSize === "number") {
      const kb = Math.round(entry.metadata.fileSize / 1024);
      parts.push(kb > 0 ? `${kb}KB` : `${entry.metadata.fileSize}B`);
    }
    if (typeof entry?.metadata?.matchedSearchTerms === "number") {
      parts.push(`${entry.metadata.matchedSearchTerms} search matches`);
    }
  }
  if (entry?.sourceDate) parts.push(`date: ${entry.sourceDate}`);
  if (typeof entry?.metadata?.sourceKind === "string") parts.push(`sourceKind: ${entry.metadata.sourceKind}`);
  if (typeof entry?.metadata?.sourcePurpose === "string" && entry.metadata.sourcePurpose !== "generic") {
    parts.push(`purpose: ${entry.metadata.sourcePurpose}`);
  }
  if (entry?.kind === "tool_error") {
    parts.push(`error: ${item.summary.slice(0, 100)}`);
  }
  if (entry?.kind === "web_search_hint") {
    parts.push("search hint; do not cite as verified source");
  }
  return parts.join("; ");
}

export function compressEvidence(items: EvidenceItem[], maxChars = DEFAULT_COMPRESSED_CHARS): string {
  if (!Array.isArray(items) || items.length === 0) return "";

  const seen = new Set<string>();
  const deduped = items.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const summarySafe = String(item.summary ?? "");
    const key = `${item.kind ?? "unknown"}:${item.locator ?? ""}:${summarySafe.slice(0, 60)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const compressed: CompressedEntry[] = deduped.map((item) => ({
    kind: item.kind ?? "unknown",
    locator: String(item.locator ?? "").slice(0, 120),
    metadata: extractStructuredMetadata(item),
    summary: String(item.summary ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PER_ITEM),
    confidence: item.confidence ?? "candidate",
  }));

  const errors = compressed.filter((entry) => entry.kind === "tool_error");
  const facts = compressed.filter((entry) => entry.kind !== "tool_error");

  const lines: string[] = ["Compressed evidence from tool results:"];
  let chars = lines[0].length;

  for (const entry of facts) {
    const meta = entry.metadata ? ` (${entry.metadata})` : "";
    const line = `[${entry.kind}/${entry.confidence}] ${entry.locator}${meta}: ${entry.summary}`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length;
  }

  if (errors.length > 0) {
    lines.push(`Unavailable evidence (${errors.length} tool errors): ${errors.map((e) => e.locator).join(", ")}`);
  }

  return lines.join("\n");
}

export function buildFinalSynthesisPrompt(opts: {
  originalMessage: string;
  compressedEvidence: string;
  unmetNeeds?: string[];
  mode: "balanced" | "thorough";
}): string {
  const parts = [
    `Original request: ${opts.originalMessage}`,
    "",
    opts.compressedEvidence,
    "",
    "Task: Write the best possible final answer using only the evidence above.",
    "Rules:",
    "- Answer the user's actual question.",
    "- Cite real file paths, URLs, or source labels from the evidence.",
    "- When metadata includes line counts, symbols, source dates, file sizes, or source purposes, use those details in the answer where relevant. For repo files with line counts: mention the file and the line count (e.g., 'foo.ts (2455 lines)'). For repo files with symbols: reference the key exported functions or classes.",
    "- Separate verified facts from inference.",
    "- Do not invent citations not present in the evidence.",
    "- For repo answers, search/list evidence can identify candidate files, but behavior claims require read_file evidence. If a file was not read, say it is a candidate instead of claiming what it does.",
  ];

  const repoFocused = /\b(?:src\/|app\/|lib\/|repo|codebase|component|route|implementation|latency|render|stream|workflow)\b/i.test(opts.originalMessage + "\n" + opts.compressedEvidence);
  if (repoFocused) {
    parts.push("- For repo inspection, separate observed facts from recommendations.");
    parts.push("- Include concrete files read, current behavior inferred from those files, likely bottlenecks/failure modes, implementation steps, tests, and risks when the user asks for depth or improvements.");
    parts.push("- Do not use words like verified, confirmed, or implemented unless the claim is backed by read_file evidence in the evidence block.");
  }

  if (opts.unmetNeeds && opts.unmetNeeds.length > 0) {
    parts.push(`- State that these evidence needs could not be satisfied: ${opts.unmetNeeds.join(", ")}.`);
  }

  if (opts.mode === "thorough") {
    parts.push("- For comparison or analysis, structure the answer with clear sections.");
    parts.push("- Include concrete next steps where appropriate.");
  }

  parts.push("- Do not output tool-call syntax. Write normal user-facing text.");

  return parts.join("\n");
}
