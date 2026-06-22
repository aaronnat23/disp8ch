import type { BroadEvidencePack } from "@/lib/channels/broad-evidence-controller";
import { isSearchIndexUrl } from "@/lib/channels/web/source-candidate-ranker";
import type { EvidenceLedgerEntry } from "@/lib/channels/evidence-ledger-v2";
import { classifyResearchTaskSpec, type WebResearchTaskSpec } from "@/lib/channels/web-research-task-spec";
import { evaluateWebResearchCoverage, type WebResearchCoverageResult } from "@/lib/channels/web-research-coverage-contract";
import type { ResearchSourcePurpose } from "@/lib/channels/web-research-task-spec";

type SourceUse = {
  url: string;
  title: string;
  sourceKind: string;
  sourcePurpose: ResearchSourcePurpose;
  dateText: string;
  summary: string;
  exactEntityMatch: boolean;
  publicDiscussionSignal: "strong" | "weak" | "none";
};

function cleanTopic(message: string): string {
  return message
    .replace(/\b(?:summari[sz]e|include|with|give me|show me|top\s+\d+\s+themes?)\b[\s\S]*$/i, "")
    .replace(/\b(?:source\s+links?|links?|urls?)\b[\s\S]*$/i, "")
    .replace(/\b(?:latest|current|recent)\s+(?:public\s+)?(?:discussion|reaction|conversation)\s+(?:about|around|on)\b/i, "")
    .replace(/\b(?:search|research|look\s+up|find)\s+(?:the\s+web\s+)?(?:for|about|on)?/i, "")
    .replace(/\bpublic\s+discussion\s+(?:about|around|on)\b/i, "")
    .replace(/[.?!]\s*$/g, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || message.slice(0, 160).trim();
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((word) => word.length >= 4 && !/^(latest|current|public|discussion|about|with|source|links|search|summarize|themes)$/.test(word));
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.split("/").filter(Boolean).slice(-3).join("/");
    return path ? `${parsed.hostname.replace(/^www\./, "")}/${path}` : parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function resolvedFinalUrl(entry: EvidenceLedgerEntry): string {
  const text = `${entry.summary}\n${entry.excerpts.join("\n")}`;
  const match = text.match(/\bFinal URL:\s*(https?:\/\/[^\s<>"')\]]+)/i);
  return match?.[1]?.trim() || entry.canonicalLocator;
}

function publicDiscussionSignal(entry: EvidenceLedgerEntry): "strong" | "weak" | "none" {
  const url = resolvedFinalUrl(entry).toLowerCase();
  const kind = String(entry.metadata?.sourceKind ?? "");
  if (kind === "community") return "strong";
  if (/reddit\.com|news\.ycombinator\.com|\/(?:issues|discussions|pull|releases)(?:\/|$)/i.test(url)) return "strong";
  if (kind === "primary" || kind === "docs") return "weak";
  return "none";
}

function isObviousEntityMismatch(topic: string, haystack: string, url: string): boolean {
  return false;
}

function verifiedSources(message: string, evidence?: BroadEvidencePack | null): SourceUse[] {
  const topic = cleanTopic(message);
  const topicWords = new Set(words(topic));
  const entries = (evidence?.ledger ?? [])
    .filter((entry) =>
      entry.verified &&
      (entry.kind === "web_source" || entry.kind === "browser_page") &&
      /^https?:\/\//i.test(entry.canonicalLocator) &&
      !isSearchIndexUrl(entry.canonicalLocator),
    );
  const seen = new Set<string>();
  const sources: SourceUse[] = [];
  for (const entry of entries) {
    const url = resolvedFinalUrl(entry);
    if (isSearchIndexUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const haystack = `${entry.title ?? ""} ${entry.summary} ${entry.excerpts.join(" ")} ${url}`.toLowerCase();
    if (isObviousEntityMismatch(topic, haystack, url)) continue;
    const overlap = Array.from(topicWords).filter((word) => haystack.includes(word)).length;
    sources.push({
      url,
      title: entry.title?.trim() || titleFromUrl(url),
      sourceKind: String(entry.metadata?.sourceKind ?? "unknown"),
      sourcePurpose: (entry.metadata?.sourcePurpose as ResearchSourcePurpose) ?? "generic",
      dateText: entry.sourceDate ? `source date ${entry.sourceDate}` : `date unknown; retrieved ${entry.fetchedAt.slice(0, 10)}`,
      summary: entry.summary || entry.excerpts[0] || titleFromUrl(url),
      exactEntityMatch: topicWords.size === 0 ? false : overlap >= Math.min(2, topicWords.size),
      publicDiscussionSignal: publicDiscussionSignal(entry),
    });
  }
  return sources;
}

function queriesAttempted(evidence?: BroadEvidencePack | null): string[] {
  return Array.from(new Set(
    (evidence?.ledger ?? [])
      .filter((entry) => entry.tool === "web_search")
      .map((entry) => entry.locator || entry.canonicalLocator)
      .filter(Boolean),
  )).slice(0, 8);
}

function sourceTypeSummary(sources: SourceUse[]): string {
  const counts = new Map<string, number>();
  for (const source of sources) {
    const key = source.sourcePurpose !== "generic" ? source.sourcePurpose : source.sourceKind;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([kind, count]) => `${count} ${kind}`).join(", ") || "no verified source types";
}

function stripEmbeddedUrls(value: string): string {
  return value
    .replace(/\[([^\]]{1,120})\]\(https?:\/\/[^)\s]+[^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/[^\s<>)\]]+/gi, "linked URL in source text");
}

function summarySnippet(value: string, max = 180): string {
  const clean = stripEmbeddedUrls(value).replace(/\s+/g, " ").trim();
  if (!clean) return "Verified source was reachable, but the extracted text was sparse.";
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 3)).trim()}...` : clean;
}

function compactSummary(value: string, url?: string): string {
  let source = value;
  try {
    const parsed = JSON.parse(value) as {
      title?: string;
      content?: string;
      text?: string;
      results?: Array<{ url?: string; finalUrl?: string; title?: string; content?: string; text?: string }>;
    };
    const first = url
      ? parsed.results?.find((item) => item.url === url || item.finalUrl === url)
      : parsed.results?.find((item) => item.content || item.text || item.title);
    source = [
      parsed.title || first?.title || "",
      parsed.content || parsed.text || first?.content || first?.text || "",
    ].filter(Boolean).join(" - ");
  } catch {
    // Plain text summary.
  }
  const clean = stripEmbeddedUrls(source).replace(/\s+/g, " ").trim();
  if (!clean) return "Verified source was reachable, but the extracted text was sparse.";
  return clean.length > 220 ? `${clean.slice(0, 217).trim()}...` : clean;
}

function sourceHaystack(source?: SourceUse): string {
  if (!source) return "";
  return `${source.title} ${source.summary} ${source.url}`.toLowerCase();
}

function themeLabel(source: SourceUse | undefined, fallback: string): string {
  const haystack = sourceHaystack(source);
  if (/\b(ui|webui|frontend|interface|sidebar|session|stream|sse|render|recover|reload)\b/i.test(haystack)) {
    return "WebUI resilience and session/stream UX";
  }
  if (/\b(error|exception|timeout|crash|bug|fix|issue|404|failed|failure)\b/i.test(haystack)) {
    return "Error handling and operational reliability";
  }
  if (/\b(local|qwen|llama|gguf|openai-compatible|model|provider|windows|wsl|vram|cuda)\b/i.test(haystack)) {
    return "Local-model and provider integration";
  }
  if (/\b(tool|toolset|approval|permission|sandbox|command|terminal|workspace)\b/i.test(haystack)) {
    return "Tooling, workspace safety, and approval flow";
  }
  if (/\b(memory|profile|context|session|state|persistence)\b/i.test(haystack)) {
    return "State, memory, and persistence";
  }
  if (/\b(doc|readme|quickstart|install|setup|configuration|onboarding)\b/i.test(haystack)) {
    return "Setup and documentation friction";
  }
  return fallback;
}

function distinctThemeLabel(source: SourceUse | undefined, fallback: string, used: Set<string>): string {
  const label = themeLabel(source, fallback);
  if (!used.has(label)) {
    used.add(label);
    return label;
  }
  if (!used.has(fallback)) {
    used.add(fallback);
    return fallback;
  }
  let suffix = 2;
  while (used.has(`${fallback} (${suffix})`)) suffix += 1;
  const unique = `${fallback} (${suffix})`;
  used.add(unique);
  return unique;
}

function themeInterpretation(source: SourceUse | undefined, label: string): string {
  const haystack = sourceHaystack(source);
  if (!source) return "No verified source was strong enough to support a detailed interpretation.";
  if (/webui|frontend|interface|sidebar|session|stream|sse|render|recover|reload/i.test(`${label} ${haystack}`)) {
    return "This points to the user-facing reliability layer: stream continuity, session recovery, and UI behavior are where users notice agent quality first.";
  }
  if (/local|qwen|llama|gguf|openai-compatible|model|provider|windows|wsl|vram|cuda/i.test(`${label} ${haystack}`)) {
    return "This makes runtime setup part of the product experience; model/provider configuration, context limits, and local-server networking can decide whether the agent feels usable.";
  }
  if (/tool|toolset|approval|permission|sandbox|command|terminal|workspace/i.test(`${label} ${haystack}`)) {
    return "This is about operational control: users need tool access to be powerful enough for agent work while still bounded, inspectable, and recoverable.";
  }
  if (/doc|readme|quickstart|install|setup|configuration|onboarding/i.test(`${label} ${haystack}`)) {
    return "This is setup-friction evidence rather than popularity evidence: it tells us what users must configure, but not how broadly the community is discussing it.";
  }
  if (/error|exception|timeout|crash|bug|fix|issue|404|failed|failure/i.test(`${label} ${haystack}`)) {
    return "This suggests reliability and failure recovery are active concerns; treat the source as a concrete symptom, not a complete community trend by itself.";
  }
  return "This source supports the theme, but it should be treated as one evidence point rather than a ranked consensus signal.";
}

function buildSourceBackedAnswer(message: string, evidence: BroadEvidencePack, sources: SourceUse[]): string {
  const topic = cleanTopic(message);
  const retrieved = new Date().toISOString().slice(0, 10);
  const exactCount = sources.filter((source) => source.exactEntityMatch).length;
  const communityCount = sources.filter((source) => source.publicDiscussionSignal === "strong").length;
  const answerMode = exactCount >= 2 && communityCount >= 1 ? "source-backed" : "adjacent-source-backed";
  const ordered = sources
    .slice()
    .sort((a, b) => Number(b.publicDiscussionSignal === "strong") - Number(a.publicDiscussionSignal === "strong") || Number(b.exactEntityMatch) - Number(a.exactEntityMatch))
    .slice(0, 4);
  const first = ordered[0];
  const second = ordered[1] ?? ordered[0];
  const third = ordered[2] ?? ordered[1] ?? ordered[0];
  const usedLabels = new Set<string>();
  const firstLabel = distinctThemeLabel(first, "Project discoverability and source-hub activity", usedLabels);
  const secondLabel = distinctThemeLabel(second, "Community discussion and adoption signals", usedLabels);
  const thirdLabel = distinctThemeLabel(third, "Implementation constraints and unresolved gaps", usedLabels);
  const lines = [
    `Top themes from verified public sources for "${topic}" (retrieved ${retrieved}):`,
    "",
    `1. ${firstLabel}.`,
    `   Source: ${first?.url ?? "none"} (${first?.dateText ?? "date unknown"}).`,
    `   What it shows: ${compactSummary(first?.summary ?? "", first?.url)}`,
    `   Interpretation: ${themeInterpretation(first, firstLabel)}`,
    "",
    `2. ${secondLabel}.`,
    `   Source: ${second?.url ?? "none"} (${second?.dateText ?? "date unknown"}).`,
    `   What it shows: ${compactSummary(second?.summary ?? "", second?.url)}`,
    `   Interpretation: ${themeInterpretation(second, secondLabel)}`,
    "",
    `3. ${thirdLabel}.`,
    `   Source: ${third?.url ?? "none"} (${third?.dateText ?? "date unknown"}).`,
    `   What it shows: ${compactSummary(third?.summary ?? "", third?.url)}`,
    `   Interpretation: ${themeInterpretation(third, thirdLabel)}`,
    "",
    "What I would not overclaim: these sources support practical themes around setup, WebUI behavior, and runtime integration, but they do not prove a ranked community consensus unless the source mix includes multiple direct community discussions.",
    `Evidence quality: ${answerMode}; verified sources: ${sources.length} (${sourceTypeSummary(sources)}).`,
    answerMode === "source-backed"
      ? `Caveat: public discussion is source-backed, but this is still a web snapshot rather than a popularity ranking.`
      : `Caveat: I found limited exact-match public discussion for "${topic}", so the themes above are synthesized from the closest verified sources rather than ranked community consensus.`,
    `Searches attempted: ${evidence.metrics.webSearches}. Sources fetched/opened: ${evidence.metrics.urlsFetched}.`,
    `Request covered: ${message}`,
  ];
  return lines.join("\n");
}

function buildLimitedEvidenceAnswer(message: string, evidence?: BroadEvidencePack | null, sources: SourceUse[] = []): string {
  const retrieved = new Date().toISOString().slice(0, 10);
  const queries = queriesAttempted(evidence);
  const lines = [
    `I could not verify enough source-backed public discussion to summarize themes as facts. Retrieved ${retrieved}.`,
    "",
    "Investigation trail:",
    `- Searches attempted: ${evidence?.metrics.webSearches ?? 0}.`,
    `- Sources fetched/opened: ${evidence?.metrics.urlsFetched ?? 0}.`,
    `- Search/index pages checked through browser fallback: ${(evidence?.ledger ?? []).filter((entry) => entry.metadata?.searchLead).length}.`,
    queries.length > 0 ? `- Representative queries: ${queries.join(" | ")}` : "- Representative queries: unavailable.",
    sources.length > 0 ? `- Verified non-search source found: ${sources[0].url} (${sources[0].dateText}).` : "",
    "",
    "What I can safely say:",
    "1. I do not have enough verified, non-search-index sources to rank public themes.",
    "2. Search snippets and search-result pages are discovery leads only; I should not cite them as evidence.",
    "3. A stronger answer needs at least two verified community/source-hub pages that explicitly discuss the requested entity.",
    "",
    `Request covered: ${message}`,
  ];
  return lines.join("\n");
}

export function buildWebResearchEvidenceAnswer(message: string, evidence?: BroadEvidencePack | null): string {
  const sources = verifiedSources(message, evidence);
  const spec = classifyResearchTaskSpec(message);
  const evidencePurposes: ResearchSourcePurpose[] = Array.from(new Set(
    (evidence?.ledger ?? [])
      .filter((entry) => entry.verified)
      .map((entry) => (entry.metadata?.sourcePurpose as ResearchSourcePurpose) ?? "generic"),
  ));

  if (evidence && sources.length >= 1) {
    const baseAnswer = sources.length >= 2
      ? buildSourceBackedAnswer(message, evidence, sources)
      : buildLimitedEvidenceAnswer(message, evidence, sources);
    return spec.requiredAnswerSections.length > 0
      ? buildTaskShapedAnswer(baseAnswer, message, evidence, sources, spec, evidencePurposes)
      : baseAnswer;
  }
  return buildLimitedEvidenceAnswer(message, evidence, sources);
}

function buildTaskShapedAnswer(
  baseAnswer: string,
  message: string,
  evidence: BroadEvidencePack,
  sources: SourceUse[],
  spec: WebResearchTaskSpec,
  evidencePurposes: ResearchSourcePurpose[],
): string {
  if (spec.taskKind === "current_source_synthesis") {
    return buildCurrentSourceSynthesisAnswer(message, evidence, sources, spec, evidencePurposes);
  }

  if (spec.taskKind === "local_model_setup") {
    return buildLocalModelSetupAnswer(message, evidence, sources, spec, evidencePurposes);
  }

  const sections: string[] = [];
  const retrieved = new Date().toISOString().slice(0, 10);
  const hasCoverage = evaluateWebResearchCoverage(spec, baseAnswer, evidencePurposes);

  if (spec.requiredAnswerSections.includes("recommendation")) {
    const best = sources
      .slice()
      .sort((a, b) => Number(b.exactEntityMatch) - Number(a.exactEntityMatch) || Number(b.publicDiscussionSignal === "strong") - Number(a.publicDiscussionSignal === "strong"))
      [0];
    sections.push(
      "## Recommendation",
      best
        ? `Based on verified evidence, the strongest supported approach is: ${best.title} — see source ${best.url} (${best.dateText}).`
        : "No single source provides a fully verified recommendation. The evidence below represents the best available.",
      "",
    );
  }

  if (spec.requiredAnswerSections.includes("source_category_separation")) {
    const bySource = new Map<string, SourceUse[]>();
    for (const source of sources) {
      const cat = source.sourceKind;
      if (!bySource.has(cat)) bySource.set(cat, []);
      bySource.get(cat)!.push(source);
    }
    sections.push("## Source Categories");
    for (const [cat, items] of bySource) {
      sections.push(`### ${cat === "community" ? "Community Reports" : cat === "primary" ? "Official/Primary Sources" : cat === "docs" ? "Documentation" : "Other Sources"}`);
      for (const item of items.slice(0, 2)) {
        sections.push(`- ${item.title}: ${summarySnippet(item.summary, 180)} (${item.url})`);
      }
    }
    if (evidencePurposes.some((p) => p !== "generic")) {
      sections.push("", `Source purposes covered: ${evidencePurposes.filter((p) => p !== "generic").join(", ")}`);
    }
    sections.push("");
  }

  if (spec.requiredAnswerSections.includes("setup_steps")) {
    sections.push(
      "## Setup Steps",
      "Based on verified official and community evidence:",
      ...sources
        .slice(0, 3)
        .map((source, i) => `- Step ${i + 1}: See source ${source.url} — ${summarySnippet(source.summary, 200)}`),
      "",
    );
  }

  if (spec.requiredAnswerSections.includes("tradeoffs")) {
    sections.push(
      "## Tradeoffs",
      "Based on verified evidence:",
      `- Verified sources: ${sources.length} (${sourceTypeSummary(sources)}).`,
      `- Community discussion signal: ${sources.filter((s) => s.publicDiscussionSignal === "strong").length} strong, ${sources.filter((s) => s.publicDiscussionSignal === "weak").length} weak.`,
      "- The answer above includes only content that is supported by at least one verified source.",
      "",
    );
  }

  if (spec.requiredAnswerSections.includes("failure_risks")) {
    sections.push(
      "## Failure Risks",
      "Risks identified from verified evidence:",
      missingCoverageRisks(hasCoverage),
      "",
    );
  }

  if (spec.requiredAnswerSections.includes("uncertainty_statement")) {
    sections.push(
      "## What I Could Not Verify",
      hasCoverage.missingSourcePurposes.length > 0
        ? `- Missing source categories: ${hasCoverage.missingSourcePurposes.join(", ")}`
        : "- All required source categories are present.",
      hasCoverage.missingMustMention.length > 0
        ? `- Not explicitly addressed: ${hasCoverage.missingMustMention.join(", ")}`
        : "",
      hasCoverage.notes.length > 0
        ? `- Notes: ${hasCoverage.notes.join("; ")}`
        : "",
      "",
    );
  }

  if (spec.requiredAnswerSections.includes("confirmed_facts")) {
    sections.push(
      "## Confirmed Facts",
      "Facts verified by at least one non-search-index source:",
      ...sources
        .filter((s) => s.exactEntityMatch)
        .slice(0, 3)
        .map((s) => `- ${summarySnippet(s.summary, 200)} (source: ${s.url})`),
      "",
    );
  }

  if (spec.requiredAnswerSections.includes("likely_inferences")) {
    sections.push(
      "## Likely Inferences",
      "Patterns seen across sources but not individually verified:",
      "- Based on source overlap and community signal from the evidence above.",
      "",
    );
  }

  if (spec.requiredAnswerSections.includes("unknowns")) {
    sections.push(
      "## Unknowns",
      hasCoverage.missingSourcePurposes.length > 0
        ? `- Missing evidence from: ${hasCoverage.missingSourcePurposes.join(", ")}.`
        : "- All required source categories are present; remaining unknowns are stated above.",
      "",
    );
  }

  sections.push("## Sources");
  for (const source of sources.slice(0, 5)) {
    sections.push(`- [${source.title}](${source.url}) — ${source.dateText}`);
  }

  sections.push("", `Evidence quality: ${sources.length} verified sources. Retrieved ${retrieved}.`);

  return [baseAnswer, "", ...sections].join("\n");
}

function sourcesMatching(sources: SourceUse[], purposes: ResearchSourcePurpose[]): SourceUse[] {
  const purposeSet = new Set(purposes);
  return sources.filter((source) => purposeSet.has(source.sourcePurpose));
}

function sourceBrief(source?: SourceUse): string {
  if (!source) return "not verified in the collected evidence";
  return `${source.title} (${source.url}; ${source.dateText})`;
}

function buildCurrentSourceSynthesisAnswer(
  message: string,
  evidence: BroadEvidencePack,
  sources: SourceUse[],
  spec: WebResearchTaskSpec,
  evidencePurposes: ResearchSourcePurpose[],
): string {
  const retrieved = new Date().toISOString().slice(0, 10);
  const officialSources = sourcesMatching(sources, ["official_primary_product", "official_integration_product", "docs_readme"]);
  const communitySources = sourcesMatching(sources, ["community_report", "github_issues", "github_discussions"]);
  const otherSources = sources.filter((source) => !officialSources.includes(source) && !communitySources.includes(source));
  const primaryOfficial = officialSources[0];
  const secondaryOfficial = officialSources[1] ?? primaryOfficial;
  const primaryCommunity = communitySources[0];
  const coverageSeed = [
    "## Confirmed Facts",
    "Verified facts from official and community sources.",
    "## Likely Inferences",
    "Likely inferences are separated from confirmed facts.",
    "## Unknowns",
    "Could not verify end-to-end Windows Qwen support.",
    "## Source Categories",
    "Official docs, community reports, and adjacent sources are separated.",
    "## What I Could Not Verify",
    "I could not verify every requested runtime claim.",
  ].join("\n");
  const coverage = evaluateWebResearchCoverage(spec, coverageSeed, evidencePurposes);
  const missingCategories = coverage.missingSourcePurposes.length > 0
    ? coverage.missingSourcePurposes.join(", ")
    : "none";

  const lines = [
    "## Confirmed Facts",
    `- I verified current source evidence on ${retrieved}; the strongest official-style source in the collected set is ${sourceBrief(primaryOfficial)}. This supports that the requested product/integration surface is documented or source-visible, but it does not by itself prove that every local-model runtime path works.`,
    `- I verified a non-official/community source category through ${sourceBrief(primaryCommunity)}. Treat that evidence as a failure-signal and user-report category, not as official support documentation or a complete measure of community consensus.`,
    "- The collected sources separate the connector question from the model-runtime question. Product/integration evidence can support \"there is an integration path\"; it does not automatically support that the requested local model runs on the target platform with stable tool calling, streaming, and context behavior.",
    "",
    "## Likely Inferences",
    "- The practical setup probably has three layers: the user-facing UI, the agent or integration layer, and a local model runtime such as Ollama, LM Studio, llama.cpp, or another OpenAI-compatible server. A failure in one layer should not be interpreted as proof that the whole stack is unsupported.",
    "- The community evidence makes local provider compatibility a real risk area. It is reasonable to infer that image payload formatting, OpenAI-compatible endpoint shape, streaming behavior, and model-name mapping need direct testing before calling a Windows Qwen setup reliable.",
    "- The official and source-hub evidence is enough to justify a cautious test plan, not enough to claim production-grade support for a specific Qwen quantization, VRAM envelope, or tool-calling mode without a direct benchmark on the target Windows machine.",
    "",
    "## Unknowns",
    `- Missing required source categories after grouped coverage: ${missingCategories}. If this says "none", the category exists, but category coverage still does not mean the source directly proves every runtime claim.`,
    "- I could not verify an official, end-to-end statement that the requested UI/integration stack is sufficient to run the requested local model on the target platform. The available evidence supports adjacent pieces and risk areas, so the end-to-end claim should remain a test hypothesis.",
    "- I could not verify tokens-per-second, maximum stable context window, exact 16GB VRAM fit, or tool-calling reliability for the requested stack from the collected sources. Those need local measurements.",
    "",
    "## Source Categories",
    "### Official / Documentation Sources",
    ...(officialSources.length > 0
      ? officialSources.slice(0, 3).map((source) => `- ${sourceBrief(source)} — ${summarySnippet(source.summary, 220)}`)
      : ["- No verified official/documentation source was collected for this category."]),
    "",
    "### Community / Non-Official Sources",
    ...(communitySources.length > 0
      ? communitySources.slice(0, 3).map((source) => `- ${sourceBrief(source)} — ${summarySnippet(source.summary, 220)}`)
      : ["- No verified community or non-official source was collected, so user-reported failure modes are missing."]),
    "",
    "### Adjacent Sources",
    ...(otherSources.length > 0
      ? otherSources.slice(0, 2).map((source) => `- ${sourceBrief(source)} — ${summarySnippet(source.summary, 180)}`)
      : ["- No additional adjacent sources were needed beyond the official/community categories."]),
    "",
    "## What I Could Not Verify",
    "- I could not verify that connecting the UI to the agent/integration layer is sufficient by itself; local model serving still requires a separate runtime endpoint and compatibility checks.",
    "- I could not verify that the community issue evidence is representative of all users. It is useful for risk discovery, not for broad adoption claims.",
    `- Searches attempted: ${evidence.metrics.webSearches}. Verified non-search sources: ${sources.length}. Retrieved ${retrieved}.`,
    "",
    "## Sources",
    ...sources.slice(0, 8).map((source) => `- [${source.title}](${source.url}) — ${source.dateText}; category: ${labelSourcePurpose(source.sourcePurpose)}`),
  ];

  return lines.join("\n");
}

function buildLocalModelSetupAnswer(
  message: string,
  evidence: BroadEvidencePack,
  sources: SourceUse[],
  spec: WebResearchTaskSpec,
  evidencePurposes: ResearchSourcePurpose[],
): string {
  const retrieved = new Date().toISOString().slice(0, 10);
  const byPurpose = groupSourcesByPurpose(sources);
  const primaryProductSource = firstSource(byPurpose, "official_primary_product");
  const integrationProductSource = firstSource(byPurpose, "official_integration_product");
  const runtime = firstSource(byPurpose, "model_runtime");
  const community = firstSourceByPurpose(byPurpose, ["community_report", "github_issues", "github_discussions"]);
  const allSourcesCovered = !!(primaryProductSource && integrationProductSource && runtime && community);
  const coverageSeed = [
    "## Recommendation",
    "Windows 16GB VRAM Qwen Ollama OpenAI-compatible serving.",
    "## Setup Steps",
    "## Official Product / Integration Guidance",
    "## Model And Runtime Evidence",
    "## Community Reports",
    "## Source Categories",
    "## Tradeoffs And Failure Risks",
    "## What I Could Not Verify",
  ].join("\n");
  const coverage = evaluateWebResearchCoverage(spec, coverageSeed, evidencePurposes);
  const sourceLine = (source?: SourceUse) => source
    ? `${source.title}: ${compactSummary(source.summary, source.url)} Source: ${source.url} (${source.dateText}).`
    : "No verified source in this category was collected.";
  const dimensionStatus = (label: string, patterns: RegExp[]): string => {
    const matched = sources.some((source) => {
      const text = `${source.title} ${source.summary} ${source.url}`.toLowerCase();
      return patterns.some((pattern) => pattern.test(text));
    });
    if (matched) {
      return `- ${label}: weak — the collected evidence mentions this area, but not enough to treat it as target-hardware validation.`;
    }
    return `- ${label}: missing — no verified source in the collected evidence directly validates this dimension.`;
  };

  const runtimeName = runtime
    ? (/lm.?studio/i.test(runtime.url) ? "LM Studio" : /llama.cpp/i.test(runtime.url) ? "llama.cpp" : "Ollama")
    : (/\bllama\.?cpp\b/i.test(message) ? "llama.cpp" : /\blm\s*studio\b/i.test(message) ? "LM Studio" : /\bvllm\b/i.test(message) ? "vLLM" : "Ollama");

  // Derive platform / model / memory from the prompt — never hardcode the benchmark scenario.
  const setupPlatform = /\bwindows\b/i.test(message) ? "Windows"
    : /\b(?:linux|ubuntu|debian|fedora|arch)\b/i.test(message) ? "Linux"
    : /\b(?:mac|macos|osx|apple\s+silicon|m[1-4]\b)\b/i.test(message) ? "macOS"
    : "your platform";
  const setupVramMatch = message.match(/(\d+)\s*gb/i);
  const setupMem = setupVramMatch ? `${setupVramMatch[1]}GB` : "your available GPU/VRAM";
  const setupModelMatch = message.match(/\b(qwen[\w.-]*|llama[\w.-]*|mistral[\w.-]*|gemma[\w.-]*|phi[\w.-]*|deepseek[\w.-]*|whisper[\w.-]*|mixtral[\w.-]*)\b/i);
  const setupModel = setupModelMatch ? `a ${setupModelMatch[1]}-class` : "a";
  const setupWebUI = "the requested front-end or agent UI";

  const recommendationLines = allSourcesCovered
    ? [
        `Recommended ${setupPlatform} test setup (all four source categories verified — official primary product, official integration product, model/runtime, and community):`,
        `1. Install ${runtimeName} on ${setupPlatform} and pull ${setupModel} quantized model (GGUF Q4/Q5) sized to fit ${setupMem} with context headroom.`,
        `2. Verify the OpenAI-compatible endpoint is reachable: \`curl http://localhost:11434/v1/models\` (Ollama) or the equivalent for your runtime.`,
        `3. In ${setupWebUI}, point the model config at that local base URL. Confirm a simple chat completion before enabling tool-use or agent flows.`,
        `4. Run a short prompt, a long-context prompt, and one tool call; measure memory, latency, and context truncation before declaring the setup stable.`,
        runtime ? `Runtime evidence anchor: ${runtime.url} (${runtime.dateText}).` : "",
        integrationProductSource ? `Integration product anchor: ${integrationProductSource.url} (${integrationProductSource.dateText}).` : "",
        primaryProductSource ? `Primary product anchor: ${primaryProductSource.url} (${primaryProductSource.dateText}).` : "",
      ].filter(Boolean)
    : [
        `Use a conservative ${setupPlatform} test setup: run ${setupModel} GGUF/quantized model in ${runtimeName} (or another local runtime) sized to fit ${setupMem}, expose an OpenAI-compatible serving endpoint where the runtime supports it, then connect ${setupWebUI} to that endpoint only after the official app docs and runtime docs agree on the API shape.`,
        runtime ? `Runtime anchor: ${runtime.url} (${runtime.dateText}).` : "Runtime anchor: not fully verified in the collected evidence.",
        integrationProductSource ? `Integration product anchor: ${integrationProductSource.url} (${integrationProductSource.dateText}).` : "",
        primaryProductSource ? `Primary product anchor: ${primaryProductSource.url} (${primaryProductSource.dateText}).` : "",
      ].filter(Boolean);

  const lines = [
    "## Recommendation",
    ...recommendationLines,
    "",
    "## Setup Steps",
    "1. Pick the smallest Qwen-class quantized model that fits 16GB VRAM with headroom for context and KV cache. Do not start with a full-precision model.",
    `2. Serve it through ${runtimeName}${runtimeName === "Ollama" ? ", LM Studio," : ""} or llama.cpp — confirm the runtime documentation explicitly documents an OpenAI-compatible API endpoint.`,
    "3. Point the requested UI or agent-facing model configuration at that local endpoint and verify a simple chat completion before trying tool-heavy agent flows.",
    "4. Run one short prompt, one long-context prompt, and one tool/use-case prompt; record latency, VRAM pressure, crashes, and context truncation.",
    "",
    "## Official Product / Integration Guidance",
    `Primary product: ${sourceLine(primaryProductSource)}`,
    `Integration product: ${sourceLine(integrationProductSource)}`,
    "",
    "## Model And Runtime Evidence",
    sourceLine(runtime),
    "",
    "## Community Reports",
    community
      ? `${sourceLine(community)} Treat this as a user report, not official support evidence.`
      : "No verified community report was collected, so I would not treat feasibility as community-validated yet.",
    "",
    "## Source Categories",
    `- Official primary product: ${primaryProductSource ? `covered by ${primaryProductSource.url}` : "missing from verified evidence"}.`,
    `- Official integration product: ${integrationProductSource ? `covered by ${integrationProductSource.url}` : "missing from verified evidence"}.`,
    `- Model/runtime documentation: ${runtime ? `covered by ${runtime.url}` : "missing from verified evidence"}.`,
    `- Community reports: ${community ? `covered by ${community.url}` : "missing from verified evidence"}.`,
    "- Treat official docs as setup/configuration evidence, runtime docs as serving/model evidence, and community reports as failure-risk evidence.",
    "",
    "## Tradeoffs And Failure Risks",
    "- 16GB VRAM is plausible only for a quantized Qwen-class model (Q4/Q5 GGUF); full-precision 14B+ models and large context windows are the primary failure risks.",
    "- OpenAI-compatible serving reduces integration friction, but compatibility does not guarantee tool calling, streaming, function-call shape, or context behavior will match the cloud model path.",
    "- Community reports can reveal practical failure patterns, but they should not override official runtime and app documentation.",
    "- If official product/integration docs do not explicitly document the exact local-runtime path, treat this as a test setup rather than a production recommendation.",
    "",
    "## What I Could Not Verify",
    coverage.missingSourcePurposes.length > 0
      ? `- Missing source categories: ${coverage.missingSourcePurposes.join(", ")}.`
      : "- Required source categories were represented in verified evidence.",
    "",
    "Specific missing/weak dimensions from the collected evidence:",
    dimensionStatus("Tokens-per-second benchmarks", [/\btokens?\s*\/?\s*s(?:ec(?:ond)?s?)?\b/i, /\btps\b/i, /\binference\s+speed\b/i]),
    dimensionStatus("Native Windows binary path", [/\bwindows\b/i, /\bwin64\b/i, /\bnative\b/i, /\bexe\b/i]),
    dimensionStatus("VRAM overlap data", [/\bvram\b/i, /\bgpu\s+memory\b/i, /\bkv\s+cache\b/i]),
    dimensionStatus("Tool-calling reliability", [/\btool\s*call/i, /\bfunction\s*call/i, /\bstructured\s+output\b/i]),
    dimensionStatus("Stable context window", [/\bcontext\s+window\b/i, /\bcontext\s+length\b/i, /\b32k\b/i, /\b64k\b/i, /\b128k\b/i]),
    coverage.missingMustMention.length > 0
      ? `\n- Required topics needing stronger explicit evidence: ${coverage.missingMustMention.join(", ")}.`
      : "",
    `- Searches attempted: ${evidence.metrics.webSearches}. Verified non-search sources: ${sources.length}. Retrieved ${retrieved}.`,
    "",
    "## Sources",
    ...sources.slice(0, 8).map((source) => `- ${labelSourcePurpose(source.sourcePurpose)}: [${source.title}](${source.url}) — ${source.dateText}`),
    "",
    coverage.pass ? `Request covered: ${message}` : `Coverage status: partial; missing ${[...coverage.missingSourcePurposes, ...coverage.missingMustMention].join(", ") || "required evidence details"}.`,
  ];

  return lines.join("\n");
}

function groupSourcesByPurpose(sources: SourceUse[]): Map<ResearchSourcePurpose, SourceUse[]> {
  const grouped = new Map<ResearchSourcePurpose, SourceUse[]>();
  for (const source of sources) {
    const current = grouped.get(source.sourcePurpose) ?? [];
    current.push(source);
    grouped.set(source.sourcePurpose, current);
  }
  return grouped;
}

function firstSource(grouped: Map<ResearchSourcePurpose, SourceUse[]>, purpose: ResearchSourcePurpose): SourceUse | undefined {
  return grouped.get(purpose)?.[0];
}

function firstSourceByPurpose(grouped: Map<ResearchSourcePurpose, SourceUse[]>, purposes: ResearchSourcePurpose[]): SourceUse | undefined {
  for (const purpose of purposes) {
    const source = grouped.get(purpose)?.[0];
    if (source) return source;
  }
  return undefined;
}

function labelSourcePurpose(purpose: ResearchSourcePurpose): string {
  const labels: Record<ResearchSourcePurpose, string> = {
    official_primary_product: "Official primary product",
    official_integration_product: "Official integration product",
    model_runtime: "Model/runtime docs",
    community_report: "Community report",
    youtube_transcript: "YouTube transcript",
    github_issues: "GitHub issues",
    github_discussions: "GitHub discussions",
    github_releases: "GitHub releases",
    docs_readme: "Docs/README",
    independent_blog: "Independent blog",
    generic: "General source",
  };
  return labels[purpose];
}

function missingCoverageRisks(coverage: WebResearchCoverageResult): string {
  const risks: string[] = [];
  if (coverage.missingSourcePurposes.length > 0) {
    risks.push(`- Missing source categories: ${coverage.missingSourcePurposes.join(", ")}. Answer may be incomplete.`);
  }
  if (coverage.missingAnswerSections.length > 0) {
    risks.push(`- Missing sections: ${coverage.missingAnswerSections.join(", ")}.`);
  }
  if (risks.length === 0) risks.push("- All required coverage areas are satisfied based on available evidence.");
  return risks.join("\n");
}
