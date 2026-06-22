import type { BroadEvidencePack } from "@/lib/channels/broad-evidence-controller";
import type { BroadTaskDecision, BroadTaskKind } from "@/lib/channels/broad-task-decision";
import { hasLeakedToolMarkup } from "@/lib/channels/tool-markup-guard";
import { isRawCliHelpOrToolDump } from "@/lib/channels/tool-output-sanitizer";
import { hasInternalEvidenceLeak } from "@/lib/channels/final-answer-sanitizer";
import { normalizeUrlForCitation, validateCitations } from "@/lib/channels/evidence-ledger-v2";
import { verifyClaimsAgainstEvidence, verifyLocalModelSetupClaimsAgainstEvidence } from "@/lib/channels/claim-evidence-verifier";
import { isSearchIndexUrl } from "@/lib/channels/web/source-candidate-ranker";
import { classifyResearchTaskSpec } from "@/lib/channels/web-research-task-spec";
import { evaluateWebResearchCoverage } from "@/lib/channels/web-research-coverage-contract";
import type { ResearchSourcePurpose } from "@/lib/channels/web-research-task-spec";

export type BroadContractIssue =
  | "wrong_task_kind"
  | "missing_requested_sections"
  | "workflow_boilerplate_for_non_workflow_prompt"
  | "unverified_search_claim"
  | "unverified_inspection_claim"
  | "unverified_file_path"
  | "invented_node_name"
  | "fake_source_citation"
  | "mutation_in_readonly_answer"
  | "too_shallow"
  | "tool_markup_leak"
  | "raw_tool_output"
  | "internal_evidence_leak"
  | "missing_link_count"
  | "missing_exact_item_count"
  | "missing_line_count"
  | "missing_source_dating"
  | "underused_verified_sources"
  | "unsupported_claim";

export type BroadAnswerContractResult = {
  ok: boolean;
  issues: BroadContractIssue[];
  repairInstruction: string;
  evidenceContractOk: boolean;
};

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Section checks ──

function extractExactCount(message: string): { lines?: number; items?: number; links?: number; bullets?: number } | null {
  const result: { lines?: number; items?: number; links?: number; bullets?: number } = {};
  const lineMatch = message.match(/\b(\d+)[-\s]?(?:line|sentence)s?\b/i);
  if (lineMatch) result.lines = Number(lineMatch[1]);
  const itemMatch = message.match(/\b(?:exactly\s+)?(\d+)\s+(?:items?|findings?|bullet|themes?)\b/i);
  if (itemMatch) result.items = Number(itemMatch[1]);
  const linkMatch = message.match(/\b(?:at\s+least\s+)?(\d+)\s+(?:links?|sources?|url)\b/i);
  if (linkMatch) result.links = Number(linkMatch[1]);
  const bulletMatch = message.match(/\b(\d+)\s+(?:bullet|commit\s+bullet)\b/i);
  if (bulletMatch) result.bullets = Number(bulletMatch[1]);
  return Object.keys(result).length > 0 ? result : null;
}

function countLines(answer: string): number {
  return answer.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function countNumberedItems(answer: string): number {
  return answer.split(/\r?\n/).filter((line) => /^\s*(?:\d+\.|[-*]\s)/.test(line)).length;
}

function countOrderedItems(answer: string): number {
  return answer.split(/\r?\n/).filter((line) => /^\s*(?:#{1,6}\s*)?\d+\.\s/.test(line)).length;
}

function countLinks(answer: string): number {
  const urls = answer.match(/https?:\/\/[^\s)]+/g);
  return urls ? urls.length : 0;
}

function countWordsText(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function markdownSectionBodies(answer: string): string[] {
  const lines = answer.split(/\r?\n/);
  const bodies: string[] = [];
  let current: string[] = [];
  let seenHeading = false;
  for (const line of lines) {
    if (/^\s*#{1,6}\s+\S/.test(line)) {
      if (seenHeading) bodies.push(current.join("\n").trim());
      seenHeading = true;
      current = [];
      continue;
    }
    if (seenHeading) current.push(line);
  }
  if (seenHeading) bodies.push(current.join("\n").trim());
  return bodies.filter(Boolean);
}

function isShallowWebResearchAnswer(answer: string, message: string, spec: ReturnType<typeof classifyResearchTaskSpec>, verifiedSourceCount: number): boolean {
  const words = countWordsText(answer);
  const publicDiscussionOnly = spec.constraints.includes("public discussion") && spec.requiredAnswerSections.length === 0;
  const complexResearch =
    spec.requiredAnswerSections.length >= 3 ||
    (spec.requiredSourcePurposes.length >= 3 && !publicDiscussionOnly) ||
    /\b(?:recommend|setup|tradeoffs?|risks?|failure|compare|best practical|source categor|official|community)\b/i.test(message);

  if (complexResearch && words < 450) return true;
  if (verifiedSourceCount >= 3 && words < 180) return true;

  const bodies = markdownSectionBodies(answer);
  if (complexResearch && bodies.length >= 3) {
    const hasDenseResearchStructure =
      words >= 650 &&
      /\n\|.+\|\n\|[ :|-]+\|/i.test(answer) &&
      /(?:source\s+categor|official\s+(?:docs?|source)|community\s+(?:report|source)|unknowns?|source\s+gaps?)/i.test(answer);
    if (hasDenseResearchStructure) return false;
    const thinSections = bodies.filter((body) => countWordsText(body) < 35).length;
    if (thinSections >= Math.ceil(bodies.length / 2)) return true;
  }

  return false;
}

function requestedSections(message: string): string[] {
  const sections: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/\bfiles?\b/i, "files"],
    [/\brisks?\b/i, "risks"],
    [/\btests?\b/i, "tests"],
    [/\bacceptance\s+criteria\b/i, "acceptance criteria"],
    [/\btrigger\b/i, "trigger"],
    [/\bnodes?\b/i, "nodes"],
    [/\bdata\s+flow\b/i, "data flow"],
    [/\berror\s+handling\b/i, "error handling"],
    [/\bdependency\b/i, "dependency"],
    [/\bimplementation\s+(?:steps?|plan)\b/i, "implementation steps"],
  ];
  for (const [pattern, section] of checks) {
    if (pattern.test(message)) sections.push(section);
  }
  if (/implementation plan|upgrade plan|fix plan|improvement plan/i.test(message)) {
    sections.push("files", "risks", "tests", "acceptance criteria");
  }
  return unique(sections);
}

function sectionPattern(section: string): RegExp {
  const aliases: Record<string, string> = {
    files: "(?:files?|files?\\s+to\\s+touch|implementation\\s+target)",
    risks: "risks?",
    tests: "tests?",
    "acceptance criteria": "acceptance\\s+criteria",
    nodes: "nodes?",
  };
  return new RegExp(`\\b${aliases[section] ?? section.replace(/\\s+/g, "\\s+")}\\b`, "i");
}

// ── Verification checks ──

function hasUnverifiedSearchClaim(answer: string, evidence?: BroadEvidencePack): boolean {
  if (!evidence || evidence.metrics.webSearches === 0) {
    return /\b(?:I\s+(?:searched|found|looked|checked)\b|search\s+results?\s+(?:show|indicate|suggest)|according\s+to\s+(?:my|the)\s+search)/i.test(answer);
  }
  return false;
}

function hasUnverifiedInspectionClaim(answer: string, evidence?: BroadEvidencePack): boolean {
  if (!evidence || evidence.metrics.filesRead === 0) {
    return /\b(?:I\s+(?:inspected|examined|reviewed|audited|read|checked|verified|confirmed)\b)/i.test(answer);
  }
  return false;
}

function hasWorkflowBoilerplateForNonWorkflow(answer: string, decision: BroadTaskDecision): boolean {
  if (decision.kind === "app_workflow_design" || decision.kind === "app_workflow_edit" || decision.kind === "repo_plan") return false;
  const wfTerms = /(?:workflow\s+template|node\s+type|trigger\s+node|cron-trigger|message-trigger|run-code\s+node|http-request\s+node|send-webchat\s+node|board-task\s+node|implementation\s+plan\s+template)/i;
  return wfTerms.test(answer) && decision.kind === "composition";
}

function hasInventedNodeName(answer: string): boolean {
  const realNodes = /cron-trigger|message-trigger|webhook-trigger|manual-trigger|run-code|http-request|read-file|write-file|system-command|send-webchat|send-telegram|send-discord|send-whatsapp|send-slack|send-bluebubbles|send-teams|send-email|if-else|switch|filter|loop|aggregate|merge|delay|set-variables|memory-recall|memory-store|claude-agent|parallel-agents|call-workflow|board-task|document-tool|workflow-template|scheduler-job|date-time|channel-status|council|voice-stt|voice-tts|error-handler|wait-for-input|rate-limiter|json-transform|split-text|regex-extract|compare-text|database-query|clipboard|notification|git-operation|archive|api-monitor|devops-monitor|scheduled-health-check|research-assistant|live-research-assistant|general-task-executor/i;
  const candidates = [
    ...Array.from(answer.matchAll(/`([a-z]+(?:-[a-z]+)+)`/gi), (match) => {
      const index = match.index ?? 0;
      const context = answer.slice(Math.max(0, index - 80), index + match[0].length + 80);
      if (!/\b(?:node|trigger|tool|workflow\s+node|node\s+type|visual\s+workflow)\b/i.test(context)) return "";
      return /\b(?:template|board|board\s+id|workflow\s+name|task\s+name|slug|id)\b/i.test(context) ? "" : match[1];
    }),
    ...Array.from(answer.matchAll(/\b([a-z]+(?:-[a-z]+)+)\s+(?:node|trigger|tool)\b/g), (match) => match[1]),
  ].filter(Boolean);
  return candidates.some((phrase) => !realNodes.test(phrase));
}

function isExampleUrl(url: string): boolean {
  // Example commands (localhost curl, host.docker.internal, example.com) are not citations.
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|example\.(?:com|org|net))(?::\d+)?(?:\/|$)/i.test(url);
}

function hasFakeSourceCitation(answer: string, evidence?: BroadEvidencePack): boolean {
  if (evidence?.ledger?.length) {
    return !validateCitations(answer, evidence.ledger).ok;
  }
  const allUrls = answer.match(/https?:\/\/[^\s)]+/g) ?? [];
  const citationUrls = allUrls.filter((url) => !isExampleUrl(url));
  if (!evidence || evidence.metrics.urlsFetched === 0) {
    return citationUrls.length > 0;
  }
  const fetchedUrls = (evidence.items ?? [])
    .filter((item) => item.url)
    .map((item) => normalizeUrlForCitation(item.url as string));
  return citationUrls.some((url) => {
    if (isSearchIndexUrl(url) && !/\b(?:search\s+lead|discovery\s+lead|search\s+page)\b/i.test(answer)) return true;
    const cited = normalizeUrlForCitation(url);
    return !fetchedUrls.some((fetched) => cited === fetched || cited.startsWith(`${fetched}/`) || fetched.startsWith(`${cited}/`));
  });
}

function hasMutationInReadonly(answer: string, decision: BroadTaskDecision): boolean {
  if (!decision.readOnly) return false;
  const actualMutationClaim =
    /\bI\s+(?:created|scheduled|saved|ran|executed|sent|imported|installed)\s+(?:a|the)?\s*(?:workflow|cron|task|message|file|board)\b/i.test(answer) ||
    /^\s*(?:Created|Scheduled|Saved|Ran|Executed|Sent|Imported|Installed)\s+(?:a|the)?\s*(?:workflow|cron|task|message|file|board)\b/im.test(answer) ||
    /\b(?:workflow|cron|task|message|file|board)\s+(?:was|has been)\s+(?:created|scheduled|saved|ran|executed|sent|imported|installed)\b/i.test(answer);
  const boundaryDisclosed =
    /\b(?:not|nothing)\s+(?:created|scheduled|saved|ran|executed|sent|imported|installed)\b/i.test(answer) ||
    /\b(?:before|until)\s+(?:this|the)?\s*(?:workflow|cron|task|message|file|board)?\s*(?:is\s+)?(?:created|scheduled|saved|ran|executed|sent|imported|installed)[\s\S]{0,80}\b(?:confirm|approve|approval)\b/i.test(answer);
  return actualMutationClaim && !boundaryDisclosed;
}

function hasCurrentSourceDating(answer: string): boolean {
  return /\b(?:source\s+date|published|updated|retrieved|accessed|date\s+unknown)\b/i.test(answer) ||
    /\b(?:20\d{2}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+20\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d{2})\b/i.test(answer);
}

function verifiedNonSearchWebSources(evidence?: BroadEvidencePack): number {
  return (evidence?.ledger ?? []).filter((entry) =>
    entry.verified &&
    (entry.kind === "web_source" || entry.kind === "browser_page") &&
    entry.metadata?.sourceKind !== "search_index",
  ).length;
}

function verifiedWebSourceUrls(evidence?: BroadEvidencePack): string[] {
  return (evidence?.ledger ?? [])
    .filter((entry) =>
      entry.verified &&
      (entry.kind === "web_source" || entry.kind === "browser_page") &&
      entry.metadata?.sourceKind !== "search_index" &&
      /^https?:\/\//i.test(entry.canonicalLocator),
    )
    .map((entry) => normalizeUrlForCitation(entry.canonicalLocator))
    .filter((url, index, all) => all.indexOf(url) === index);
}

function evidenceRepairContext(evidence?: BroadEvidencePack): string {
  if (!evidence) return "";
  const verified = (evidence.ledger ?? []).filter((entry) => entry.verified);
  if (verified.length === 0) return "";
  const sources = verified
    .filter((entry) => entry.kind === "web_source" || entry.kind === "browser_page" || entry.kind === "repo_file" || entry.kind === "document")
    .slice(0, 8)
    .map((entry, index) => {
      const label = entry.title ? `${entry.title} — ${entry.canonicalLocator}` : entry.canonicalLocator;
      const summary = entry.summary.replace(/\s+/g, " ").slice(0, 180);
      return `${index + 1}. ${entry.kind}: ${label}${summary ? ` :: ${summary}` : ""}`;
    });
  if (sources.length === 0) return "";
  return [
    `Evidence already collected: ${verified.length} verified item(s), ${evidence.metrics.webSearches} web search(es), ${evidence.metrics.urlsFetched} fetched/opened URL(s), ${evidence.metrics.filesRead} file read(s).`,
    "Use these concrete evidence items in the repaired answer instead of adding more caveats:",
    ...sources,
  ].join("\n");
}

function buildIssueSpecificRepairInstruction(
  issues: BroadContractIssue[],
  evidence?: BroadEvidencePack,
): string {
  if (issues.length === 0) return "";

  const parts: string[] = [];
  const issueSet = new Set(issues);

  if (issueSet.has("underused_verified_sources")) {
    const verifiedUrls = verifiedWebSourceUrls(evidence);
    const count = Math.min(3, verifiedUrls.length);
    parts.push(
      `You have ${verifiedUrls.length} verified source(s) but underused them. Cite at least ${count} verified URLs/source titles from the evidence:`,
      ...verifiedUrls.slice(0, count).map((url, i) => `  ${i + 1}. ${url}`),
    );
  }

  if (issueSet.has("too_shallow")) {
    parts.push(
      "The answer is too shallow for this prompt. Add at least one concrete mechanism, command, risk, test, or source-to-claim mapping. Expand thin sections with evidence-backed detail. Name specific sources, files, or functions from evidence.",
    );
  }

  if (issueSet.has("missing_source_dating")) {
    parts.push(
      "Add retrieved/source dates beside every current-claim group using the format: 'source date YYYY-MM-DD' or 'retrieved YYYY-MM-DD quoted below'.",
    );
  }

  if (issueSet.has("missing_requested_sections")) {
    const spec = classifyResearchTaskSpec(""); // Not the best but we use section misses
    const missingSections = spec.requiredAnswerSections.length > 0
      ? spec.requiredAnswerSections.join(", ")
      : "requested sections";
    parts.push(
      `Add explicitly the required sections: ${missingSections}. Each section must have substantive content, not just a one-line placeholder.`,
    );
  }

  if (issueSet.has("unverified_file_path")) {
    parts.push(
      "Remove or label as 'candidate' any file path that is not supported by read_file evidence. Only claim file behavior from files that were actually read.",
    );
  }

  if (issueSet.has("unsupported_claim")) {
    parts.push(
      "Replace unsupported claims with verified source-backed wording or move them to an Unknowns/Inferences section. Do not invent or overstate what the evidence supports.",
    );
  }

  if (issueSet.has("fake_source_citation")) {
    parts.push(
      "Remove any citation URL that was not actually fetched/verified. Search-index URLs are discovery leads, not verified sources.",
    );
  }

  if (issueSet.has("missing_link_count")) {
    parts.push(
      `Include at least the requested number of verified source links. Available verified sources: ${verifiedWebSourceUrls(evidence).length}. Cite them explicitly.`,
    );
  }

  if (issueSet.has("tool_markup_leak") || issueSet.has("raw_tool_output") || issueSet.has("internal_evidence_leak")) {
    parts.push(
      "Remove all raw tool syntax, XML, DSML, internal evidence IDs, and CLI help output. Write natural user-facing text only.",
    );
  }

  if (issueSet.has("mutation_in_readonly_answer")) {
    parts.push(
      "Do not claim to have created, saved, scheduled, executed, or modified anything. This is a read-only response. Use 'would', 'proposed', or 'recommended' language.",
    );
  }

  if (issueSet.has("unverified_search_claim")) {
    parts.push(
      "Do not claim to have searched or found information without tool evidence. Remove 'I searched...' or 'search results show...' claims if no web_search tool was run.",
    );
  }

  if (issueSet.has("unverified_inspection_claim")) {
    parts.push(
      "Do not claim to have inspected/read/audited files without file-read evidence. Remove 'I inspected...' claims if no read_file tool was run. Label file behavior claims as 'candidate' when the file was not read.",
    );
  }

  if (issueSet.has("workflow_boilerplate_for_non_workflow_prompt")) {
    parts.push(
      "Remove workflow-boilerplate sections. This is not a workflow design prompt. Do not list node types, trigger nodes, or workflow template patterns.",
    );
  }

  // Group top evidence items for any repair
  if (evidence?.ledger?.length) {
    const groupedEvidence = groupTopEvidenceItems(evidence);
    if (groupedEvidence.length > 0) {
      parts.push("", "Top evidence items to use in repair:", ...groupedEvidence);
    }
  }

  return parts.join("\n");
}

function groupTopEvidenceItems(evidence: BroadEvidencePack): string[] {
  const verified = (evidence.ledger ?? []).filter((e) => e.verified);
  if (verified.length === 0) return [];

  const lines: string[] = [];
  const webSources = verified.filter((e) => e.kind === "web_source" || e.kind === "browser_page").slice(0, 3);
  if (webSources.length > 0) {
    lines.push("Verified web sources:");
    for (const src of webSources) {
      lines.push(`  - ${src.title || src.canonicalLocator}: ${src.canonicalLocator}`);
    }
  }

  const repoFiles = verified.filter((e) => e.kind === "repo_file").slice(0, 3);
  if (repoFiles.length > 0) {
    lines.push("Read repo files:");
    for (const src of repoFiles) {
      const meta = [];
      if (typeof src.metadata?.lineCount === "number") meta.push(`${src.metadata.lineCount} lines`);
      if (Array.isArray(src.metadata?.symbols)) meta.push(`symbols: ${src.metadata.symbols.slice(0, 5).join(", ")}`);
      lines.push(`  - ${src.canonicalLocator}${meta.length > 0 ? ` (${meta.join("; ")})` : ""}`);
    }
  }

  const errors = (evidence?.ledger ?? []).filter((e) => e.kind === "tool_error").slice(0, 2);
  if (errors.length > 0) {
    lines.push("Tool errors / unavailable evidence:");
    for (const err of errors) {
      lines.push(`  - ${err.locator}: ${err.summary.slice(0, 120)}`);
    }
  }

  return lines;
}

// ── Main evaluation ──

export function evaluateBroadAnswerContract(input: {
  answer: string;
  userMessage: string;
  decision: BroadTaskDecision;
  evidence?: BroadEvidencePack;
  conversationHistory?: string;
}): BroadAnswerContractResult {
  const answer = input.answer.trim();
  const message = input.userMessage;
  const decision = input.decision;
  const issues: BroadContractIssue[] = [];

  // Always check for leaks
  if (hasLeakedToolMarkup(answer)) issues.push("tool_markup_leak");
  if (isRawCliHelpOrToolDump(answer)) issues.push("raw_tool_output");
  if (hasInternalEvidenceLeak(answer)) issues.push("internal_evidence_leak");
  if (input.evidence?.ledger?.length) {
    const claimCheck = verifyClaimsAgainstEvidence(answer, input.evidence.ledger);
    const limitationOnly = /(?:could\s+not\s+verify|cannot\s+fully\s+verify|insufficient\s+sources|verified\s+source:\s+none|search\s+leads?\s+were\s+not\s+enough)/i.test(answer);
    if (!claimCheck.ok && !limitationOnly) issues.push("unsupported_claim");
  }

  // Task-kind specific checks
  switch (decision.kind) {
    case "composition": {
      // Must not be a workflow plan
      if (hasWorkflowBoilerplateForNonWorkflow(answer, decision)) {
        issues.push("workflow_boilerplate_for_non_workflow_prompt");
      }
      // Exact count checks
      const counts = extractExactCount(message);
      if (counts?.lines && countLines(answer) !== counts.lines) {
        issues.push("missing_line_count");
      }
      if (counts?.bullets && countNumberedItems(answer) !== counts.bullets) {
        issues.push("missing_exact_item_count");
      }
      // Must be concise for "draft a N-line" prompts
      if (/\b\d+-line\b/i.test(message) && answer.split(/\s+/).filter(Boolean).length > 300) {
        issues.push("too_shallow");
      }
      break;
    }

    case "transformation": {
      const counts = extractExactCount(message);
      if (counts?.lines && countLines(answer) !== counts.lines) {
        issues.push("missing_line_count");
      }
      if (counts?.bullets && countNumberedItems(answer) !== counts.bullets) {
        issues.push("missing_exact_item_count");
      }
      break;
    }

    case "web_research": {
      // Must have links if requested
      const counts = extractExactCount(message);
      const taskSpec = classifyResearchTaskSpec(message);
      if (counts?.links && countLinks(answer) < counts.links) {
        issues.push("missing_link_count");
      }
      if (counts?.items && countOrderedItems(answer) !== counts.items) {
        issues.push("missing_exact_item_count");
      }
      // No unverified search claims
      if (hasUnverifiedSearchClaim(answer, input.evidence)) {
        issues.push("unverified_search_claim");
      }
      // No fake citations
      if (hasFakeSourceCitation(answer, input.evidence)) {
        issues.push("fake_source_citation");
      }
      // Source dating for current claims
      if (/(?:current|latest|recent|today)\b/i.test(message) && !hasCurrentSourceDating(answer)) {
        issues.push("missing_source_dating");
      }
      // ── Hardened source verification (Part 6) ──
      // Require at least one web_search unless prompt includes direct URLs
      const hasDirectUrls = /https?:\/\/\S+/.test(message);
      const isPublicDiscussion = /(?:public\s+discussion|community\s+reaction|people\s+saying|sources?\s+links?|top\s+\d+\s+themes?)/i.test(message);
      const hasLimitedEvidenceNote = /(?:limited\s+evidence|cannot\s+fully\s+verify|could\s+not\s+verify|insufficient\s+sources|only\s+\d+\s+source|search\s+results\s+indicate|evidence\s+is\s+weak)/i.test(answer);
      const verifiedUrls = verifiedWebSourceUrls(input.evidence);
      if (input.evidence) {
        if (input.evidence.metrics.webSearches === 0 && !hasDirectUrls) {
          issues.push("unverified_search_claim");
        }
        // For public-discussion prompts, require at least 2 verified sources
        if (isPublicDiscussion && verifiedNonSearchWebSources(input.evidence) < 2 && !hasLimitedEvidenceNote) {
          issues.push("missing_link_count");
        }
        if (isPublicDiscussion && verifiedUrls.length >= 2) {
          const citedVerifiedCount = verifiedUrls.filter((url) => answer.includes(url)).length;
          if (citedVerifiedCount < 2 || /Verified source:\s*none/i.test(answer)) {
            issues.push("underused_verified_sources");
          }
        }
        if (!isPublicDiscussion && verifiedUrls.length >= 3 && !hasLimitedEvidenceNote) {
          const citedVerifiedCount = verifiedUrls.filter((url) => answer.includes(url)).length;
          if (citedVerifiedCount < Math.min(3, verifiedUrls.length)) {
            issues.push("underused_verified_sources");
          }
        }
      }
      if (isShallowWebResearchAnswer(answer, message, taskSpec, verifiedUrls.length)) {
        issues.push("too_shallow");
      }
      // Reject answers that claim "I searched" with no tool evidence
      if (hasUnverifiedSearchClaim(answer, input.evidence)) {
        issues.push("unverified_search_claim");
      }
      // If fewer than 2 sources verified for public discussion, require explicit disclaimer
      if (input.evidence && verifiedNonSearchWebSources(input.evidence) < 2 && isPublicDiscussion) {
        if (!hasLimitedEvidenceNote) {
          issues.push("missing_source_dating");
        }
      }
      // ── Web-research coverage contract ──
      if (taskSpec.requiredSourcePurposes.length > 1 || taskSpec.requiredAnswerSections.length > 0) {
        const evidencePurposes: ResearchSourcePurpose[] = Array.from(new Set(
          (input.evidence?.ledger ?? [])
            .filter((entry) => entry.verified)
            .map((entry) => (entry.metadata?.sourcePurpose as ResearchSourcePurpose) ?? "generic"),
        ));
        const coverage = evaluateWebResearchCoverage(taskSpec, answer, evidencePurposes);
        if (!coverage.pass) {
          issues.push("missing_requested_sections");
          if (coverage.missingMustMention.length > 0) {
            issues.push("unverified_search_claim");
          }
        }
        // ── Local-model setup claim-family citation discipline ──
        if (taskSpec.taskKind === "local_model_setup" && input.evidence?.ledger?.length) {
          const localModelClaim = verifyLocalModelSetupClaimsAgainstEvidence(answer, input.evidence.ledger);
          if (!localModelClaim.ok) {
            issues.push("unsupported_claim");
          }
        }
      }
      break;
    }

    case "repo_plan": {
      // Required sections
      const sections = requestedSections(message);
      const missingSections = sections.filter((s) => !sectionPattern(s).test(answer));
      if (missingSections.length > 0) {
        issues.push("missing_requested_sections");
      }
      // Unverified claims
      if (hasUnverifiedInspectionClaim(answer, input.evidence)) {
        issues.push("unverified_inspection_claim");
      }
      // File paths must come from evidence or be clearly proposed
      if (input.evidence && input.evidence.metrics.filesRead > 0) {
        const evidencePaths = (input.evidence.items ?? [])
          .filter((item) => item.path)
          .map((item) => item.path as string);
        const citedPaths = answer.match(/\b(?:src|app|lib|docs|scripts|data)\/[A-Za-z0-9._/-]+/g) ?? [];
        for (const citedPath of citedPaths) {
          const isProposed = new RegExp(`(?:proposed|new|create|add|candidate|would\\s+add)\\s[^\\n]{0,80}${escapeRegExp(citedPath)}`, "i").test(answer);
          const isVerified = evidencePaths.some((ep) => citedPath.includes(ep) || ep.includes(citedPath));
          if (!isVerified && !isProposed) {
            issues.push("unverified_file_path");
            break;
          }
        }
      }
      // Too shallow check
      if (sections.length >= 2 && answer.split(/\s+/).filter(Boolean).length < 200) {
        issues.push("too_shallow");
      }
      break;
    }

    case "app_workflow_design": {
      // Required sections for workflow designs
      const sections = ["trigger", "nodes", "data flow", "risks", "tests"];
      const missingSections = sections.filter((s) => !sectionPattern(s).test(answer));
      if (missingSections.length > 0) {
        issues.push("missing_requested_sections");
      }
      // No invented node names
      if (hasInventedNodeName(answer)) {
        issues.push("invented_node_name");
      }
      // No mutation claims in read-only
      if (hasMutationInReadonly(answer, decision)) {
        issues.push("mutation_in_readonly_answer");
      }
      // Too shallow
      if (answer.split(/\s+/).filter(Boolean).length < 250) {
        issues.push("too_shallow");
      }
      break;
    }

    case "app_workflow_edit": {
      // No section/length requirements — the tool result should drive the answer.
      // No invented node names
      if (hasInventedNodeName(answer)) {
        issues.push("invented_node_name");
      }
      // No mutation claims in read-only
      if (hasMutationInReadonly(answer, decision)) {
        issues.push("mutation_in_readonly_answer");
      }
      break;
    }

    case "safe_action_plan": {
      if (hasMutationInReadonly(answer, decision)) {
        issues.push("mutation_in_readonly_answer");
      }
      break;
    }
  }

  // Universal: mutation in read-only is always an issue
  if (decision.readOnly && hasMutationInReadonly(answer, decision) &&
    !issues.includes("mutation_in_readonly_answer")) {
    issues.push("mutation_in_readonly_answer");
  }

  const uniqueIssues = unique(issues);
  const evidenceContractOk = !uniqueIssues.some((i) =>
    ["unverified_search_claim", "unverified_inspection_claim", "unverified_file_path",
      "invented_node_name", "fake_source_citation", "missing_source_dating", "underused_verified_sources"].includes(i),
  );

  const sectionIssues = uniqueIssues.filter((i) =>
    ["missing_requested_sections", "missing_link_count", "missing_exact_item_count",
      "missing_line_count", "missing_source_dating", "underused_verified_sources"].includes(i),
  );

  const issueSpecific = buildIssueSpecificRepairInstruction(uniqueIssues, input.evidence);
  const repairInstruction = [
    "Broad answer contract failed.",
    `Issues: ${uniqueIssues.join(", ") || "none"}.`,
    evidenceRepairContext(input.evidence),
    decision.kind === "composition" ? "This is a composition task. Do not add workflow boilerplate, repo inspection, or app-design sections. Stay concise and match the requested format." : "",
    decision.kind === "transformation" ? "This is a transformation task. Edit only the content requested. Do not add new sections or tools." : "",
    decision.kind === "web_research" ? "This is a web research task. Cite only fetched/verified sources. Include source dates. Lead with the synthesized answer and named themes. Put limitations at the end unless evidence is genuinely absent." : "",
    decision.kind === "repo_plan" ? "This is a repo plan task. List concrete files to touch, risks, tests, and acceptance criteria. Use file paths and details from read evidence. Label unread targets as candidates." : "",
    decision.kind === "app_workflow_design" ? "This is an app workflow design task. Use real disp8ch AI node names from the registry. Include trigger, nodes, data flow, risks, and tests. Do not create/save/schedule anything." : "",
    decision.kind === "app_workflow_edit" ? "This is a workflow inspection or editing task. Use the workflow_* tool catalog (workflow_list, workflow_get, workflow_update_node, workflow_set_model, workflow_create_credential, workflow_attach_credential, workflow_update_schedule, workflow_toggle_active, workflow_duplicate, workflow_run, workflow_execution_status, workflow_delete). Always workflow_get before workflow_update_node. For missing credentials, create/store the credential only when the user supplied the secret, then attach the saved credential id. Report only what the tool returned. Do NOT output a workflow-design template (trigger/nodes/data flow/risks/tests sections)." : "",
    sectionIssues.length > 0 ? `Add missing sections/items: ${sectionIssues.join(", ")}. Match the requested count when one was specified.` : "",
    issueSpecific ? issueSpecific : "",
    "Repair the answer using only the evidence and format requested. Make it more specific by naming concrete files, URLs, source titles, functions, or components from evidence.",
    "Do not silently add sections the user did not ask for.",
    "Separate verified facts from assumptions. If evidence is insufficient, say so explicitly.",
  ].filter(Boolean).join("\n");

  return {
    ok: uniqueIssues.length === 0,
    issues: uniqueIssues,
    repairInstruction,
    evidenceContractOk,
  };
}

export function formatBroadContractRepairInstruction(result: BroadAnswerContractResult): string {
  if (result.ok) return "";
  return result.repairInstruction;
}

export function shouldAcceptRepairedAnswer(params: {
  originalResult: BroadAnswerContractResult;
  repairedResult: BroadAnswerContractResult;
  repairedLength: number;
  originalLength: number;
}): boolean {
  // Accept repaired answers only when the new contract passes
  return params.repairedResult.ok;
}
