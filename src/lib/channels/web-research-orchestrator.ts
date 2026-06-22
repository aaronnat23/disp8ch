import fs from "node:fs";
import path from "node:path";
import { createEvidenceFromToolResult, formatEvidencePackForModel, normalizeUrlForCitation, type EvidenceLedgerEntry } from "@/lib/channels/evidence-ledger-v2";
import { isSearchIndexUrl, makeSourceCandidate, rankSourceCandidates, type SourceCandidate } from "@/lib/channels/web/source-candidate-ranker";
import { buildResearchQueries, type PlannedQuery } from "@/lib/channels/web-research-query-planner";
import { classifyResearchTaskSpec, type ResearchSourcePurpose } from "@/lib/channels/web-research-task-spec";

type EmitFn = (event: string, data: unknown) => void;

export type WebResearchResult = {
  ledger: EvidenceLedgerEntry[];
  sourcePackForModel: string;
  metrics: {
    searches: number;
    extracted: number;
    crawled: number;
    browserPages: number;
    failed: number;
  };
  diagnostics: {
    debugPath?: string;
    debugWriteError?: string;
    queryCount: number;
    candidateCount: number;
    primaryUrlCount: number;
    leadUrlCount: number;
    promotedUrlCount: number;
    verifiedSourceCount: number;
    selectedUrls: string[];
    promotedUrls: string[];
  };
};

function cleanTopic(message: string): string {
  return message
    .replace(/\b(?:summari[sz]e|include|with|give me|show me|top\s+\d+\s+themes?)\b[\s\S]*$/i, "")
    .replace(/\b(?:source\s+links?|links?|urls?|source\s+links?)\b[\s\S]*$/i, "")
    .replace(/\b(?:latest|current|recent)\s+(?:public\s+)?(?:discussion|reaction|conversation)\s+(?:about|around|on)\b/i, "")
    .replace(/\b(?:search|research|look\s+up|find)\s+(?:the\s+web\s+)?(?:for|about|on)?/i, "")
    .replace(/\bpublic\s+discussion\s+(?:about|around|on)\b/i, "")
    .replace(/[.?!]\s*$/g, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || message.slice(0, 160);
}

function buildGenericQueries(message: string, mode: "fast" | "balanced" | "thorough"): PlannedQuery[] {
  const topic = cleanTopic(message);
  const compact = topic
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\bweb\s*ui\b/ig, "WebUI")
    .replace(/\s+/g, " ")
    .trim();
  const hyphenated = compact.replace(/\s+/g, "-");
  const adjacent = Array.from(new Set([
    compact.replace(/\bWebUI\b/ig, "").trim(),
    compact.replace(/\bAgent\b/ig, "").trim(),
    compact.replace(/\b(?:Agent|WebUI)\b/ig, "").trim(),
  ].filter((value) => value.length >= 4)));
  const queries = [
    compact,
    `"${compact}"`,
    `"${compact}" GitHub`,
    `"${compact}" discussion`,
    `${compact} GitHub issues`,
    `${compact} GitHub discussions`,
    ...adjacent.flatMap((variant) => [
      variant,
      `"${variant}" discussion`,
      `${variant} GitHub`,
    ]),
  ];
  if (/\b(public|community|people|discussion|themes?|reaction)\b/i.test(message)) {
    queries.push(
      `site:github.com ${compact} discussions`,
      `site:github.com ${compact} issues`,
      `site:reddit.com ${compact}`,
      `site:news.ycombinator.com ${compact}`,
      `${compact} Hacker News`,
      `${hyphenated} GitHub`,
    );
  }
  if (/\b(model|local|qwen|llama|ollama|vllm|lm studio|hugging face)\b/i.test(message)) {
    queries.push(`${topic} Hugging Face model card`, `${topic} llama.cpp`, `${topic} vLLM`);
  }
  return Array.from(new Set(queries.map((q) => q.trim()).filter((q) => q.length > 2)))
    .slice(0, mode === "thorough" ? 16 : 7)
    .map((query) => ({ query, sourcePurpose: "generic" as const }));
}

function buildPlannedQueries(message: string, mode: "fast" | "balanced" | "thorough"): PlannedQuery[] {
  const spec = classifyResearchTaskSpec(message);
  const taskQueries = buildResearchQueries(message, spec.requiredSourcePurposes);
  const genericQueries = buildGenericQueries(message, mode);
  const combined = spec.requiredSourcePurposes.length > 1
    ? [...taskQueries, ...genericQueries]
    : genericQueries;
  const seen = new Set<string>();
  // For local_model_setup we use seed candidates for required purposes, so fewer broad
  // queries are needed — cap thorough mode at 10 to reduce wall-clock time.
  const limit = mode === "thorough"
    ? (spec.taskKind === "local_model_setup" ? 10 : 18)
    : 8;
  const result: PlannedQuery[] = [];
  for (const planned of combined) {
    const key = planned.query.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(planned);
    if (result.length >= limit) break;
  }
  return result;
}

function extractUrls(text: string): string[] {
  return Array.from(new Set((text.match(/https?:\/\/[^\s)\],;"'<>]+/g) ?? []).map(normalizeUrlForCitation)));
}

function extractBrowserLinkUrls(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as { links?: Array<{ absoluteHref?: string; href?: string; visible?: boolean }> };
    const urls = (parsed.links ?? [])
      .map((link) => link.absoluteHref || link.href || "")
      .filter((url) => /^https?:\/\//i.test(url))
      .map(normalizeUrlForCitation);
    return Array.from(new Set(urls));
  } catch {
    return extractUrls(text);
  }
}

function debugWrite(sessionId: string, payload: unknown): { debugPath?: string; debugWriteError?: string } {
  try {
    const safeSessionId = sessionId.replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 96) || "session";
    const dir = path.join(process.cwd(), "data", "web-research-debug", safeSessionId);
    fs.mkdirSync(dir, { recursive: true });
    const debugPath = path.join(dir, `${Date.now()}.json`);
    fs.writeFileSync(debugPath, JSON.stringify(payload, null, 2));
    return { debugPath };
  } catch (error) {
    return { debugWriteError: error instanceof Error ? error.message : String(error) };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function requiredPurposesCoveredInLedger(ledger: EvidenceLedgerEntry[], required: ResearchSourcePurpose[]): boolean {
  const meaningful = required.filter((p) => p !== "generic" && p !== "youtube_transcript");
  // For generic / general_research tasks there are no specific purposes to satisfy,
  // so the normal browser fallback should still run when verified-source counts are low.
  if (meaningful.length === 0) return false;
  const covered = new Set(
    ledger
      .filter((e) => e.verified && e.metadata?.sourceKind !== "search_index")
      .map((e) => e.metadata?.sourcePurpose as string)
      .filter(Boolean),
  );
  return meaningful.every((p) => covered.has(p));
}

function missingRequiredPurposes(candidates: SourceCandidate[], required: ResearchSourcePurpose[]): ResearchSourcePurpose[] {
  const available = new Set(
    candidates
      .filter((candidate) => candidate.sourceKind !== "search_index")
      .map((candidate) => candidate.sourcePurpose),
  );
  return required.filter((purpose) => purpose !== "generic" && purpose !== "youtube_transcript" && !available.has(purpose));
}

function selectDiverseSourceUrls(candidates: SourceCandidate[], maxSources: number, requiredPurposes: ResearchSourcePurpose[] = []): string[] {
  const nonSearch = candidates.filter((candidate) => candidate.sourceKind !== "search_index");
  const selected: SourceCandidate[] = [];
  const seen = new Set<string>();
  const seenHosts = new Set<string>();
  const purposes = requiredPurposes.filter((purpose) => purpose !== "generic" && purpose !== "youtube_transcript");

  for (const purpose of purposes) {
    const exact = nonSearch.find((candidate) =>
      candidate.sourcePurpose === purpose &&
      !seen.has(candidate.url),
    );
    const intended = exact ?? nonSearch.find((candidate) =>
      candidate.intendedSourcePurpose === purpose &&
      !seen.has(candidate.url),
    );
    if (!intended) continue;
    selected.push(intended);
    seen.add(intended.url);
    seenHosts.add(hostOf(intended.url));
    if (selected.length >= maxSources) return selected.map((item) => item.url);
  }

  const buckets = ["community", "primary", "docs", "unknown"] as const;
  for (const bucket of buckets) {
    for (const candidate of nonSearch.filter((item) => item.sourceKind === bucket)) {
      const host = hostOf(candidate.url);
      if (seen.has(candidate.url) || seenHosts.has(host)) continue;
      selected.push(candidate);
      seen.add(candidate.url);
      seenHosts.add(host);
      if (selected.length >= maxSources) return selected.map((item) => item.url);
      break;
    }
  }

  for (const candidate of nonSearch) {
    if (seen.has(candidate.url)) continue;
    selected.push(candidate);
    seen.add(candidate.url);
    if (selected.length >= maxSources) break;
  }

  return selected.map((item) => item.url);
}

export async function runWebResearch(params: {
  message: string;
  sessionId: string;
  agentId: string;
  mode: "fast" | "balanced" | "thorough";
  maxSources?: number;
  onEmit?: EmitFn;
}): Promise<WebResearchResult> {
  const { executeTool } = await import("@/lib/engine/tools");
  const ledger: EvidenceLedgerEntry[] = [];
  const metrics = { searches: 0, extracted: 0, crawled: 0, browserPages: 0, failed: 0 };
  const taskSpec = classifyResearchTaskSpec(params.message);
  const queries = buildPlannedQueries(params.message, params.mode);
  const candidates: SourceCandidate[] = [];
  let promotedUrls: string[] = [];

  for (const planned of queries) {
    params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name: "web_search", args: { query: planned.query, sourcePurpose: planned.sourcePurpose } });
    try {
      const output = await executeTool("web_search", { query: planned.query, maxResults: 6 }, { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true });
      metrics.searches++;
      ledger.push(...createEvidenceFromToolResult({ tool: "web_search", args: { query: planned.query, maxResults: 6 }, output, metadata: { intendedSourcePurpose: planned.sourcePurpose } }));
      for (const url of extractUrls(output)) candidates.push(makeSourceCandidate({ url, query: planned.query, intendedSourcePurpose: planned.sourcePurpose }));
      params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "web_search", resultPreview: output.slice(0, 200) });
    } catch (error) {
      metrics.failed++;
      const output = `[Tool failed: web_search] ${String(error).slice(0, 500)}`;
      ledger.push(...createEvidenceFromToolResult({ tool: "web_search", args: { query: planned.query }, output, metadata: { intendedSourcePurpose: planned.sourcePurpose } }));
      params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "web_search", resultPreview: output.slice(0, 200) });
    }
  }

  const topic = cleanTopic(params.message);
  if (candidates.length === 0) {
    const encoded = encodeURIComponent(topic);
    [
      `https://github.com/search?q=${encoded}&type=issues`,
      `https://github.com/search?q=${encoded}&type=discussions`,
      `https://www.reddit.com/search/?q=${encoded}`,
      `https://hn.algolia.com/?q=${encoded}`,
      `https://huggingface.co/search/full-text?q=${encoded}`,
    ].forEach((url) => candidates.push(makeSourceCandidate({ url, query: topic, intendedSourcePurpose: "community_report" })));
  }

  // Do not inject fixed product URLs here. The query planner and search results
  // must discover official/community sources from the user's entities, which
  // keeps this path useful for unseen products instead of benchmark-tuned cases.

  const rankedCandidates = rankSourceCandidates(candidates);
  const primaryUrls = selectDiverseSourceUrls(rankedCandidates, params.maxSources ?? (params.mode === "thorough" ? 8 : 5), taskSpec.requiredSourcePurposes);
  const leadUrls = rankedCandidates
    .filter((candidate) => candidate.sourceKind === "search_index")
    .map((candidate) => candidate.url)
    .slice(0, 4);
  const urls = primaryUrls.length > 0 ? primaryUrls : leadUrls;
  const purposeByUrl = Object.fromEntries(
    urls.map((url) => {
      const candidate = rankedCandidates.find((item) => item.url === url);
      return [url, candidate?.intendedSourcePurpose ?? candidate?.sourcePurpose ?? "generic"];
    }),
  );

  if (urls.length > 0) {
    params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name: "web_extract", args: { urls } });
    try {
      const output = await executeTool("web_extract", { urls, max_chars_per_url: urls.length > 5 ? 700 : 1200, format: "json" }, { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true });
      metrics.extracted += urls.length;
      ledger.push(...createEvidenceFromToolResult({ tool: "web_extract", args: { urls }, output, metadata: { candidateCount: rankedCandidates.length, purposeByUrl } }));
      params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "web_extract", resultPreview: output.slice(0, 200) });
    } catch (error) {
      metrics.failed++;
      const output = `[Tool failed: web_extract] ${String(error).slice(0, 500)}`;
      ledger.push(...createEvidenceFromToolResult({ tool: "web_extract", args: { urls }, output, metadata: { purposeByUrl } }));
      params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "web_extract", resultPreview: output.slice(0, 200) });
      for (const url of urls.slice(0, 4)) {
        params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name: "fetch_url", args: { url } });
        try {
          const fetched = await executeTool("fetch_url", { url, max_chars: 6000 }, { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true });
          metrics.extracted++;
          ledger.push(...createEvidenceFromToolResult({ tool: "fetch_url", args: { url }, output: fetched, metadata: { intendedSourcePurpose: purposeByUrl[url] } }));
          params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "fetch_url", resultPreview: fetched.slice(0, 200) });
        } catch (fetchError) {
          metrics.failed++;
          const failed = `[Tool failed: fetch_url] ${String(fetchError).slice(0, 500)}`;
          ledger.push(...createEvidenceFromToolResult({ tool: "fetch_url", args: { url }, output: failed }));
          params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "fetch_url", resultPreview: failed.slice(0, 200) });
        }
      }
    }
  }

  // Missing-purpose retry: if web_extract silently dropped URLs needed to cover a
  // required source purpose (e.g., GitHub /issues URLs failing extraction), retry
  // those specific URLs via fetch_url + browser_navigate before the normal fallbacks.
  const meaningfulPurposes = taskSpec.requiredSourcePurposes.filter((p) => p !== "generic" && p !== "youtube_transcript");
  if (meaningfulPurposes.length > 0) {
    const coveredPurposes = new Set(
      ledger
        .filter((e) => e.verified && e.metadata?.sourceKind !== "search_index")
        .map((e) => e.metadata?.sourcePurpose as string),
    );
    const missingPurposes = meaningfulPurposes.filter((p) => !coveredPurposes.has(p));
    if (missingPurposes.length > 0) {
      const triedUrls = new Set(ledger.map((e) => e.canonicalLocator));
      for (const purpose of missingPurposes) {
        const candidate = rankedCandidates.find((c) =>
          (c.sourcePurpose === purpose || c.intendedSourcePurpose === purpose) &&
          c.sourceKind !== "search_index" &&
          !triedUrls.has(c.url),
        );
        if (!candidate) continue;
        const url = candidate.url;
        params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name: "fetch_url", args: { url, missingPurpose: purpose } });
        let success = false;
        try {
          const fetched = await executeTool("fetch_url", { url, max_chars: 6000 }, { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true });
          metrics.extracted++;
          ledger.push(...createEvidenceFromToolResult({ tool: "fetch_url", args: { url }, output: fetched, metadata: { missingPurposeRetry: purpose } }));
          params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "fetch_url", resultPreview: fetched.slice(0, 200) });
          // Verify the new entry actually got classified as the missing purpose
          const newlyVerified = ledger.some((e) => e.verified && e.canonicalLocator === url && e.metadata?.sourcePurpose === purpose);
          if (newlyVerified) success = true;
        } catch (fetchError) {
          metrics.failed++;
          const failed = `[Tool failed: fetch_url] ${String(fetchError).slice(0, 500)}`;
          ledger.push(...createEvidenceFromToolResult({ tool: "fetch_url", args: { url }, output: failed, metadata: { missingPurposeRetry: purpose } }));
          params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "fetch_url", resultPreview: failed.slice(0, 200) });
        }
        if (!success) {
          // fetch_url failed or didn't yield a verified purpose match — try browser
          params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name: "browser_navigate", args: { url, missingPurpose: purpose } });
          try {
            const page = await executeTool("browser_navigate", { url }, { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true });
            metrics.browserPages++;
            ledger.push(...createEvidenceFromToolResult({ tool: "browser_navigate", args: { url }, output: page, metadata: { missingPurposeRetry: purpose } }));
            params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "browser_navigate", resultPreview: page.slice(0, 200) });
          } catch (error) {
            metrics.failed++;
            const failed = `[Tool failed: browser_navigate] ${String(error).slice(0, 500)}`;
            ledger.push(...createEvidenceFromToolResult({ tool: "browser_navigate", args: { url }, output: failed, metadata: { missingPurposeRetry: purpose } }));
            params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "browser_navigate", resultPreview: failed.slice(0, 200) });
          }
        }
        triedUrls.add(url);
      }
    }
  }

  const verifiedSources = ledger.filter((entry) =>
    entry.verified &&
    (entry.kind === "web_source" || entry.kind === "browser_page") &&
    entry.metadata?.sourceKind !== "search_index",
  ).length;
  // Skip browser fallback when all required source purposes are already covered
  // by discovered search/extract/browser evidence.
  const purposesCoveredAfterExtract = requiredPurposesCoveredInLedger(ledger, taskSpec.requiredSourcePurposes);
  if (verifiedSources < 2 && urls.length > 0 && !purposesCoveredAfterExtract) {
    const url = urls.find((candidateUrl) => !isSearchIndexUrl(candidateUrl)) || urls[0];
    params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name: "browser_navigate", args: { url } });
    try {
      const page = await executeTool("browser_navigate", { url }, { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true });
      metrics.browserPages++;
      ledger.push(...createEvidenceFromToolResult({ tool: "browser_navigate", args: { url }, output: page }));
      params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "browser_navigate", resultPreview: page.slice(0, 200) });
    } catch (error) {
      metrics.failed++;
      const failed = `[Tool failed: browser_navigate] ${String(error).slice(0, 500)}`;
      ledger.push(...createEvidenceFromToolResult({ tool: "browser_navigate", args: { url }, output: failed }));
      params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "browser_navigate", resultPreview: failed.slice(0, 200) });
    }
  }

  if (verifiedSources < 3 && leadUrls.length > 0 && !purposesCoveredAfterExtract) {
    const promotedFromSearchLeads: string[] = [];
    for (const lead of leadUrls.slice(0, 2)) {
      params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name: "browser_navigate", args: { url: lead } });
      try {
        const page = await executeTool("browser_navigate", { url: lead }, { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true });
        metrics.browserPages++;
        ledger.push(...createEvidenceFromToolResult({ tool: "browser_navigate", args: { url: lead }, output: page, metadata: { searchLead: true } }));
        params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "browser_navigate", resultPreview: page.slice(0, 200) });
        params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name: "browser_get_links", args: { limit: 80 } });
        try {
          const links = await executeTool("browser_get_links", { limit: 80 }, { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true });
          ledger.push(...createEvidenceFromToolResult({ tool: "browser_get_links", args: { source: lead, limit: 80 }, output: links, metadata: { searchLead: true } }));
          for (const url of extractBrowserLinkUrls(links)) {
            if (!isSearchIndexUrl(url)) {
              promotedFromSearchLeads.push(url);
              candidates.push(makeSourceCandidate({ url, query: topic, discoveredFrom: lead }));
            }
          }
          params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "browser_get_links", resultPreview: links.slice(0, 200) });
        } catch (linkError) {
          metrics.failed++;
          const failedLinks = `[Tool failed: browser_get_links] ${String(linkError).slice(0, 500)}`;
          ledger.push(...createEvidenceFromToolResult({ tool: "browser_get_links", args: { source: lead, limit: 80 }, output: failedLinks, metadata: { searchLead: true } }));
          params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "browser_get_links", resultPreview: failedLinks.slice(0, 200) });
        }
      } catch (error) {
        metrics.failed++;
        const failed = `[Tool failed: browser_navigate] ${String(error).slice(0, 500)}`;
        ledger.push(...createEvidenceFromToolResult({ tool: "browser_navigate", args: { url: lead }, output: failed, metadata: { searchLead: true } }));
        params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "browser_navigate", resultPreview: failed.slice(0, 200) });
      }
    }

    promotedUrls = rankSourceCandidates(
      Array.from(new Set(promotedFromSearchLeads)).map((url) => makeSourceCandidate({ url, query: topic, discoveredFrom: "browser_get_links" })),
    )
      .filter((candidate) => candidate.sourceKind !== "search_index")
      .map((candidate) => candidate.url)
      .slice(0, params.mode === "thorough" ? 6 : 3);
    if (promotedUrls.length > 0) {
      params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "start", name: "web_extract", args: { urls: promotedUrls, promotedFromSearchLeads: true } });
      try {
        const output = await executeTool("web_extract", { urls: promotedUrls, max_chars_per_url: promotedUrls.length > 5 ? 700 : 1200, format: "json" }, { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true });
        metrics.extracted += promotedUrls.length;
        ledger.push(...createEvidenceFromToolResult({ tool: "web_extract", args: { urls: promotedUrls, promotedFromSearchLeads: true }, output, metadata: { promotedFromSearchLeads: true } }));
        params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "web_extract", resultPreview: output.slice(0, 200) });
      } catch (error) {
        metrics.failed++;
        const output = `[Tool failed: web_extract] ${String(error).slice(0, 500)}`;
        ledger.push(...createEvidenceFromToolResult({ tool: "web_extract", args: { urls: promotedUrls, promotedFromSearchLeads: true }, output, metadata: { promotedFromSearchLeads: true } }));
        params.onEmit?.("webchat:tool", { sessionId: params.sessionId, phase: "done", name: "web_extract", resultPreview: output.slice(0, 200) });
      }
    }
  }

  const sourcePackForModel = formatEvidencePackForModel(ledger, { maxEntries: params.mode === "thorough" ? 24 : 16 });
  const finalVerifiedSources = ledger.filter((entry) =>
    entry.verified &&
    (entry.kind === "web_source" || entry.kind === "browser_page") &&
    entry.metadata?.sourceKind !== "search_index",
  ).length;
  const debug = debugWrite(params.sessionId, {
    message: params.message,
    queries,
    taskSpec,
    candidates: rankedCandidates,
    selectedUrls: urls,
    promotedUrls,
    metrics,
    verifiedSourceCount: finalVerifiedSources,
    ledger,
  });
  return {
    ledger,
    sourcePackForModel,
    metrics,
    diagnostics: {
      ...debug,
      queryCount: queries.length,
      candidateCount: rankedCandidates.length,
      primaryUrlCount: primaryUrls.length,
      leadUrlCount: leadUrls.length,
      promotedUrlCount: promotedUrls.length,
      verifiedSourceCount: finalVerifiedSources,
      selectedUrls: urls,
      promotedUrls,
    },
  };
}
