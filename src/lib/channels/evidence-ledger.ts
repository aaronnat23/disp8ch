import {
  createEvidenceFromToolResult,
  formatEvidencePackForModel,
  type EvidenceLedgerEntry,
} from "@/lib/channels/evidence-ledger-v2";

export type EvidenceKind = "web_search_hint" | "web_fetch" | "browser_page" | "repo_file" | "memory" | "document" | "app_state" | "tool_error";

export type EvidenceItem = {
  kind: EvidenceKind;
  title: string;
  locator: string;
  summary: string;
  confidence: "verified" | "partial" | "inferred";
  ledgerEntry?: EvidenceLedgerEntry;
};

function inferKind(toolName: string, output: string): EvidenceKind {
  if (toolName === "web_search") return "web_search_hint";
  if (toolName === "fetch_url") return "web_fetch";
  if (toolName === "browser_action") return "browser_page";
  if (/file|code_review|search_files|list_files/i.test(toolName)) return "repo_file";
  if (/memory|session_recall/i.test(toolName)) return "memory";
  if (/document/i.test(toolName)) return "document";
  if (/error|failed|timed out/i.test(output)) return "tool_error";
  return "app_state";
}

function extractLocator(toolName: string, kind: EvidenceKind, args: Record<string, unknown>, output: string): string {
  const explicit = args.url ?? args.path ?? args.file ?? args.query ?? args.scope;
  if (typeof explicit === "string" && explicit.trim()) {
    const value = explicit.trim();
    if (kind === "web_fetch") return `web_fetch:${value}`;
    if (kind === "browser_page") return `browser:${value}`;
    if (kind === "web_search_hint") return `web_search:${value}`;
    if (kind === "repo_file") return `repo:${value}`;
    return value;
  }
  const url = output.match(/https?:\/\/[^\s)\]]+/)?.[0];
  if (url) {
    if (kind === "web_fetch") return `web_fetch:${url}`;
    if (kind === "browser_page") return `browser:${url}`;
    if (kind === "web_search_hint") return `web_search:${url}`;
    return url;
  }
  const path = output.match(/\b(?:src|docs|app|lib|scripts|data)\/[A-Za-z0-9._/() -]+/)?.[0];
  if (path) return kind === "repo_file" ? `repo:${path.trim()}` : path.trim();
  return toolName;
}

export function createEvidenceItem(toolName: string, args: Record<string, unknown>, output: string): EvidenceItem {
  const ledgerEntry = createEvidenceFromToolResult({ tool: toolName, args, output })[0];
  if (ledgerEntry) {
    return {
      kind: ledgerEntry.kind === "web_source" ? "web_fetch" : ledgerEntry.kind as EvidenceKind,
      title: ledgerEntry.title || toolName,
      locator: ledgerEntry.canonicalLocator,
      summary: ledgerEntry.summary,
      confidence: ledgerEntry.confidence === "failed" ? "partial" : ledgerEntry.confidence,
      ledgerEntry,
    };
  }
  const text = String(output || "").replace(/\s+/g, " ").trim();
  const kind = inferKind(toolName, text);
  return {
    kind,
    title: toolName,
    locator: extractLocator(toolName, kind, args, text),
    summary: text.slice(0, 240),
    confidence: kind === "tool_error" || kind === "web_search_hint" ? "partial" : "verified",
  };
}

export function formatEvidenceLedger(items: EvidenceItem[], maxItems = 12): string {
  if (!items.length) return "";
  const ledgerEntries = items.map((item) => item.ledgerEntry).filter(Boolean) as EvidenceLedgerEntry[];
  if (ledgerEntries.length > 0) {
    return formatEvidencePackForModel(ledgerEntries, { maxEntries: maxItems });
  }
  const seen = new Set<string>();
  const lines = items
    .filter((item) => {
      const key = `${item.kind}:${item.locator}:${item.summary.slice(0, 80)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems)
    .map((item, index) => `${index + 1}. [${item.kind}/${item.confidence}] ${item.locator}: ${item.summary}`);
  return `Evidence ledger from actual tool results:\n${lines.join("\n")}`;
}
