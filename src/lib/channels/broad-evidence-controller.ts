import { buildRepoMap } from "@/lib/channels/repo-inspection-lane";
import { TOOL_CATALOG } from "@/lib/engine/tools";
import { listWorkflowTemplateCatalog } from "@/lib/workflows/template-catalog";
import type { BroadEvidenceNeed, BroadTaskDecision } from "@/lib/channels/broad-task-decision";
import { runWebResearch } from "@/lib/channels/web-research-orchestrator";
import type { EvidenceLedgerEntry } from "@/lib/channels/evidence-ledger-v2";
import { classifyResearchTaskSpec, taskSpecToAnswerSections, type ResearchSourcePurpose } from "@/lib/channels/web-research-task-spec";
import { isSourcePurposeCoveredByGroup } from "@/lib/channels/web-research-coverage-contract";

export type BroadEvidenceItem = {
  kind: BroadEvidenceNeed;
  source: string;
  tool: string;
  verified: boolean;
  summary: string;
  outputPreview: string;
  url?: string;
  path?: string;
};

export type BroadEvidencePack = {
  decision: BroadTaskDecision;
  items: BroadEvidenceItem[];
  ledger?: EvidenceLedgerEntry[];
  promptBlock: string;
  metrics: {
    webSearches: number;
    urlsFetched: number;
    filesRead: number;
    appRegistryReads: number;
    benchmarkFilesRead: number;
    memoryReads: number;
    sourcePurposeCoverage?: SourcePurposeCoverage;
  };
  diagnostics?: Record<string, unknown>;
};

type EmitFn = (event: string, data: unknown) => void;

export type SourcePurposeCoverage = {
  required: ResearchSourcePurpose[];
  covered: ResearchSourcePurpose[];
  missing: ResearchSourcePurpose[];
  exactCovered: ResearchSourcePurpose[];
  exactMissing: ResearchSourcePurpose[];
  groupedCovered: ResearchSourcePurpose[];
  groupedMissing: ResearchSourcePurpose[];
  byPurpose: Partial<Record<string, string[]>>;
};

function buildSourcePurposeCoverage(ledger: EvidenceLedgerEntry[], required: ResearchSourcePurpose[]): SourcePurposeCoverage {
  const byPurpose: Record<string, string[]> = {};
  for (const entry of ledger) {
    if (!entry.verified || entry.metadata?.sourceKind === "search_index") continue;
    const purpose = (entry.metadata?.sourcePurpose as string) ?? "generic";
    if (!byPurpose[purpose]) byPurpose[purpose] = [];
    if (/^https?:\/\//i.test(entry.canonicalLocator) && !byPurpose[purpose].includes(entry.canonicalLocator)) {
      byPurpose[purpose].push(entry.canonicalLocator);
    }
  }
  const meaningful = required.filter((p) => p !== "generic" && p !== "youtube_transcript");
  const available = Object.keys(byPurpose) as ResearchSourcePurpose[];
  const exactCovered = meaningful.filter((p) => (byPurpose[p]?.length ?? 0) > 0);
  const exactMissing = meaningful.filter((p) => !(byPurpose[p]?.length ?? 0));
  const groupedCovered = meaningful.filter((p) => isSourcePurposeCoveredByGroup(p, available));
  const groupedMissing = meaningful.filter((p) => !isSourcePurposeCoveredByGroup(p, available));
  return {
    required,
    covered: groupedCovered,
    missing: groupedMissing,
    exactCovered,
    exactMissing,
    groupedCovered,
    groupedMissing,
    byPurpose,
  };
}

function isVerifiedWebEntry(entry: EvidenceLedgerEntry): boolean {
  return Boolean(
    entry.verified &&
    (entry.kind === "web_source" || entry.kind === "browser_page") &&
    entry.metadata?.sourceKind !== "search_index",
  );
}

function ledgerToEvidenceItem(entry: EvidenceLedgerEntry): BroadEvidenceItem {
  return {
    kind: "current_web",
    source: entry.kind,
    tool: entry.tool,
    verified: entry.verified,
    summary: entry.summary,
    outputPreview: entry.excerpts[0] || entry.summary,
    url: /^https?:\/\//i.test(entry.canonicalLocator) ? entry.canonicalLocator : undefined,
    path: entry.kind === "repo_file" ? entry.canonicalLocator : undefined,
  };
}

export function mergeBroadEvidenceWithModelToolLedger(
  pack: BroadEvidencePack,
  modelLedger: EvidenceLedgerEntry[] | undefined,
): BroadEvidencePack {
  const incoming = modelLedger ?? [];
  if (incoming.length === 0) return pack;
  const existingLedger = pack.ledger ?? [];
  const seen = new Set(existingLedger.map((entry) => `${entry.tool}:${entry.canonicalLocator}:${entry.argsHash}`));
  const additions = incoming.filter((entry) => {
    const key = `${entry.tool}:${entry.canonicalLocator}:${entry.argsHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (additions.length === 0) return pack;

  const ledger = [...existingLedger, ...additions];
  const addedItems = additions.map(ledgerToEvidenceItem);
  const taskSpec = pack.diagnostics?.taskSpec as { requiredSourcePurposes?: ResearchSourcePurpose[] } | undefined;
  const sourcePurposeCoverage = taskSpec?.requiredSourcePurposes
    ? buildSourcePurposeCoverage(ledger, taskSpec.requiredSourcePurposes)
    : pack.metrics.sourcePurposeCoverage;
  const metrics = {
    ...pack.metrics,
    webSearches: pack.metrics.webSearches + additions.filter((entry) => entry.tool === "web_search").length,
    urlsFetched: ledger.filter(isVerifiedWebEntry).length,
    filesRead: pack.metrics.filesRead + additions.filter((entry) => entry.kind === "repo_file" && entry.tool === "read_file").length,
    memoryReads: pack.metrics.memoryReads + additions.filter((entry) => entry.kind === "memory").length,
    ...(sourcePurposeCoverage ? { sourcePurposeCoverage } : {}),
  };

  return {
    ...pack,
    ledger,
    items: [...pack.items, ...addedItems],
    metrics,
    diagnostics: {
      ...(pack.diagnostics ?? {}),
      modelLedToolEvidenceMerged: additions.length,
      modelLedVerifiedWebSources: additions.filter(isVerifiedWebEntry).length,
      ...(sourcePurposeCoverage ? { sourcePurposeCoverage } : {}),
    },
    promptBlock: [
      pack.promptBlock,
      "",
      "Additional model-led tool evidence merged after preflight:",
      ...addedItems.slice(0, 12).map(formatEvidenceItem),
    ].join("\n"),
  };
}

function formatEvidenceItem(item: BroadEvidenceItem): string {
  return `[${item.tool}] ${item.summary}\n${item.outputPreview.slice(0, 800)}`;
}

function cleanSearchTopic(value: string): string {
  return value
    .replace(/\b(?:summari[sz]e|include|with)\b[\s\S]*$/i, "")
    .replace(/\b(?:source\s+links?|links?|urls?)\b[\s\S]*$/i, "")
    .replace(/[.?!]\s*$/g, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function collectWorkflowDesignEvidence(params: {
  sessionId: string;
  agentId: string;
  message: string;
  onEmit?: EmitFn;
}): Promise<BroadEvidencePack> {
  const items: BroadEvidenceItem[] = [];
  let appRegistryReads = 0;

  try {
    const { executeTool } = await import("@/lib/engine/tools");

    // 1. Read node registry
    params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name: "read_file", args: { path: "src/lib/engine/node-registry.ts" } });
    const nodeRegistry = await executeTool("read_file", { path: "src/lib/engine/node-registry.ts" }, { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true });
    appRegistryReads++;
    items.push({
      kind: "workflow_registry",
      source: "node-registry.ts",
      tool: "read_file",
      verified: true,
      summary: "Node type registry with ~52 node types across 10 categories",
      outputPreview: nodeRegistry.slice(0, 1600),
      path: "src/lib/engine/node-registry.ts",
    });
    params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "read_file", resultPreview: nodeRegistry.slice(0, 200) });

    // 2. Read the action planner for available actions
    params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name: "read_file", args: { path: "src/lib/channels/app-action-planner.ts" } });
    const actionPlanner = await executeTool("read_file", { path: "src/lib/channels/app-action-planner.ts" }, { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true });
    appRegistryReads++;
    items.push({
      kind: "app_tool_catalog",
      source: "app-action-planner.ts",
      tool: "read_file",
      verified: true,
      summary: "App action planner with structured action kinds",
      outputPreview: actionPlanner.slice(0, 1600),
      path: "src/lib/channels/app-action-planner.ts",
    });
    params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "read_file", resultPreview: actionPlanner.slice(0, 200) });

    // 3. Read system map for tool catalog
    params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name: "read_file", args: { path: "src/lib/channels/disp8ch-system-map.ts" } });
    const systemMap = await executeTool("read_file", { path: "src/lib/channels/disp8ch-system-map.ts" }, { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true });
    appRegistryReads++;
    items.push({
      kind: "app_tool_catalog",
      source: "disp8ch-system-map.ts",
      tool: "read_file",
      verified: true,
      summary: "System map with app surfaces, node vocabulary, tool catalog, and template catalog",
      outputPreview: systemMap.slice(0, 1600),
      path: "src/lib/channels/disp8ch-system-map.ts",
    });
    params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "read_file", resultPreview: systemMap.slice(0, 200) });

    // 4. Workflow template catalog
    const templates = listWorkflowTemplateCatalog();
    const templateItems = templates.slice(0, 10).map((t) => `${t.key}: ${t.name}`).join("\n");
    items.push({
      kind: "workflow_registry",
      source: "template-catalog",
      tool: "workflow_templates",
      verified: true,
      summary: `${templates.length} workflow templates available`,
      outputPreview: templateItems,
    });

    // 5. Tool catalog summary
    const toolNames = Object.keys(TOOL_CATALOG).filter((n) => TOOL_CATALOG[n]);
    const toolItems = toolNames.slice(0, 25).map((n) => `- ${n}: ${TOOL_CATALOG[n].description}`).join("\n");
    items.push({
      kind: "app_tool_catalog",
      source: "TOOL_CATALOG",
      tool: "tools_catalog",
      verified: true,
      summary: `${toolNames.length} tools available in TOOL_CATALOG`,
      outputPreview: toolItems,
    });

  } catch (error) {
    // Best-effort: continue with whatever we collected
  }

  const promptBlock = [
    "Workflow design evidence (verified app state):",
    ...items.map(formatEvidenceItem),
    "",
    "Use this real disp8ch AI node/tool/registry vocabulary for the design.",
    "Do not invent node names — only use nodes from the registry or explicitly label unknown ones.",
  ].join("\n");

  return {
    decision: {
      kind: "app_workflow_design",
      confidence: "high",
      evidenceNeeds: ["workflow_registry", "app_tool_catalog"],
      mustUseTools: true,
      mustNotUseTools: false,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Workflow design evidence collected",
    },
    items,
    promptBlock,
    metrics: {
      webSearches: 0,
      urlsFetched: 0,
      filesRead: appRegistryReads,
      appRegistryReads,
      benchmarkFilesRead: 0,
      memoryReads: 0,
    },
  };
}

export async function collectCurrentWebEvidence(params: {
  sessionId: string;
  agentId: string;
  message: string;
  onEmit?: EmitFn;
}): Promise<BroadEvidencePack> {
  const taskSpec = classifyResearchTaskSpec(params.message);
  const result = await runWebResearch({
    message: params.message,
    sessionId: params.sessionId,
    agentId: params.agentId,
    mode: "thorough",
    onEmit: params.onEmit,
  });
  const items = result.ledger.map((entry): BroadEvidenceItem => ({
    kind: "current_web",
    source: entry.kind,
    tool: entry.tool,
    verified: entry.verified,
    summary: entry.summary,
    outputPreview: entry.excerpts[0] || entry.summary,
    url: /^https?:\/\//i.test(entry.canonicalLocator) ? entry.canonicalLocator : undefined,
  }));
  const webSearches = result.metrics.searches;
  const urlsFetched = result.ledger.filter(isVerifiedWebEntry).length;
  const sourcePurposeCoverage = buildSourcePurposeCoverage(result.ledger, taskSpec.requiredSourcePurposes);

  const isPublicDiscussion = taskSpec.constraints.includes("public discussion") || /public\s+discussion|community\s+discussion|people\s+(?:say|think|report)/i.test(params.message);
  const sourceCategoryGuide = isPublicDiscussion
    ? [
        "Source category targeting for public discussion:",
        "- Official project docs/repo: the project's own README, documentation site, and main repository.",
        "- GitHub issues/discussions/releases: search for relevant issue threads, release notes, and community discussions.",
        "- Community forum/dev community: Reddit, Hacker News, StackOverflow, and Discord where available.",
        "- Independent blog/news: third-party analysis, reviews, and comparison articles.",
        "- Avoid treating search index pages as citations — every URL must be a content page.",
        "- Require at least 2 verified non-search sources or include an explicit weak-evidence limitation.",
        "- Date every current-source claim with retrieved or published/updated date when available.",
      ].join("\n")
    : "";

  const promptBlock = [
    taskSpec.requiredAnswerSections.length > 0 || taskSpec.requiredSourcePurposes.length > 1
      ? [
          "Web research task contract:",
          `- Task kind: ${taskSpec.taskKind}`,
          `- Required source purposes: ${taskSpec.requiredSourcePurposes.join(", ")}`,
          taskSpec.mustMention.length > 0 ? `- Must address: ${taskSpec.mustMention.join(", ")}` : "",
          taskSpec.requiredAnswerSections.length > 0 ? `- Required answer sections:\n${taskSpecToAnswerSections(taskSpec)}` : "",
          "Separate official docs, model/runtime docs, community reports, and unknowns when those categories are requested.",
        ].filter(Boolean).join("\n")
      : "",
    "",
    sourceCategoryGuide,
    "",
    result.sourcePackForModel,
    "",
    "Use the verified evidence pack above as grounding.",
    "Do not copy evidence-pack headers or raw tool labels into the final answer.",
    "Cite only verified web_source/browser_page URLs. Search hints are discovery only.",
    urlsFetched < 3 ? "Fewer than 3 non-search-index sources were verified. If the prompt asks for themes, explicitly label the evidence as limited and include the search trail rather than inventing themes." : "",
  ].filter(Boolean).join("\n");

  return {
    decision: {
      kind: "web_research",
      confidence: "high",
      evidenceNeeds: ["current_web"],
      mustUseTools: true,
      mustNotUseTools: false,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Current web evidence collected",
    },
    items,
    ledger: result.ledger,
    promptBlock,
    metrics: {
      webSearches,
      urlsFetched,
      filesRead: 0,
      appRegistryReads: 0,
      benchmarkFilesRead: 0,
      memoryReads: 0,
      sourcePurposeCoverage,
    },
    diagnostics: {
      webResearch: result.diagnostics,
      taskSpec,
      sourcePurposeCoverage,
    },
  };
}

export async function collectCompositionContext(params: {
  sessionId: string;
  agentId: string;
  message: string;
}): Promise<BroadEvidencePack> {
  return {
    decision: {
      kind: "composition",
      confidence: "high",
      evidenceNeeds: ["none"],
      mustUseTools: false,
      mustNotUseTools: true,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Composition: no tools needed, use conversation history only",
    },
    items: [],
    promptBlock: "",
    metrics: {
      webSearches: 0,
      urlsFetched: 0,
      filesRead: 0,
      appRegistryReads: 0,
      benchmarkFilesRead: 0,
      memoryReads: 0,
    },
  };
}

export async function collectBroadEvidence(params: {
  decision: BroadTaskDecision;
  sessionId: string;
  agentId: string;
  message: string;
  onEmit?: EmitFn;
}): Promise<BroadEvidencePack> {
  switch (params.decision.kind) {
    case "app_workflow_design":
    case "app_workflow_edit":
      return collectWorkflowDesignEvidence({
        sessionId: params.sessionId,
        agentId: params.agentId,
        message: params.message,
        onEmit: params.onEmit,
      });
    case "web_research":
      return collectCurrentWebEvidence({
        sessionId: params.sessionId,
        agentId: params.agentId,
        message: params.message,
        onEmit: params.onEmit,
      });
    case "composition":
    case "transformation":
      return collectCompositionContext({
        sessionId: params.sessionId,
        agentId: params.agentId,
        message: params.message,
      });
    default:
      // For repo_plan, benchmark_comparison, memory_recall, etc.
      // return minimal pack — the existing repo-inspection lane handles these
      return {
        decision: params.decision,
        items: [],
        promptBlock: "",
        metrics: {
          webSearches: 0,
          urlsFetched: 0,
          filesRead: 0,
          appRegistryReads: 0,
          benchmarkFilesRead: 0,
          memoryReads: 0,
        },
      };
  }
}
