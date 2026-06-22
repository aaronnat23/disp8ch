import { createEvidenceItem, type EvidenceItem } from "@/lib/channels/evidence-ledger";
import { buildRepoMap } from "@/lib/channels/repo-inspection-lane";
import type { ModelProvider } from "@/types/model";
import type { ToolDefinition } from "@/lib/engine/tools";

export type RepoEvidenceKind =
  | "repo_map"
  | "file_list"
  | "content_search"
  | "file_read"
  | "test_hint"
  | "benchmark_artifact";

export type RepoEvidenceItem = {
  id: string;
  kind: RepoEvidenceKind;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  outputPreview: string;
  path?: string;
  verified: boolean;
  durationMs: number;
  lineStart?: number;
  lineEnd?: number;
  symbols?: string[];
};

export type RepoInspectionEvidence = {
  items: RepoEvidenceItem[];
  filesRead: string[];
  searchesRun: string[];
  promptBlock: string;
  message?: string;
  metrics: {
    listCalls: number;
    searchCalls: number;
    readCalls: number;
    totalDurationMs: number;
  };
};

type AccuracyMode = "fast" | "balanced" | "thorough";

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
};

type TargetSpec = {
  match: RegExp;
  list: string[];
  search: string[];
  reads: string[];
};

const TARGETS: TargetSpec[] = [
  {
    match: /\b(?:top[.-\s]?level|root|main|important)\b[\s\S]{0,80}\b(?:files?|folders?|director(?:y|ies)|workspace|repo|repository)\b[\s\S]{0,120}\b(?:explain|describe|tell\s+me|why|what\s+each|matters?|for)\b/i,
    list: [".", "src", "scripts", "docs"],
    search: [
      "export const dynamic|NextRequest|routeToWorkflowWithDetails",
      "regression|smoke|setup|diagnostic",
      "AGENTS|SOUL|IDENTITY|TOOLS|MEMORY",
    ],
    reads: [
      "package.json",
      "README.md",
      "CORE_ARCHITECTURE_EXPLANATION.md",
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
      "src/app/api/channels/route.ts",
    ],
  },
  {
    match: /\b(?:repo[-\s]?inspection|repo\s+inspection|repo[-\s]?grounding|grounding|repo\s+evidence|evidence\s+contract|quality\s+gate)\b/i,
    list: ["src/lib/channels", "src/app/api/channels", "scripts"],
    search: [
      "repo-inspection:deep-audit|repo-inspection|repo_inspection",
      "collectRepoInspectionEvidence|mergeRepoInspectionEvidence|repoEvidenceToLedger",
      "evaluateRepoEvidenceContract|formatRepoEvidenceRepairInstruction|evidenceContract",
      "Grounding rules for final answer|verified evidence for behavior claims",
      "classifyDeepAudit|evaluateDeepAuditContract|deepAuditContract",
      "requiresRepoEvidence|repo evidence needed|toolPolicy.*required",
    ],
    reads: [
      "src/app/api/channels/route.ts",
      "src/lib/channels/repo-inspection-controller.ts",
      "src/lib/channels/evidence-contract.ts",
      "src/lib/channels/task-intent-contract.ts",
      "src/lib/channels/deep-audit-profile.ts",
      "src/lib/channels/deep-audit-outline.ts",
      "src/lib/channels/deep-audit-synthesizer.ts",
      "src/lib/channels/deep-audit-contract.ts",
      "scripts/deep-audit-synthesis-regression.ts",
      "scripts/broad-nondeterministic-quality-regression.ts",
      "scripts/llm-led-routing-regression.ts",
    ],
  },
  {
    match: /\b(?:broad\s+web[-\s]?research|web[-\s]?research|metadata\s+checks?|shallow|answer\s+contract|coverage\s+contract|source[-\s]?purpose|claim[-\s]?evidence)\b/i,
    list: ["src/lib/channels", "src/app/api/channels"],
    search: [
      "evaluateBroadAnswerContract|too_shallow|underused_verified_sources",
      "evaluateWebResearchCoverage|source-purpose|sourcePurpose|coverage",
      "classifyResearchTaskSpec|requiredSource|mustMention|must_mention",
      "claim-evidence|verifyClaims|unsupported|evidence",
      "web-research-finalizer|collectBroadEvidence|broad-evidence",
    ],
    reads: [
      "src/lib/channels/broad-answer-contract.ts",
      "src/lib/channels/web-research-coverage-contract.ts",
      "src/lib/channels/web-research-task-spec.ts",
      "src/lib/channels/broad-evidence-controller.ts",
      "src/lib/channels/web-research-finalizer.ts",
      "src/lib/channels/claim-evidence-verifier.ts",
      "src/app/api/channels/route.ts",
      "src/lib/channels/fallback-assistant.ts",
      "src/lib/channels/model-led-context.ts",
      "scripts/web-research-depth-regression.ts",
      "scripts/web-research-quality-regression.ts",
    ],
  },
  {
    match: /\b(toast|toaster|sonner|radix|notification)\b/i,
    list: ["src/components/ui", "src/components/layout", "src/app"],
    search: [
      "toast|toaster|sonner|useToast|notification",
      "Providers|ThemeProvider|layout|Toaster",
      "class-variance-authority|cn\\(",
    ],
    reads: [
      "package.json",
      "src/app/layout.tsx",
      "src/components/layout/providers.tsx",
      "src/components/ui/button.tsx",
      "src/components/ui/dialog.tsx",
      "src/components/ui/dropdown-menu.tsx",
      "src/lib/utils.ts",
      "src/app/globals.css",
    ],
  },
  {
    match: /\b(chat|webchat|message|latency|stream|markdown|virtual|scroll|render|ui)\b/i,
    list: ["src/components/chat", "src/app/(operator)/chat"],
    search: ["virtual|scroll|stream|markdown|message|latency|render"],
    reads: [
      "src/app/(operator)/chat/client-page.tsx",
      "src/components/chat/session-workbench.tsx",
      "src/components/chat/streaming-markdown.tsx",
      "src/components/chat/message-execution-cards.tsx",
      "src/components/chat/tool-call-card.tsx",
    ],
  },
  {
    match: /\b(?:youtube|transcript|caption|captions|video\s+analysis|marlin|upload|uploads|local\s+video)\b/i,
    list: ["src/lib/video", "src/app/api/uploads", "src/app/api/voice", "src/components/chat"],
    search: [
      "youtube_transcript|fetchTranscriptRobust|fetchYouTubeTranscript|caption|transcript",
      "local-video|Marlin|video analysis|upload|uploads",
      "image_generate|youtube_transcript|TOOL_CATALOG",
      "streaming-markdown|generated-images|artifact|attachment",
    ],
    reads: [
      "src/lib/video/youtube-transcript.ts",
      "src/lib/video/youtube-transcript-strategies.ts",
      "src/lib/video/local-video-capabilities.ts",
      "src/app/api/uploads/route.ts",
      "src/app/api/voice/stt/route.ts",
      "src/lib/engine/tools.ts",
      "src/app/api/channels/route.ts",
      "src/components/chat/streaming-markdown.tsx",
      "src/components/chat/message-execution-cards.tsx",
    ],
  },
  {
    match: /\b(workflow|node|cron|schedule|run-code|http|webhook|board|send-webchat)\b/i,
    list: ["src/lib/workflows", "src/components/workflows", "src/lib/channels"],
    search: ["cron|schedule|run-code|http-request|send-webchat|workflow_templates|board-task"],
    reads: [
      "CORE_ARCHITECTURE_EXPLANATION.md",
      "src/lib/channels/app-action-planner.ts",
      "src/lib/engine/tools.ts",
    ],
  },
  {
    match: /\b(agent|tool|router|lane|fallback|model-led|gemini|inspection|quality|evidence)\b/i,
    list: ["src/lib/channels", "src/lib/agents"],
    search: ["model-led|fallback|toolBudget|requireToolUse|accuracyMode|repo_inspection|evidence"],
    reads: [
      "src/app/api/channels/route.ts",
      "src/lib/channels/fallback-assistant.ts",
      "src/lib/agents/tool-caller.ts",
      "src/lib/channels/model-led-context.ts",
      "src/lib/channels/broad-research-prompt.ts",
      "src/lib/channels/answer-quality-gate.ts",
    ],
  },
];

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function targetSpecsForMessage(message: string): TargetSpec[] {
  const matched = TARGETS.filter((target) => target.match.test(message));
  return matched.length > 0
    ? matched
    : [
        {
          match: /.*/,
          list: ["src/app", "src/components", "src/lib"],
          search: ["TODO|FIXME|export function|route|handler|component|workflow"],
          reads: [
            "src/app/api/channels/route.ts",
            "src/lib/channels/fallback-assistant.ts",
            "src/lib/channels/model-led-context.ts",
          ],
        },
      ];
}

function inferKind(call: ToolCall): RepoEvidenceKind {
  if (call.name === "list_files") return "file_list";
  if (call.name === "search_files") return "content_search";
  if (call.name === "read_file") return "file_read";
  if (/test|benchmark/i.test(String(call.args.path ?? call.args.pattern ?? ""))) return "test_hint";
  return "repo_map";
}

function outputSummary(output: string): string {
  const text = String(output || "").replace(/\s+/g, " ").trim();
  if (!text) return "(empty result)";
  return text.slice(0, 360);
}

function inferReadLineRange(output: string): { lineStart?: number; lineEnd?: number } {
  const lineMatches = Array.from(output.matchAll(/^\s*(\d+)[|:]\s/gm), (match) => Number(match[1])).filter(Number.isFinite);
  if (lineMatches.length > 0) return { lineStart: Math.min(...lineMatches), lineEnd: Math.max(...lineMatches) };
  const range = output.match(/\blines?\s+(\d+)(?:\s*[-–]\s*(\d+))?/i);
  if (range) return { lineStart: Number(range[1]), lineEnd: Number(range[2] || range[1]) };
  return {};
}

function extractSymbols(output: string): string[] {
  const symbols = [
    ...Array.from(output.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g), (m) => m[1]),
    ...Array.from(output.matchAll(/\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/g), (m) => m[1]),
    ...Array.from(output.matchAll(/\bclass\s+([A-Za-z0-9_$]+)/g), (m) => m[1]),
    ...Array.from(output.matchAll(/\bexport\s+(?:const|type|interface)\s+([A-Za-z0-9_$]+)/g), (m) => m[1]),
  ];
  return unique(symbols).slice(0, 16);
}

// ── Dynamic discovery planner ─────────────────────────────────────────────
// Pull identifier-like tokens from the user's question and propose targeted
// search/list/read calls. The discovery phase queues follow-up reads from
// actual search results instead of relying only on predefined targets.

const REPO_TOKEN_STOP = new Set([
  "with","from","into","about","plan","that","then","also","what","when","where","which","does","explain","describe","tell","me","why","claim","claims","make","makes","exactly","please","really","behaviour","behavior","check","verify","trace","find","files","file","there","their","its","they","them","have","need","needs","want","like","include","cover","across","without","using","based","might","could","would","should","while","over","under","above","below","each","every","still","again","only","just","some","most","both","than","very","more","much","none","such","made","done","other","others","this","give","show","list","any","can","does","the","and","for","are","but","not","you","all","had","her","was","one","our","out","has","his","how","its","may","new","now","old","see","way","who","did","get","let","say","she","too","use",
]);

const INTENT_NOUN_STOP = new Set([
  "about","after","again","also","been","before","being","between","both","came","come","could","does","each","else","from","give","given","gives","giving","going","good","great","have","here","high","just","keep","know","last","left","like","line","live","long","look","made","main","make","many","might","more","most","much","must","near","need","next","none","note","once","only","open","over","page","part","past","plan","plus","poor","real","rest","same","seem","show","side","some","soon","sure","take","tell","than","that","them","then","they","this","thus","time","tiny","took","upon","used","uses","very","want","well","were","what","when","whom","will","with","work","your",
]);

const REPO_DIR_HINTS = [
  "src/lib", "src/app", "src/components", "scripts", "docs", "data",
  "agents", "extensions", "skills", "optional-skills",
];

function extractMessageTokens(message: string): string[] {
  const tokens = new Set<string>();
  // CamelCase + dotted identifiers
  for (const m of message.matchAll(/\b([A-Z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9_.]*|\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9_.]*)\b/g)) {
    const tok = m[1];
    if (tok.length >= 4) tokens.add(tok);
  }
  // snake_case identifiers (5+ chars, two+ segments)
  for (const m of message.matchAll(/\b([a-z][a-z0-9]+(?:_[a-z0-9]+){1,4})\b/gi)) {
    const tok = m[1].toLowerCase();
    if (!REPO_TOKEN_STOP.has(tok) && tok.length >= 5) tokens.add(tok);
  }
  // Quoted phrases — extract anything in single/double/backtick quotes
  for (const m of message.matchAll(/["'`]([^"'`\n]{3,80})["'`]/g)) {
    const phrase = m[1].trim();
    if (phrase.length >= 3 && !REPO_TOKEN_STOP.has(phrase.toLowerCase())) tokens.add(phrase);
  }
  // Backticked / inline file paths
  for (const m of message.matchAll(/\b((?:src|scripts|docs|data|extensions|agents)\/[A-Za-z0-9_./-]+\.[A-Za-z]{1,5})\b/g)) {
    tokens.add(m[1]);
  }
  return Array.from(tokens);
}

function extractMentionedDirs(message: string): string[] {
  const found = new Set<string>();
  for (const dir of REPO_DIR_HINTS) {
    if (message.toLowerCase().includes(dir.toLowerCase())) found.add(dir);
  }
  for (const m of message.matchAll(/\b((?:src|scripts|docs|data|extensions|agents)\/[A-Za-z0-9_/-]{2,40})\b/g)) {
    found.add(m[1]);
  }
  return Array.from(found);
}

function buildDynamicPlan(message: string, mode: AccuracyMode): { searches: string[]; lists: string[]; reads: string[] } {
  const tokens = extractMessageTokens(message);
  const dirs = extractMentionedDirs(message);
  const searchCap = mode === "thorough" ? 6 : mode === "balanced" ? 4 : 2;
  const listCap = mode === "thorough" ? 4 : 2;

  // Search for identifier-like tokens directly; quote them to make grep treat them literally.
  const searches = tokens
    .filter((t) => /[A-Za-z]/.test(t) && t.length <= 60)
    .slice(0, searchCap)
    .map((t) => {
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return esc;
    });

  // Extract intent-noun searches from the message: nouns/verbs > 3 chars that are not stopwords.
  // This lets a question about "API keys in logs" grep for api, key, secret, redact, log, token.
  const intentNouns = extractIntentNouns(message, searches, searchCap);
  const lists = dirs.slice(0, listCap);
  // Direct file path mentions become read_file candidates
  const reads = tokens.filter((t) => /\.(ts|tsx|js|jsx|py|md|json|yaml|yml|toml|sh|bat|html|css|sql)$/i.test(t)).slice(0, mode === "thorough" ? 4 : 2);
  return { searches: [...searches, ...intentNouns].slice(0, searchCap + 2), lists, reads };
}

function extractIntentNouns(message: string, existingSearches: string[], cap: number): string[] {
  const words = message.toLowerCase().replace(/[^a-z0-9\s_-]/g, " ").split(/\s+/).filter(Boolean);
  const existing = new Set(existingSearches.map((s) => s.toLowerCase()));
  const result: string[] = [];
  for (const word of words) {
    if (word.length < 4) continue;
    if (INTENT_NOUN_STOP.has(word)) continue;
    if (REPO_TOKEN_STOP.has(word)) continue;
    if (existing.has(word)) continue;
    if (result.includes(word)) continue;
    result.push(word);
    if (result.length >= cap) break;
  }
  return result;
}

function filesFromSearchHits(items: RepoEvidenceItem[], cap: number): string[] {
  const hitCounts = new Map<string, number>();
  for (const item of items) {
    if (item.tool !== "search_files") continue;
    const preview = item.outputPreview || item.summary || "";
    // Match file paths like src/lib/foo.ts:123: or server/bar.ts:45:
    const pathRegex = /\b((?:src|server|scripts|docs)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|jsx|mjs|cjs|css|json|md|yaml|yml))\b/g;
    let match: RegExpExecArray | null;
    while ((match = pathRegex.exec(preview)) !== null) {
      const p = match[1];
      hitCounts.set(p, (hitCounts.get(p) ?? 0) + 1);
    }
  }
  return Array.from(hitCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([p]) => p);
}

function buildToolCalls(params: {
  message: string;
  mode: AccuracyMode;
  requiredReads?: string[];
  requiredSearches?: string[];
}): ToolCall[] {
  const specs = targetSpecsForMessage(params.message);
  const dynamic = buildDynamicPlan(params.message, params.mode);

  const listPaths = unique([
    ...specs.flatMap((spec) => spec.list),
    ...dynamic.lists,
  ]).slice(0, params.mode === "thorough" ? 5 : 3);

  const searches = unique([
    ...specs.flatMap((spec) => spec.search),
    ...dynamic.searches,
    ...(params.requiredSearches ?? []),
  ]).slice(0, params.mode === "thorough" ? 8 : params.mode === "balanced" ? 5 : 3);

  const minReads = params.mode === "fast" ? 1 : params.mode === "balanced" ? 2 : 4;
  const reads = unique([
    ...(params.requiredReads ?? []),
    ...dynamic.reads,
    ...specs.flatMap((spec) => spec.reads),
  ]).slice(
    0,
    Math.max(minReads, params.requiredReads?.length ?? 0, params.mode === "thorough" ? 12 : 4),
  );

  const calls: ToolCall[] = [];
  for (const listPath of listPaths) {
    calls.push({ name: "list_files", args: { path: listPath, recursive: "false" } });
  }
  for (const pattern of searches) {
    calls.push({ name: "search_files", args: { pattern, path: "src", maxResults: 30 } });
  }
  for (const readPath of reads) {
    calls.push({ name: "read_file", args: { path: readPath } });
  }
  return calls;
}

function formatPromptBlock(evidence: Omit<RepoInspectionEvidence, "promptBlock">): string {
  const lines = [
    "Repo inspection preflight evidence from actual read-only tools:",
    "",
    "[repo_map/partial]",
    buildRepoMap(),
    "",
    `Metrics: list=${evidence.metrics.listCalls}, search=${evidence.metrics.searchCalls}, read=${evidence.metrics.readCalls}, durationMs=${evidence.metrics.totalDurationMs}`,
    "",
    "Evidence:",
  ];

  for (const item of evidence.items.slice(0, 18)) {
    const lineRange = item.lineStart ? `${item.lineStart}${item.lineEnd && item.lineEnd !== item.lineStart ? `-${item.lineEnd}` : ""}` : "";
    const citation = item.path && lineRange ? `${item.path}:${lineRange}` : item.path;
    const locator = citation ? `repo:${citation}` : item.tool;
    const lineInfo = lineRange ? ` lines=${lineRange}` : "";
    const symbolInfo = item.symbols?.length ? ` symbols=${item.symbols.slice(0, 6).join(",")}` : "";
    lines.push(`- [${item.kind}/${item.verified ? "verified" : "partial"}] ${locator}${lineInfo}${symbolInfo}: ${item.summary}`);
  }

  const snippetItems = evidence.items
    .filter((item) => item.kind === "file_read" || item.kind === "content_search")
    .filter((item) => item.outputPreview.trim().length > 0)
    .slice(0, 14);
  if (snippetItems.length > 0) {
    lines.push("");
    lines.push("Bounded tool-output snippets for synthesis:");
    lines.push("Use these snippets for exact names and nearby line/content claims. If a line or behavior is not visible here, cite the file/function only or label the point as a candidate.");
    for (const item of snippetItems) {
      const path = item.path ? ` ${item.path}` : "";
      const lineRange = item.lineStart ? ` lines ${item.lineStart}-${item.lineEnd ?? item.lineStart}` : "";
      lines.push("");
      lines.push(`--- ${item.kind}${path}${lineRange} (${item.tool}) ---`);
      lines.push(item.outputPreview.slice(0, item.kind === "file_read" ? 1800 : 1200));
    }
  }

  lines.push("");
  lines.push("Grounding rules for final answer:");
  lines.push("- Treat file_list and content_search as candidate discovery.");
  lines.push("- Treat file_read as verified evidence for behavior claims.");
  lines.push("- When claiming behavior about a file, cite the exact line range or function name from the read_file output in the evidence above.");
  lines.push("- Prefer citation-ready forms like `src/lib/example.ts:12-48`; do not cite a line range unless it appeared in file_read evidence.");
  lines.push("- Do not say code is verified/confirmed unless file_read evidence supports it.");
  lines.push("- Prefer concrete path:line references over vague file-level mentions when the evidence contains line numbers.");
  lines.push("- For repo inspection, include concrete files, observed facts, risks, tests, and acceptance criteria when relevant.");
  return lines.join("\n");
}

export function repoEvidenceToLedger(evidence: RepoInspectionEvidence): EvidenceItem[] {
  return evidence.items.map((item) => createEvidenceItem(item.tool, item.args, item.outputPreview || item.summary));
}

export function planDeepAuditExpansion(
  evidence: RepoInspectionEvidence,
  filesRead: string[],
  searchesRun: string[],
): { extraReads: string[]; extraSearches: string[]; reason: string } {
  const extraReads: string[] = [];
  const extraSearches: string[] = [];
  const readSet = new Set(filesRead.map((f) => f.replace(/\\/g, "/")));

  // If search results mention files we haven't read, add them
  const allOutput = evidence.items
    .filter((item) => item.tool === "search_files")
    .map((item) => item.outputPreview || item.summary)
    .join("\n");

  const fileRefs = allOutput.match(/\b(?:src|app|lib|scripts|docs)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|jsx|mjs|cjs|css|json|md)\b/g) ?? [];
  for (const ref of fileRefs) {
    if (!readSet.has(ref) && extraReads.length < 6) {
      extraReads.push(ref);
      readSet.add(ref);
    }
  }

  // If the topic mentions contracts, quality gates, or regression, search for related files
  if (evidence.message && /\b(contract|gate|quality|shallow|pass.*fail|regression)\b/i.test(evidence.message)) {
    const contractSearch = "contract or quality or gate or shallow or regression";
    if (!searchesRun.some((s) => s.toLowerCase().includes("contract") || s.toLowerCase().includes("quality"))) {
      extraSearches.push(contractSearch);
    }
  }

  const reason = [
    extraReads.length > 0 ? `${extraReads.length} extra files from search results` : "",
    extraSearches.length > 0 ? `${extraSearches.length} extra searches for contracts/gates` : "",
  ].filter(Boolean).join("; ") || "no expansion needed";

  return { extraReads, extraSearches, reason };
}

export async function collectRepoInspectionEvidence(params: {
  message: string;
  sessionId: string;
  agentId: string;
  mode: AccuracyMode;
  readOnly?: boolean;
  requiredReads?: string[];
  requiredSearches?: string[];
  onEmit?: (event: string, data: unknown) => void;
}): Promise<RepoInspectionEvidence> {
  const { executeTool } = await import("@/lib/engine/tools");
  const startedAt = Date.now();
  const items: RepoEvidenceItem[] = [];
  const filesRead: string[] = [];
  const searchesRun: string[] = [];
  const calls = buildToolCalls({
    message: params.message,
    mode: params.mode,
    requiredReads: params.requiredReads,
    requiredSearches: params.requiredSearches,
  });

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const callStartedAt = Date.now();
    params.onEmit?.("webchat:tool", {
      sessionId: params.sessionId,
      phase: "start",
      name: call.name,
      args: call.args,
    });
    params.onEmit?.("webchat:status", {
      sessionId: params.sessionId,
      phase: "tool_call",
      label: `Using ${call.name}...`,
      detail: Object.entries(call.args).slice(0, 2).map(([key, value]) => `${key}: ${String(value).slice(0, 80)}`).join(", ") || null,
      createdAt: new Date().toISOString(),
    });

    let output = "";
    try {
      output = await executeTool(call.name, call.args, {
        agentId: params.agentId,
        channelSessionId: params.sessionId,
        readOnly: params.readOnly !== false,
      });
    } catch (error) {
      output = `Error executing ${call.name}: ${error instanceof Error ? error.message : String(error)}`;
    }

    const kind = inferKind(call);
    const path = typeof call.args.path === "string" ? call.args.path : undefined;
    const isError = /^(?:Error|Tool failed|Unknown tool|Failed to execute)\b/i.test(output.trim());
    const durationMs = Date.now() - callStartedAt;
    const lineRange = kind === "file_read" ? inferReadLineRange(output) : {};
    const symbols = kind === "file_read" ? extractSymbols(output) : [];
    const item: RepoEvidenceItem = {
      id: `${call.name}-${index + 1}`,
      kind,
      tool: call.name,
      args: call.args,
      path,
      summary: outputSummary(output),
      outputPreview: output.slice(0, 4000),
      verified: kind === "file_read" && !isError,
      durationMs,
      ...lineRange,
      symbols,
    };
    items.push(item);
    if (call.name === "read_file" && path && !isError) filesRead.push(path);
    if (call.name === "search_files") searchesRun.push(String(call.args.pattern ?? ""));

    params.onEmit?.("webchat:tool", {
      sessionId: params.sessionId,
      phase: "done",
      name: call.name,
      resultPreview: output.slice(0, 200),
    });
    params.onEmit?.("webchat:status", {
      sessionId: params.sessionId,
      phase: "tool_done",
      label: `Completed ${call.name}`,
      detail: null,
      createdAt: new Date().toISOString(),
    });
  }

  const metrics = {
    listCalls: items.filter((item) => item.tool === "list_files").length,
    searchCalls: items.filter((item) => item.tool === "search_files").length,
    readCalls: filesRead.length,
    totalDurationMs: Date.now() - startedAt,
  };

  // ── Adaptive read pass: read files discovered by search hits ──
  // Read the strongest search hits so the final answer can cite verified lines.
  const readCap = params.mode === "thorough" ? 8 : params.mode === "balanced" ? 4 : 2;
  const discoveredFiles = filesFromSearchHits(items, readCap);
  const readSet = new Set(filesRead.map((f) => f.replace(/\\/g, "/")));
  const adaptiveReads = discoveredFiles.filter((f) => !readSet.has(f));

  for (const readPath of adaptiveReads) {
    const callStartedAt = Date.now();
    params.onEmit?.("webchat:tool", {
      sessionId: params.sessionId,
      phase: "start",
      name: "read_file",
      args: { path: readPath },
    });

    let output = "";
    try {
      output = await executeTool("read_file", { path: readPath }, {
        agentId: params.agentId,
        channelSessionId: params.sessionId,
        readOnly: params.readOnly !== false,
      });
    } catch (error) {
      output = `Error executing read_file: ${error instanceof Error ? error.message : String(error)}`;
    }

    const isError = /^(?:Error|Tool failed|Unknown tool|Failed to execute)\b/i.test(output.trim());
    const durationMs = Date.now() - callStartedAt;
    const lineRange = inferReadLineRange(output);
    const symbols = extractSymbols(output);
    items.push({
      id: `read_file-adaptive-${items.length + 1}`,
      kind: "file_read",
      tool: "read_file",
      args: { path: readPath },
      path: readPath,
      summary: outputSummary(output),
      outputPreview: output.slice(0, 4000),
      verified: !isError,
      durationMs,
      ...lineRange,
      symbols,
    });
    if (!isError) filesRead.push(readPath);

    params.onEmit?.("webchat:tool", {
      sessionId: params.sessionId,
      phase: "done",
      name: "read_file",
      resultPreview: output.slice(0, 200),
    });
  }

  // Update metrics after adaptive reads
  const finalMetrics = {
    listCalls: metrics.listCalls,
    searchCalls: metrics.searchCalls,
    readCalls: filesRead.length,
    totalDurationMs: Date.now() - startedAt,
  };

  const withoutPrompt = {
    items,
    filesRead: unique(filesRead),
    searchesRun: unique(searchesRun),
    metrics: finalMetrics,
  };
  return {
    ...withoutPrompt,
    message: params.message,
    promptBlock: formatPromptBlock(withoutPrompt),
  };
}

export function mergeRepoInspectionEvidence(
  first: RepoInspectionEvidence,
  second: RepoInspectionEvidence,
): RepoInspectionEvidence {
  const items = [...first.items, ...second.items];
  const filesRead = unique([...first.filesRead, ...second.filesRead]);
  const searchesRun = unique([...first.searchesRun, ...second.searchesRun]);
  const metrics = {
    listCalls: first.metrics.listCalls + second.metrics.listCalls,
    searchCalls: first.metrics.searchCalls + second.metrics.searchCalls,
    readCalls: filesRead.length,
    totalDurationMs: first.metrics.totalDurationMs + second.metrics.totalDurationMs,
  };
  const merged = { items, filesRead, searchesRun, metrics, message: first.message || second.message };
  return {
    ...merged,
    promptBlock: formatPromptBlock(merged),
  };
}

const AGENTIC_EXPANSION_SYSTEM = `You are a codebase inspector. Given a user question and the evidence collected so far, identify up to 4 specific files that should be read next to answer the question properly.

Rules:
- Only request files under src/, server/, or scripts/.
- Only request .ts, .tsx, .js, .jsx, .md, .json files.
- Prefer files that are likely to contain the code/behavior the question asks about.
- Do NOT request files already read (they are listed in the evidence).
- Return ONLY a JSON array of file paths, nothing else.
- Example: ["src/lib/logger.ts", "src/lib/secrets/store.ts"]`;

/**
 * When the deterministic preflight + synthesizer can't satisfy the answer contract,
 * use the model to request specific file reads, then return expanded evidence.
 * This is the "let the LLM decide" agentic fallback.
 */
export async function runAgenticEvidenceExpansion(params: {
  message: string;
  currentEvidence: RepoInspectionEvidence;
  sessionId: string;
  agentId: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  maxReads?: number;
}): Promise<RepoInspectionEvidence | null> {
  const { executeTool } = await import("@/lib/engine/tools");
  const { callModel } = await import("@/lib/agents/multi-provider");

  const maxReads = params.maxReads ?? 4;
  const alreadyRead = new Set(params.currentEvidence.filesRead.map((f) => f.replace(/\\/g, "/")));

  const evidenceSummary = params.currentEvidence.items
    .filter((item) => item.kind === "file_read")
    .map((item) => `- ${item.path}: ${item.summary.slice(0, 120)}`)
    .join("\n");

  const searchSummary = params.currentEvidence.items
    .filter((item) => item.kind === "content_search")
    .map((item) => `- ${item.args?.pattern}: ${item.summary.slice(0, 120)}`)
    .join("\n");

  const userPrompt = [
    `User question: ${params.message}`,
    "",
    `Files already read: ${Array.from(alreadyRead).join(", ") || "none"}`,
    "",
    "Evidence collected so far:",
    evidenceSummary || "(no file reads yet)",
    "",
    "Search results so far:",
    searchSummary || "(no searches yet)",
    "",
    `Which ${maxReads} files should be read next to answer the question? Return ONLY a JSON array.`,
  ].join("\n");

  let requestedFiles: string[] = [];
  try {
    const { callModel } = await import("@/lib/agents/multi-provider");
    const result = await callModel({
      provider: params.provider as ModelProvider,
      modelId: params.modelId,
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      systemPrompt: AGENTIC_EXPANSION_SYSTEM,
      userMessage: userPrompt,
      temperature: 0,
      maxTokens: 500,
    });

    const raw = (result.response ?? "").trim();
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      requestedFiles = parsed
        .filter((f: unknown) => typeof f === "string" && f.length < 200)
        .filter((f: string) => !alreadyRead.has(f.replace(/\\/g, "/")))
        .slice(0, maxReads);
    }
  } catch {
    return null;
  }

  if (requestedFiles.length === 0) return null;

  // Execute the reads
  const items = [...params.currentEvidence.items];
  const filesRead = [...params.currentEvidence.filesRead];
  const startedAt = Date.now();

  for (const readPath of requestedFiles) {
    let output = "";
    try {
      output = await executeTool("read_file", { path: readPath }, {
        agentId: params.agentId,
        channelSessionId: params.sessionId,
        readOnly: true,
      });
    } catch (error) {
      output = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }

    const isError = /^(?:Error|Tool failed|Unknown tool|Failed to execute)\b/i.test(output.trim());
    items.push({
      id: `read_file-agentic-${items.length + 1}`,
      kind: "file_read",
      tool: "read_file",
      args: { path: readPath },
      path: readPath,
      summary: outputSummary(output),
      outputPreview: output.slice(0, 4000),
      verified: !isError,
      durationMs: Date.now() - startedAt,
      ...inferReadLineRange(output),
      symbols: extractSymbols(output),
    });
    if (!isError) filesRead.push(readPath);
  }

  const merged = {
    items,
    filesRead: unique(filesRead),
    searchesRun: params.currentEvidence.searchesRun,
    metrics: {
      listCalls: params.currentEvidence.metrics.listCalls,
      searchCalls: params.currentEvidence.metrics.searchCalls,
      readCalls: filesRead.length,
      totalDurationMs: params.currentEvidence.metrics.totalDurationMs + (Date.now() - startedAt),
    },
    message: params.message,
  };

  return {
    ...merged,
    promptBlock: formatPromptBlock(merged),
  };
}

// ── Read-only agentic answer via callWithTools ────────────────────────────────
// Lets the model grep + read whatever it needs, then answer with citations.
// Used for read-only repo and capability audits without prompt-specific seed files.

const REPO_AUDIT_TOOL_DEFS: ToolDefinition[] = [
  {
    name: "search_files",
    description: "Search file contents using regex. Returns matching lines with file paths and line numbers. Use this to find code patterns, function names, config keys, or error messages.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory to search in (default: src)" },
        maxResults: { type: "string", description: "Maximum results to return (default: 30)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_file",
    description: "Read a file's contents. Returns lines with line numbers. Use after search_files to read the full context of matches.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to project root" },
        startLine: { type: "string", description: "Start line number (1-indexed, optional)" },
        endLine: { type: "string", description: "End line number (1-indexed, optional)" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List files in a directory. Returns file names with type indicators.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list" },
        recursive: { type: "string", description: "Whether to list recursively (true/false)" },
      },
      required: ["path"],
    },
  },
];

export function getReadOnlyRepoToolDefs(): ToolDefinition[] {
  return REPO_AUDIT_TOOL_DEFS;
}

export async function answerWithReadOnlyRepoTools(params: {
  message: string;
  sessionId: string;
  agentId: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  mode: AccuracyMode;
  systemPrompt: string;
  onToken?: (token: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, ok: boolean, output: string) => void;
}): Promise<string> {
  const { callWithTools } = await import("@/lib/agents/tool-caller");
  // Keep the round budget tight: slow reasoning models can spend ~40-60s per round, so a
  // large budget blows past request timeouts. A focused audit needs only a few grep+read rounds.
  const maxToolCalls = params.mode === "thorough" ? 6 : params.mode === "balanced" ? 5 : 4;
  const maxTokens = params.mode === "thorough" ? 4000 : 2500;

  // Capture the file contents the loop reads, so we can synthesize a final answer even if
  // the model returns an empty/tool-markup final round (some models, e.g. reasoning/Qwen-class,
  // emit <tool_call> text or empty content after executing tools instead of a final answer).
  const gathered: Array<{ path: string; content: string }> = [];
  const searchOutputs: string[] = [];
  let pendingReadPath = "";

  const result = await callWithTools({
    provider: params.provider as ModelProvider,
    modelId: params.modelId,
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    systemPrompt: params.systemPrompt,
    userMessage: params.message,
    maxTokens,
    temperature: 0.2,
    tools: REPO_AUDIT_TOOL_DEFS,
    maxToolCalls,
    readOnly: true,
    toolPolicy: { approvalMode: "off" },
    onToolCall: (name, args) => {
      if (name === "read_file" && typeof args.path === "string") pendingReadPath = args.path;
      params.onToolCall?.(name, args);
    },
    onToolResult: (name, ok, output) => {
      if (name === "read_file" && ok && pendingReadPath) {
        gathered.push({ path: pendingReadPath, content: output });
        pendingReadPath = "";
      }
      if (name === "search_files" && ok) searchOutputs.push(output);
      params.onToolResult?.(name, ok, output);
    },
    onToken: params.onToken,
  });

  const stripToolMarkup = (s: string): string => s
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function=[\s\S]*?(?:<\/function>|$)/gi, "")
    .replace(/<parameter=[^>]*>[\s\S]*?(?:<\/parameter>|$)/gi, "")
    .trim();

  let answer = (result.response ?? "").trim();
  // Some Qwen-class models mix stray <tool_call> markup into otherwise-usable prose.
  if (/<tool_call|<function=/i.test(answer)) {
    const stripped = stripToolMarkup(answer);
    if (stripped.length >= 120) answer = stripped;
  }

  // If the model searched but never read files within the round budget (some models
  // over-explore), read the top search-hit files directly so we can still ground the answer.
  if (gathered.length === 0 && searchOutputs.length > 0) {
    const { executeTool } = await import("@/lib/engine/tools");
    const pathCounts = new Map<string, number>();
    const pathRe = /\b((?:src|server|scripts)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|jsx))\b/g;
    for (const out of searchOutputs) {
      let m: RegExpExecArray | null;
      while ((m = pathRe.exec(out)) !== null) pathCounts.set(m[1], (pathCounts.get(m[1]) ?? 0) + 1);
    }
    const topPaths = [...pathCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => p);
    for (const p of topPaths) {
      try {
        const out = await executeTool("read_file", { path: p }, { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true });
        if (!/^(?:Error|Tool failed|Unknown tool|Failed to execute)/i.test(out.trim())) gathered.push({ path: p, content: out });
      } catch {
        // skip unreadable paths
      }
    }
  }

  // Recovery: the loop executed reads but produced no usable final answer. Do one
  // no-tools completion with the gathered file contents inline — a single completion
  // avoids the multi-round tool-call format that some models stumble on.
  const looksUnusable = answer.length < 80 || /<tool_call|<function=|<parameter=/i.test(answer);
  if (looksUnusable && gathered.length > 0) {
    const { callModel } = await import("@/lib/agents/multi-provider");
    const evidenceBlock = gathered
      .slice(0, 8)
      .map((g) => `### ${g.path}\n${g.content.slice(0, 1800)}`)
      .join("\n\n");
    try {
      const synth = await callModel({
        provider: params.provider as ModelProvider,
        modelId: params.modelId,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
        systemPrompt: `${params.systemPrompt}\n\nYou have already read the files below. Write the FINAL answer now using only these file contents. Cite exact file paths and functions. Do not call tools or emit tool-call markup.`,
        userMessage: `${params.message}\n\n## Files already read\n${evidenceBlock}`,
        temperature: 0.2,
        maxTokens,
      });
      let synthText = (synth.response ?? "").trim();
      if (/<tool_call|<function=/i.test(synthText)) synthText = stripToolMarkup(synthText);
      if (synthText.length >= 80) answer = synthText;
    } catch {
      // fall through with whatever we have
    }
  }

  return answer;
}
