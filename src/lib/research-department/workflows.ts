import { nanoid } from "nanoid";
import type { WorkflowNode, WorkflowEdge } from "@/types/workflow";
import type {
  ResearchDepartmentTier,
  ResearchDepartmentWorkflowKind,
  ResearchSourceConfig,
} from "./types";
import type { VaultPaths } from "./vault";

// Workflow graph builders for a research department.
//
// IMPORTANT: every workflow is composed exclusively from generic, reusable node
// types (cron-trigger, manual-trigger, system-command, run-code, if-else,
// rss-read, http-request, read-file, write-file, claude-agent, send-webchat).
// There are no research-department-specific node types or runtime branches — the
// "department" is just a configured arrangement of the standard n8n-style nodes.

export interface DepartmentWorkflowGraph {
  kind: ResearchDepartmentWorkflowKind;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowBuildContext {
  departmentId?: string;
  departmentName: string;
  focusArea: string;
  tier: ResearchDepartmentTier;
  sources: ResearchSourceConfig;
  paths: VaultPaths;
  agentIds: { scout?: string | null; analyst?: string | null; briefer?: string | null };
  deliveryChannelNode: string; // "send-webchat" | "send-telegram" | ...
  maxSourcesPerRun: number;
}

type RawNode = { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> };

function node(id: string, type: string, x: number, y: number, data: Record<string, unknown>): RawNode {
  return { id, type, position: { x, y }, data };
}

function edge(source: string, target: string, sourceHandle?: string): WorkflowEdge {
  const e: WorkflowEdge = { id: `e-${source}-${target}${sourceHandle ? `-${sourceHandle}` : ""}`, source, target };
  if (sourceHandle) e.sourceHandle = sourceHandle;
  return e;
}

// ── Reusable run-code snippets (no fs; operate on prior node output) ──────────

/** Normalize an array of raw items into one dated inbox markdown finding. */
function buildNormalizeCode(sourceType: string, maxItems: number): string {
  return `var items = (input && Array.isArray(input.items)) ? input.items : [];
var max = ${maxItems};
var picked = items.slice(0, max);
var now = new Date().toISOString();
var lines = [];
for (var i = 0; i < picked.length; i++) {
  var it = picked[i] || {};
  var url = it.link || it.url || it.id || "";
  var title = (it.title || "Untitled").toString().replace(/\\s+/g, " ").trim();
  var body = (it.summary || it.abstract || it.content || "").toString().trim();
  lines.push("---");
  lines.push('source_url: "' + url + '"');
  lines.push('source_type: "${sourceType}"');
  lines.push('captured_at: "' + now + '"');
  lines.push('agent: "Scout"');
  lines.push("---");
  lines.push("");
  lines.push("# " + title);
  lines.push("");
  lines.push(body);
  lines.push("");
}
var day = now.slice(0, 10);
var filename = day + "-${sourceType}-" + Math.random().toString(36).slice(2, 8) + ".md";
result = { count: picked.length, markdown: lines.join("\\n"), filename: filename, hasItems: picked.length > 0 };`;
}

/** Inbox preflight: read a system-command list-files result, count .md files. */
function buildPreflightCode(): string {
  return `var listing = (input && Array.isArray(input.fileListing)) ? input.fileListing : [];
var files = listing.filter(function (name) {
  return typeof name === "string" && /\\.md$/i.test(name) && name.indexOf("[DIR]") !== 0;
});
var day = new Date().toISOString().slice(0, 10);
result = { wakeAgent: files.length > 0, count: files.length, files: files, day: day };`;
}

/** Tiny date helper: exposes a Windows-safe YYYY-MM-DD day via {{run.result.day}}. */
function buildDayCode(): string {
  return `result = { day: new Date().toISOString().slice(0, 10) };`;
}

function buildBriefNormalizerCode(): string {
  return `const raw = String(input.response || "").trim();
const usage = String((input.rows && input.rows[0] && input.rows[0].line) || "").trim();
const lines = raw.split(/\\r?\\n/);
const itemPattern = /^\\s*(?:[-*•]\\s+|(?:[*_]{2}\\s*)?\\d+[.)]\\s+)(.+)$/;
const allowedTag = /\\[(verified|likely|unverified|conflicting)\\]/i;
const items = [];
for (const line of lines) {
  const match = line.match(itemPattern);
  if (!match) continue;
  let content = String(match[1] || "").replace(/\\*\\*/g, "").trim();
  if (!content) continue;
  if (!allowedTag.test(content)) content = "[unverified] " + content;
  items.push(content);
  if (items.length >= 5) break;
}
if (items.length === 0) {
  const fallback = raw
    .replace(/^#{1,6}\\s+.*$/gm, "")
    .replace(/^(?:i\\s+(?:see|will|have|can)|let\\s+me|here(?:'s| is)|the brief)\\b[^.!?]*[.!?]\\s*/i, "")
    .split(/\\r?\\n+|(?<=[.!?])\\s+/)
    .map((part) => part.trim())
    .find(Boolean);
  items.push("[unverified] " + (fallback || "No new qualifying findings. Action: check Scout schedules."));
}
const briefLines = items.map((item, index) => String(index + 1) + ". " + item);
if (usage) briefLines.push("", usage);
result = { brief: briefLines.join("\\n"), bulletCount: items.length, usageLine: usage };`;
}

// ── Trigger pairs ─────────────────────────────────────────────────────────────

function triggerPair(cronExpr: string, cronLabel: string): { nodes: RawNode[]; cronId: string; manualId: string } {
  const cronId = nanoid(8);
  const manualId = nanoid(8);
  return {
    cronId,
    manualId,
    nodes: [
      node(cronId, "cron-trigger", 100, 120, { label: cronLabel, expression: cronExpr }),
      node(manualId, "manual-trigger", 100, 280, { label: "Manual / Test Run" }),
    ],
  };
}

// ── Scout: RSS / web ─────────────────────────────────────────────────────────

export function buildScoutRssWorkflow(ctx: WorkflowBuildContext): DepartmentWorkflowGraph {
  const { cronId, manualId, nodes: trig } = triggerPair("0 7 * * *", "Daily 7 AM");
  const feed = ctx.sources.rssFeeds[0] || "https://hnrss.org/frontpage";
  const rssId = nanoid(8);
  const normId = nanoid(8);
  const writeId = nanoid(8);
  const sendId = nanoid(8);

  const nodes: RawNode[] = [
    ...trig,
    node(rssId, "rss-read", 360, 200, { label: "Fetch RSS Feed", url: feed, limit: ctx.maxSourcesPerRun, sinceHours: 48 }),
    node(normId, "run-code", 620, 200, { label: "Normalize To Finding", timeout: 5000, code: buildNormalizeCode("rss", ctx.maxSourcesPerRun) }),
    node(writeId, "write-file", 880, 200, {
      label: "Write Inbox Finding",
      path: `${ctx.paths.inbox}/{{run.result.filename}}`,
      content: "{{run.result.markdown}}",
      mode: "overwrite",
    }),
    node(sendId, ctx.deliveryChannelNode, 1140, 200, { label: "Confirm Capture", message: "Scout captured {{run.result.count}} RSS item(s) into the research inbox.", format: "markdown" }),
  ];
  const edges: WorkflowEdge[] = [
    edge(cronId, rssId), edge(manualId, rssId),
    edge(rssId, normId), edge(normId, writeId), edge(writeId, sendId),
  ];
  return { kind: "scout_rss", name: `${ctx.departmentName} — Scout RSS`, description: `Scout RSS source gathering for "${ctx.focusArea}".`, nodes: nodes as unknown as WorkflowNode[], edges };
}

// ── Scout: arXiv ─────────────────────────────────────────────────────────────

export function buildScoutArxivWorkflow(ctx: WorkflowBuildContext): DepartmentWorkflowGraph {
  const { cronId, manualId, nodes: trig } = triggerPair("0 7 * * *", "Daily 7 AM");
  const category = ctx.sources.arxivCategories[0] || "cs.AI";
  const feed = /^https?:/i.test(category) ? category : `http://export.arxiv.org/rss/${category}`;
  const rssId = nanoid(8);
  const normId = nanoid(8);
  const writeId = nanoid(8);
  const sendId = nanoid(8);

  const nodes: RawNode[] = [
    ...trig,
    node(rssId, "rss-read", 360, 200, { label: "Fetch arXiv Feed", url: feed, limit: ctx.maxSourcesPerRun, sinceHours: 24 }),
    node(normId, "run-code", 620, 200, { label: "Normalize Papers", timeout: 5000, code: buildNormalizeCode("arxiv", ctx.maxSourcesPerRun) }),
    node(writeId, "write-file", 880, 200, {
      label: "Write Inbox Finding",
      path: `${ctx.paths.inbox}/{{run.result.filename}}`,
      content: "{{run.result.markdown}}",
      mode: "overwrite",
    }),
    node(sendId, ctx.deliveryChannelNode, 1140, 200, { label: "Confirm Capture", message: "Scout captured {{run.result.count}} arXiv paper(s).", format: "markdown" }),
  ];
  const edges: WorkflowEdge[] = [
    edge(cronId, rssId), edge(manualId, rssId),
    edge(rssId, normId), edge(normId, writeId), edge(writeId, sendId),
  ];
  return { kind: "scout_arxiv", name: `${ctx.departmentName} — Scout arXiv`, description: `Daily arXiv scan for "${ctx.focusArea}".`, nodes: nodes as unknown as WorkflowNode[], edges };
}

// ── Scout: competitor diff (advanced) ────────────────────────────────────────

export function buildCompetitorDiffWorkflow(ctx: WorkflowBuildContext): DepartmentWorkflowGraph {
  const { cronId, manualId, nodes: trig } = triggerPair("0 9 * * *", "Daily 9 AM");
  const url = ctx.sources.competitorUrls[0] || "https://example.com/";
  const fetchId = nanoid(8);
  const readSnapId = nanoid(8);
  const diffId = nanoid(8);
  const gateId = nanoid(8);
  const writeSnapId = nanoid(8);
  const writeDiffId = nanoid(8);
  const doneId = nanoid(8);

  // Hash + compare against previous snapshot. Zero model calls on either path.
  const diffCode = `var current = (input && (input.bodyText || input.body || "")) || "";
var prior = (input && input.content) || "";
function hash(s){var h=0;for(var i=0;i<s.length;i++){h=((h<<5)-h+s.charCodeAt(i))|0;}return String(h);}
var curHash = hash(String(current));
var priorHash = hash(String(prior));
var changed = prior.length === 0 ? false : curHash !== priorHash;
var now = new Date().toISOString();
var md = "---\\nsource_url: \\"${url}\\"\\nsource_type: \\"competitor-diff\\"\\ncaptured_at: \\"" + now + "\\"\\nagent: \\"Scout\\"\\n---\\n\\n# Competitor change detected\\n\\nPrevious hash: " + priorHash + "\\nCurrent hash: " + curHash + "\\n\\n## Raw changed content\\n\\n" + String(current).slice(0, 4000);
result = { wakeAgent: changed, curHash: curHash, snapshot: String(current).slice(0, 20000), markdown: md, filename: now.slice(0,10) + "-competitor-diff.md" };`;

  const nodes: RawNode[] = [
    ...trig,
    node(fetchId, "http-request", 360, 200, { label: "Fetch Competitor Page", method: "GET", url }),
    node(readSnapId, "read-file", 600, 200, { label: "Read Prior Snapshot", path: `${ctx.paths.snapshots}/competitor.txt` }),
    node(diffId, "run-code", 840, 200, { label: "Hash + Diff", timeout: 5000, code: diffCode }),
    node(gateId, "if-else", 1080, 200, { label: "Changed?", condition: "result_wakeAgent == true" }),
    node(writeDiffId, "write-file", 1320, 120, { label: "Write Diff To Inbox", path: `${ctx.paths.inbox}/{{run.result.filename}}`, content: "{{run.result.markdown}}", mode: "overwrite" }),
    node(writeSnapId, "write-file", 1320, 360, { label: "Update Snapshot (no model)", path: `${ctx.paths.snapshots}/competitor.txt`, content: "{{run.result.snapshot}}", mode: "overwrite" }),
    node(doneId, "set-variables", 1560, 360, { label: "Unchanged — End", assignments: [{ key: "wakeAgent", value: "false" }] }),
  ];
  const edges: WorkflowEdge[] = [
    edge(cronId, fetchId), edge(manualId, fetchId),
    edge(fetchId, readSnapId), edge(readSnapId, diffId), edge(diffId, gateId),
    edge(gateId, writeDiffId, "true"),
    edge(gateId, doneId, "false"),
    edge(writeDiffId, writeSnapId),
  ];
  return { kind: "scout_competitor_diff", name: `${ctx.departmentName} — Competitor Diff`, description: "Snapshot/diff competitor pages; wake an agent only on change.", nodes: nodes as unknown as WorkflowNode[], edges };
}

// ── Analyst: inbox processing ────────────────────────────────────────────────

export function buildAnalystInboxWorkflow(ctx: WorkflowBuildContext): DepartmentWorkflowGraph {
  const { cronId, manualId, nodes: trig } = triggerPair("0 10 * * *", "Daily 10 AM");
  const listId = nanoid(8);
  const preflightId = nanoid(8);
  const gateId = nanoid(8);
  const analystId = nanoid(8);
  const readId = nanoid(8);
  const writeId = nanoid(8);
  const moveId = nanoid(8);
  const sendId = nanoid(8);
  const skipId = nanoid(8);

  // Directory-mode loading gives the model every bounded input in one
  // synthesis pass and avoids unnecessary per-file discovery calls.
  const analystPrompt = `You are the Analyst. {{run.result.count}} new inbox finding(s) are provided below, already loaded for you.

=== INBOX FINDINGS ===
{{read.content}}
=== END FINDINGS ===

Synthesize these into structured wiki notes written with your write_file tool under ${ctx.paths.wikiSynthesis} (one note per topic). Flag contradictions against existing notes by writing a contradiction note under ${ctx.paths.wikiContradictions} instead of overwriting. Every factual claim MUST carry exactly one confidence tag — [verified], [likely], [unverified], or [conflicting] — and a source citation (the source_url from the finding). Do not analyze files you were not given. Never delete anything. Finish with a 2-3 sentence synthesis summary as your reply.`;

  const nodes: RawNode[] = [
    ...trig,
    node(listId, "system-command", 360, 200, { label: "List Inbox", command: "list-files", action: "list-files", path: ctx.paths.inbox, maxEntries: 100 }),
    node(preflightId, "run-code", 600, 200, { label: "Inbox Preflight Gate", timeout: 5000, code: buildPreflightCode() }),
    node(gateId, "if-else", 840, 200, { label: "Inbox Has Files?", condition: "result_wakeAgent == true" }),
    node(readId, "read-file", 1080, 120, { label: "Load Inbox Content", path: ctx.paths.inbox, ext: "md", maxFiles: 25, maxBytes: 8000 }),
    node(analystId, "claude-agent", 1320, 120, {
      label: "Analyst Synthesis",
      agentId: ctx.agentIds.analyst || undefined,
      systemPrompt: analystPrompt,
      temperature: 0.3,
      maxTokens: 2400,
      maxToolCalls: 96,
      modelLedLane: "broad_research",
      accuracyMode: "thorough",
      maxExpandedToolBudget: 96,
      turnDeadlineMs: 180000,
      enabledTools: ["write_file", "documents_search", "memory_search"],
    }),
    node(writeId, "write-file", 1560, 120, { label: "Archive Synthesis Summary", path: `${ctx.paths.wikiSynthesis}/{{run.result.day}}-summary.md`, content: "{{agent.response}}", mode: "append" }),
    node(moveId, "system-command", 1800, 120, {
      label: "Move Inbox To Processed",
      command: "move-files",
      action: "move-files",
      sourcePath: ctx.paths.inbox,
      targetPath: ctx.paths.processed,
      allowedRoot: ctx.paths.root,
      ext: "md",
      maxFiles: 100,
    }),
    node(sendId, ctx.deliveryChannelNode, 2040, 120, { label: "Notify Summary", message: "Analyst processed {{run.result.count}} inbox finding(s); moved {{move.movedCount}} file(s) to processed.", format: "markdown" }),
    node(skipId, "set-variables", 1080, 360, { label: "Empty Inbox — Skip (zero model calls)", assignments: [{ key: "skipped", value: "true" }] }),
  ];
  const edges: WorkflowEdge[] = [
    edge(cronId, listId), edge(manualId, listId),
    edge(listId, preflightId), edge(preflightId, gateId),
    edge(gateId, readId, "true"),
    edge(gateId, skipId, "false"),
    edge(readId, analystId), edge(analystId, writeId), edge(preflightId, moveId), edge(writeId, moveId), edge(moveId, sendId),
  ];
  return { kind: "analyst_inbox", name: `${ctx.departmentName} — Analyst Inbox`, description: "Wake-gated inbox synthesis: empty inbox makes zero model calls; findings are pre-loaded for single-pass synthesis.", nodes: nodes as unknown as WorkflowNode[], edges };
}

// ── Analyst: weekly deep synthesis (advanced) ────────────────────────────────

export function buildWeeklySynthesisWorkflow(ctx: WorkflowBuildContext): DepartmentWorkflowGraph {
  const { cronId, manualId, nodes: trig } = triggerPair("0 15 * * 5", "Friday 3 PM");
  const dayId = nanoid(8);
  const readId = nanoid(8);
  const analystId = nanoid(8);
  const writeId = nanoid(8);
  const sendId = nanoid(8);

  const prompt = `You are the Analyst running a weekly deep synthesis. This week's wiki notes are provided below.

=== WIKI NOTES ===
{{read.content}}
=== END NOTES ===

Identify patterns, trends, gaps, and contradictions across these notes. Produce a weekly synthesis that references the source notes, with an "Open Questions" section and an "Opportunities / Actions" section. Do not duplicate a prior weekly synthesis. Reply with the full synthesis markdown.`;

  const nodes: RawNode[] = [
    ...trig,
    node(dayId, "run-code", 340, 200, { label: "Today", timeout: 3000, code: buildDayCode() }),
    node(readId, "read-file", 580, 200, { label: "Load Wiki Notes", path: ctx.paths.wikiSynthesis, ext: "md", maxFiles: 40, maxBytes: 6000, sort: "newest" }),
    node(analystId, "claude-agent", 840, 200, { label: "Weekly Synthesis", agentId: ctx.agentIds.analyst || undefined, systemPrompt: prompt, temperature: 0.4, maxTokens: 2600, enabledTools: ["write_file", "documents_search"] }),
    node(writeId, "write-file", 1120, 200, { label: "Write Weekly Synthesis", path: `${ctx.paths.wikiSynthesis}/{{run.result.day}}-weekly.md`, content: "{{agent.response}}", mode: "overwrite" }),
    node(sendId, ctx.deliveryChannelNode, 1380, 200, { label: "Notify Weekly", message: "Weekly synthesis complete.", format: "markdown" }),
  ];
  const edges: WorkflowEdge[] = [
    edge(cronId, dayId), edge(manualId, dayId),
    edge(dayId, readId), edge(readId, analystId), edge(analystId, writeId), edge(writeId, sendId),
  ];
  return { kind: "analyst_weekly_synthesis", name: `${ctx.departmentName} — Weekly Synthesis`, description: "Friday deep synthesis across the week's wiki notes.", nodes: nodes as unknown as WorkflowNode[], edges };
}

// ── Briefer: morning brief ───────────────────────────────────────────────────

export function buildBrieferMorningWorkflow(ctx: WorkflowBuildContext): DepartmentWorkflowGraph {
  const { cronId, manualId, nodes: trig } = triggerPair("0 8 * * *", "Daily 8 AM");
  const dayId = nanoid(8);
  const readId = nanoid(8);
  const usageId = nanoid(8);
  const recallId = nanoid(8);
  const brieferId = nanoid(8);
  const normalizeId = nanoid(8);
  const archiveId = nanoid(8);
  const sendId = nanoid(8);

  // Basic tier has no Analyst/wiki — Briefer reads the inbox directly.
  const sourceDir = ctx.tier === "basic" ? ctx.paths.inbox : ctx.paths.wikiSynthesis;
  const departmentIdSql = String(ctx.departmentId || "").replace(/'/g, "''");
  const usageQuery = `SELECT 'Usage: ' || printf('%,d', COALESCE(SUM(e.tokens_used), 0)) || ' tokens / $' || printf('%.2f', COALESCE(SUM(e.cost_usd), 0.0)) || ' across ' || COUNT(e.id) || ' call(s) in the last 7 day(s).' AS line FROM research_department_members m LEFT JOIN agent_spend_events e ON e.agent_id = m.agent_id AND e.created_at >= datetime('now', '-7 days') WHERE m.department_id = '${departmentIdSql}'`;
  // The recent notes are pre-loaded and injected, so the Briefer needs no file
  // tools — it composes the brief in a single pass (fast, no tool-budget churn).
  // Real weekly token/cost comes from a generic read-only database-query node.
  // This avoids fixed ports and internal HTTP auth while keeping the workflow
  // composed entirely from reusable nodes.
  const prompt = `You are the Briefer. Today is {{run.result.day}}. The recent research notes are provided below.

=== RECENT NOTES ===
{{read.content}}
=== END NOTES ===

Goals/boards memory context: {{memory.memoriesText}}

Real usage this week (use VERBATIM as the final line): {{nodes.fetch_weekly_usage.rows.0.line}}

Produce a prioritized morning brief of 1 to 5 numbered bullets. The first character of your response MUST be "1"; do not greet, explain your process, introduce the list, or add a heading. Each bullet must be one single paragraph and must include: a confidence tag ([verified]/[likely]/[unverified]/[conflicting]), the finding, why it matters, and a suggested action. Start with the most important item. Do not use nested bullets, sub-bullets, tables, or extra list markers inside a bullet. Do not include items older than 48 hours unless flagged [urgent]. If there are no qualifying notes, return one [unverified] bullet saying there are no new qualifying findings and suggest checking Scout schedules. End with the real usage line provided above. Reply with ONLY the numbered items and usage line.`;

  const nodes: RawNode[] = [
    ...trig,
    node(dayId, "run-code", 340, 200, { label: "Today", timeout: 3000, code: buildDayCode() }),
    node(readId, "read-file", 560, 200, { label: "Load Recent Notes", path: sourceDir, ext: "md", maxFiles: 12, maxBytes: 4000, sort: "newest" }),
    node(usageId, "database-query", 780, 200, { label: "Fetch Weekly Usage", query: usageQuery }),
    node(recallId, "memory-recall", 1000, 200, { label: "Recall Goals/Boards", query: ctx.focusArea, limit: 5 }),
    node(brieferId, "claude-agent", 1240, 200, { label: "Compose Brief", agentId: ctx.agentIds.briefer || undefined, systemPrompt: prompt, temperature: 0.1, maxTokens: 1200, enabledTools: [] }),
    node(normalizeId, "run-code", 1480, 200, { label: "Enforce Brief Contract", timeout: 5000, code: buildBriefNormalizerCode() }),
    node(archiveId, "write-file", 1720, 200, { label: "Archive Brief", path: `${ctx.paths.wikiBriefs}/{{run.result.day}}.md`, content: "{{run.result.brief}}", mode: "overwrite" }),
    node(sendId, ctx.deliveryChannelNode, 1960, 200, { label: "Deliver Brief", message: "{{run.result.brief}}", format: "markdown" }),
  ];
  const edges: WorkflowEdge[] = [
    edge(cronId, dayId), edge(manualId, dayId),
    edge(dayId, readId), edge(readId, usageId), edge(usageId, recallId), edge(recallId, brieferId),
    edge(brieferId, normalizeId), edge(usageId, normalizeId), edge(normalizeId, archiveId), edge(archiveId, sendId),
  ];
  return { kind: "briefer_morning", name: `${ctx.departmentName} — Morning Brief`, description: "Daily 5-bullet brief from the wiki (or inbox on Basic tier).", nodes: nodes as unknown as WorkflowNode[], edges };
}

// ── Tier assembly ────────────────────────────────────────────────────────────

export function buildDepartmentWorkflows(ctx: WorkflowBuildContext): DepartmentWorkflowGraph[] {
  const graphs: DepartmentWorkflowGraph[] = [];
  // Scout sources (all tiers get at least one source workflow).
  if (ctx.sources.rssFeeds.length > 0 || ctx.sources.keywords.length > 0) {
    graphs.push(buildScoutRssWorkflow(ctx));
  }
  if (ctx.sources.arxivCategories.length > 0) {
    graphs.push(buildScoutArxivWorkflow(ctx));
  }
  if (graphs.length === 0) {
    // Always have at least one Scout workflow.
    graphs.push(buildScoutRssWorkflow(ctx));
  }

  if (ctx.tier !== "basic") {
    graphs.push(buildAnalystInboxWorkflow(ctx));
  }
  if (ctx.tier === "advanced") {
    if (ctx.sources.competitorUrls.length > 0) {
      graphs.push(buildCompetitorDiffWorkflow(ctx));
    }
    graphs.push(buildWeeklySynthesisWorkflow(ctx));
  }
  graphs.push(buildBrieferMorningWorkflow(ctx));
  return graphs;
}

// ── Reusable structural validator ────────────────────────────────────────────

export interface GraphValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Lightweight, DB-free structural validation: at least one trigger, every edge
 * references existing nodes, no orphan non-trigger nodes, and no trivial cycle.
 * Mirrors the engine linter's structural rules so templates can be tested without
 * a database.
 */
export function validateGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]): GraphValidation {
  const errors: string[] = [];
  const ids = new Set(nodes.map((n) => n.id));
  const triggers = nodes.filter((n) => String(n.type || "").includes("trigger"));
  if (triggers.length === 0) errors.push("No trigger node.");

  for (const e of edges) {
    if (!ids.has(e.source)) errors.push(`Edge source missing: ${e.source}`);
    if (!ids.has(e.target)) errors.push(`Edge target missing: ${e.target}`);
  }

  const hasInbound = new Set(edges.map((e) => e.target));
  const hasOutbound = new Set(edges.map((e) => e.source));
  for (const n of nodes) {
    const isTrigger = String(n.type || "").includes("trigger");
    if (!isTrigger && !hasInbound.has(n.id)) {
      errors.push(`Orphan node (no inbound edge): ${n.id} (${n.type})`);
    }
    if (isTrigger && !hasOutbound.has(n.id)) {
      errors.push(`Trigger has no outbound edge: ${n.id}`);
    }
  }

  // Cycle detection (DFS).
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) adj.get(e.source)?.push(e.target);
  const visited = new Set<string>();
  const stack = new Set<string>();
  const visit = (id: string): boolean => {
    visited.add(id);
    stack.add(id);
    for (const next of adj.get(id) || []) {
      if (!visited.has(next)) {
        if (visit(next)) return true;
      } else if (stack.has(next)) {
        return true;
      }
    }
    stack.delete(id);
    return false;
  };
  for (const n of nodes) {
    if (!visited.has(n.id) && visit(n.id)) {
      errors.push("Cycle detected.");
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}
