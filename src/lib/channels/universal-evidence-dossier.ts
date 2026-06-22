/**
 * Durable evidence dossier for the universal agentic runtime.
 *
 * The dossier is the structured record of every tool result, its kind
 * (repo / web / app_state / runtime / memory / document / execution /
 * design / unknown), and the structured claims/limitations each call
 * produced. It replaces the lossy "last 12 previews" critic view with
 * a structured, summarizable record the critic and synthesizer can
 * inspect to evaluate grounding, source quality, and coverage.
 */

export type EvidenceKind =
  | "repo"
  | "web"
  | "app_state"
  | "runtime"
  | "memory"
  | "document"
  | "execution"
  | "design"
  | "unknown";

export type EvidenceItem = {
  id: string;
  kind: EvidenceKind;
  toolName: string;
  ok: boolean;
  title?: string;
  sourceUrl?: string;
  filePath?: string;
  lineRefs?: string[];
  retrievedAt: string;
  queryOrArgsSummary: string;
  claims: string[];
  limitations: string[];
  rawPreview: string;
  recoveredFromFailure?: boolean;
};

export type EvidenceDossierSource = {
  label: string;
  url?: string;
  filePath?: string;
  lineRefs?: string[];
};

export type EvidenceDossierToolFailure = {
  toolName: string;
  summary: string;
  recovered: boolean;
  recoveredByTool?: string;
};

export type UniversalEvidenceDossier = {
  request: string;
  planId?: string;
  items: EvidenceItem[];
  coverage: Record<EvidenceKind, number>;
  sourceMap: EvidenceDossierSource[];
  contradictions: string[];
  unknowns: string[];
  toolFailures: EvidenceDossierToolFailure[];
};

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bAIza[0-9A-Za-z_-]{12,}\b/g,
  /\bghp_[A-Za-z0-9]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
  /\bDEEPSEEK_API_KEY\s*=\s*[^\s]+/gi,
];

const ALL_KINDS: EvidenceKind[] = [
  "repo",
  "web",
  "app_state",
  "runtime",
  "memory",
  "document",
  "execution",
  "design",
  "unknown",
];

const REPO_TOOLS = new Set([
  "search_files",
  "read_file",
  "list_files",
  "code_review",
]);

const WEB_TOOLS = new Set([
  "web_search",
  "web_extract",
  "web_crawl",
  "fetch_url",
]);

const BROWSER_TOOLS = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_get_text",
  "browser_get_links",
  "browser_get_images",
  "browser_vision",
  "browser_cdp",
  "browser_dialog",
  "browser_console",
  "browser_action",
]);

const APP_STATE_TOOLS = new Set([
  "channel_status",
  "pc_specs",
  "workflow_templates",
  "workflow_list",
  "workflow_get",
  "workflow_execution_status",
  "schedules_list",
  "webhooks_list",
  "board_tasks",
  "governance_queue",
  "documents_list",
  "documents_search",
  "documents_semantic_search",
  "document_get",
]);

const MEMORY_TOOLS = new Set([
  "memory_search",
  "memory_get",
  "session_recall",
  "memory_store",
]);

const EXECUTION_TOOLS = new Set([
  "bash_exec",
  "run_python",
  "http_request",
  "write_file",
]);

export function classifyEvidenceKind(toolName: string): EvidenceKind {
  const name = String(toolName || "").trim().toLowerCase();
  if (REPO_TOOLS.has(name)) return "repo";
  if (WEB_TOOLS.has(name) || BROWSER_TOOLS.has(name)) return "web";
  if (MEMORY_TOOLS.has(name)) return "memory";
  if (EXECUTION_TOOLS.has(name)) return "execution";
  if (name.startsWith("design_")) return "design";
  if (APP_STATE_TOOLS.has(name)) return "app_state";
  if (name === "send_message" || name === "send-webchat" || name === "send-webchat.message") return "unknown";
  return "unknown";
}

let dossierCounter = 0;
function nextDossierId(): string {
  dossierCounter += 1;
  return `evi_${Date.now().toString(36)}_${dossierCounter}`;
}

export function createEvidenceDossier(request: string, planId?: string): UniversalEvidenceDossier {
  const coverage: Record<EvidenceKind, number> = {
    repo: 0,
    web: 0,
    app_state: 0,
    runtime: 0,
    memory: 0,
    document: 0,
    execution: 0,
    design: 0,
    unknown: 0,
  };
  return {
    request: String(request || "").slice(0, 8000),
    planId,
    items: [],
    coverage,
    sourceMap: [],
    contradictions: [],
    unknowns: [],
    toolFailures: [],
  };
}

function sanitize(text: string): string {
  let next = String(text || "");
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, "[redacted]");
  }
  return next;
}

function previewOf(text: string, max = 1400): string {
  return sanitize(String(text || "").replace(/\s+/g, " ").trim().slice(0, max));
}

function claimLines(text: string, max = 6): string[] {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 12 && !/^[{[\]}<]/.test(line) && !/^(?:```|```)/.test(line));
  return lines.slice(0, max);
}

function extractFirstUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/[^\s)\]"'<>]+/i);
  return m ? m[0] : undefined;
}

function extractFilePath(text: string, args: Record<string, unknown>): string | undefined {
  const argPath = typeof args.path === "string" ? args.path : undefined;
  if (argPath) return argPath;
  const argUrl = typeof args.url === "string" ? args.url : undefined;
  if (argUrl) return undefined;
  const m = text.match(/(?:^|\s)([a-zA-Z]:[\\\/][^\s:]+\.[a-zA-Z0-9]+|src\/[^\s:]+\.[a-zA-Z0-9]+|server\/[^\s:]+\.[a-zA-Z0-9]+|scripts\/[^\s:]+\.[a-zA-Z0-9]+)/);
  return m ? m[1] : undefined;
}

function extractLineRefs(text: string): string[] {
  const matches = text.match(/(?:^|[\s:])(?:line\s+)?(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?\b/g);
  if (!matches) return [];
  return matches.slice(0, 4).map((m) => m.replace(/^[\s:]+/, "").trim());
}

function extractTitle(text: string, args: Record<string, unknown>): string | undefined {
  if (typeof args.title === "string" && args.title.trim()) return args.title.trim().slice(0, 200);
  if (typeof args.query === "string" && args.query.trim()) return args.query.trim().slice(0, 200);
  if (typeof args.pattern === "string" && args.pattern.trim()) return args.pattern.trim().slice(0, 200);
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length >= 4 && l.length < 200);
  return first;
}

function appendSource(dossier: UniversalEvidenceDossier, source: EvidenceDossierSource): void {
  const key = `${source.label}::${source.url ?? ""}::${source.filePath ?? ""}`;
  if (dossier.sourceMap.some((existing) => `${existing.label}::${existing.url ?? ""}::${existing.filePath ?? ""}` === key)) return;
  if (dossier.sourceMap.length < 32) dossier.sourceMap.push(source);
}

export function appendToolResultToDossier(input: {
  dossier: UniversalEvidenceDossier;
  toolName: string;
  args: Record<string, unknown>;
  ok: boolean;
  output: string;
}): UniversalEvidenceDossier {
  const toolName = String(input.toolName || "").trim();
  if (!toolName) return input.dossier;
  const kind = classifyEvidenceKind(toolName);
  const rawOutput = String(input.output || "");
  const preview = previewOf(rawOutput, 1200);
  const claims = claimLines(rawOutput, 6).map(sanitize);
  const limitations: string[] = [];
  if (!input.ok) limitations.push("tool reported failure");
  if (rawOutput.length > 1200) limitations.push("output truncated for dossier");

  const item: EvidenceItem = {
    id: nextDossierId(),
    kind,
    toolName,
    ok: input.ok,
    title: extractTitle(rawOutput, input.args),
    sourceUrl: extractFirstUrl(rawOutput),
    filePath: extractFilePath(rawOutput, input.args),
    lineRefs: extractLineRefs(rawOutput),
    retrievedAt: new Date().toISOString(),
    queryOrArgsSummary: clipArgs(input.args),
    claims,
    limitations,
    rawPreview: preview,
  };
  input.dossier.items.push(item);
  if (input.dossier.items.length > 80) {
    input.dossier.items.splice(0, input.dossier.items.length - 80);
  }
  if (input.ok) {
    input.dossier.coverage[kind] = (input.dossier.coverage[kind] ?? 0) + 1;
  }
  if (item.sourceUrl || item.filePath) {
    appendSource(input.dossier, {
      label: item.title || toolName,
      url: item.sourceUrl,
      filePath: item.filePath,
      lineRefs: item.lineRefs,
    });
  }
  if (!input.ok) {
    const failure: EvidenceDossierToolFailure = {
      toolName,
      summary: preview.slice(0, 240) || "tool failed",
      recovered: false,
    };
    input.dossier.toolFailures.push(failure);
    if (input.dossier.toolFailures.length > 24) {
      input.dossier.toolFailures.splice(0, input.dossier.toolFailures.length - 24);
    }
  }
  return input.dossier;
}

export function markToolFailureRecovered(
  dossier: UniversalEvidenceDossier,
  failingToolName: string,
  recoveredByTool: string,
): void {
  for (let i = dossier.toolFailures.length - 1; i >= 0; i -= 1) {
    const failure = dossier.toolFailures[i];
    if (failure && failure.toolName === failingToolName && !failure.recovered) {
      failure.recovered = true;
      failure.recoveredByTool = recoveredByTool;
    }
  }
}

function clipArgs(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args ?? {}, (_key, value) => {
      if (typeof value === "string" && value.length > 200) return `${value.slice(0, 200)}…`;
      return value;
    });
    return json.length > 280 ? `${json.slice(0, 280)}…` : json;
  } catch {
    return "{}";
  }
}

export type DossierSummaryOptions = {
  maxItems?: number;
  maxChars?: number;
  includeRawPreviews?: boolean;
};

export function summarizeDossierForCritic(
  dossier: UniversalEvidenceDossier,
  options: DossierSummaryOptions = {},
): string {
  const maxItems = options.maxItems ?? 24;
  const maxChars = options.maxChars ?? 4500;
  const recent = dossier.items.slice(-maxItems);
  const coverageLine = ALL_KINDS.map((kind) => `${kind}=${dossier.coverage[kind] ?? 0}`).join(", ");
  const sourcesBlock = dossier.sourceMap
    .slice(0, 12)
    .map((s) => {
      const parts = [s.label];
      if (s.filePath) parts.push(`file=${s.filePath}`);
      if (s.url) parts.push(`url=${s.url}`);
      if (s.lineRefs && s.lineRefs.length) parts.push(`lines=${s.lineRefs.join("/")}`);
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");
  const itemsBlock = recent
    .map((item) => {
      const claimLines = item.claims.slice(0, 3).map((c) => `  - ${c}`).join("\n");
      const head = `[${item.kind}] ${item.toolName} ok=${item.ok} | ${item.queryOrArgsSummary}`;
      const refs = [
        item.filePath ? `file=${item.filePath}` : null,
        item.sourceUrl ? `url=${item.sourceUrl}` : null,
        item.lineRefs && item.lineRefs.length ? `lines=${item.lineRefs.join("/")}` : null,
        item.title ? `title=${item.title}` : null,
      ].filter(Boolean).join(" | ");
      return `${head}\n${refs ? `  refs: ${refs}` : ""}${claimLines ? `\n${claimLines}` : ""}${item.limitations.length ? `\n  limits: ${item.limitations.join("; ")}` : ""}`;
    })
    .join("\n\n");
  const failuresBlock = dossier.toolFailures.length
    ? dossier.toolFailures
        .slice(-10)
        .map((failure) => `- ${failure.toolName}: ${failure.summary.slice(0, 160)}${failure.recovered ? ` (recovered by ${failure.recoveredByTool ?? "later tool"})` : ""}`)
        .join("\n")
    : "";
  const block = [
    "Coverage:",
    coverageLine,
    sourcesBlock ? `Sources (${dossier.sourceMap.length}):\n${sourcesBlock}` : "Sources: none yet",
    `Items (${recent.length} most recent):`,
    itemsBlock || "no tool results yet",
    failuresBlock ? `Tool failures (${dossier.toolFailures.length}):\n${failuresBlock}` : "",
    dossier.contradictions.length ? `Known contradictions:\n- ${dossier.contradictions.slice(0, 6).join("\n- ")}` : "",
    dossier.unknowns.length ? `Unknowns:\n- ${dossier.unknowns.slice(0, 6).join("\n- ")}` : "",
  ].filter(Boolean).join("\n\n");
  return block.length > maxChars ? `${block.slice(0, maxChars)}…` : block;
}

export function summarizeDossierForFinalAnswer(
  dossier: UniversalEvidenceDossier,
  options: DossierSummaryOptions = {},
): string {
  return summarizeDossierForCritic(dossier, {
    ...options,
    maxItems: options.maxItems ?? 16,
    maxChars: options.maxChars ?? 3200,
  });
}

export function dossierHasCoverage(
  dossier: UniversalEvidenceDossier,
  requiredKinds: EvidenceKind[],
): boolean {
  return requiredKinds.every((kind) => (dossier.coverage[kind] ?? 0) > 0);
}

export function dossierMissingKinds(
  dossier: UniversalEvidenceDossier,
  requiredKinds: EvidenceKind[],
): EvidenceKind[] {
  return requiredKinds.filter((kind) => (dossier.coverage[kind] ?? 0) === 0);
}

export function recordDossierUnknown(
  dossier: UniversalEvidenceDossier,
  text: string,
): void {
  const clipped = String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!clipped) return;
  if (dossier.unknowns.includes(clipped)) return;
  if (dossier.unknowns.length < 12) dossier.unknowns.push(clipped);
}

export function recordDossierContradiction(
  dossier: UniversalEvidenceDossier,
  text: string,
): void {
  const clipped = String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!clipped) return;
  if (dossier.contradictions.includes(clipped)) return;
  if (dossier.contradictions.length < 12) dossier.contradictions.push(clipped);
}
