import type { ResearchSourcePurpose } from "@/lib/channels/web-research-task-spec";

export type SourceKind = "primary" | "community" | "docs" | "search_index" | "unknown";

export type SourceCandidate = {
  url: string;
  title?: string;
  snippet?: string;
  query: string;
  sourceKind: SourceKind;
  sourcePurpose: ResearchSourcePurpose;
  intendedSourcePurpose?: ResearchSourcePurpose;
  rank: number;
  reason: string;
  discoveredFrom?: string;
};

function normalizeSourceUrl(rawUrl: string): string {
  try {
    const cleaned = rawUrl.trim().replace(/[),.;\]]+$/g, "");
    const url = new URL(cleaned);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|igshid$|ref$|ref_src$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return rawUrl.trim().replace(/[),.;\]]+$/g, "").replace(/\/$/, "").toLowerCase();
  }
}

export function classifySourceUrl(rawUrl: string): { sourceKind: SourceKind; rank: number; reason: string } {
  let url: URL;
  try {
    url = new URL(normalizeSourceUrl(rawUrl));
  } catch {
    return { sourceKind: "unknown", rank: 60, reason: "unparseable URL" };
  }

  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname.toLowerCase();
  const search = url.search.toLowerCase();

  if (
    search.includes("q=") &&
    (
      /github\.com$/.test(host) && path === "/search" ||
      /reddit\.com$/.test(host) && path.includes("/search") ||
      /huggingface\.co$/.test(host) && path.includes("/search") ||
      /hn\.algolia\.com$/.test(host) ||
      /duckduckgo\.com$/.test(host)
    )
  ) {
    return { sourceKind: "search_index", rank: 90, reason: "search result page; discovery lead only" };
  }

  if (/duckduckgo\.com$/.test(host)) {
    return { sourceKind: "search_index", rank: 90, reason: "search engine result/disambiguation page; discovery lead only" };
  }

  if (/github\.com$/.test(host)) {
    if (/\/(?:issues|discussions|pull|releases)(?:\/|$)/.test(path)) {
      return { sourceKind: "community", rank: 5, reason: "GitHub issue/discussion/release page" };
    }
    return { sourceKind: "primary", rank: 15, reason: "GitHub project source" };
  }

  if (/reddit\.com$|news\.ycombinator\.com$|stackoverflow\.com$|discourse|forum/i.test(host)) {
    return { sourceKind: "community", rank: 10, reason: "community discussion source" };
  }

  if (/docs\.|developer\.|npmjs\.com$|pypi\.org$|huggingface\.co$|arxiv\.org$/i.test(host) || /^\/docs(?:\/|$)/i.test(path)) {
    return { sourceKind: "docs", rank: 20, reason: "documentation/model/research source" };
  }

  return { sourceKind: "unknown", rank: 50, reason: "unclassified source" };
}

export function classifySourcePurpose(
  rawUrl: string,
  titleContent?: string,
): ResearchSourcePurpose {
  const normalized = `${rawUrl} ${titleContent ?? ""}`.toLowerCase();

  // GitHub issue/discussion pages are evidence about user reports and failure
  // patterns even when they live under an official project repository.
  if (/\bgithub\.com\/[^/\s]+\/[^/\s]+\/issues(?:[/?#\s]|$)/i.test(normalized) ||
      /\bgithub\.com\/search\?.*type=issues/i.test(normalized)) {
    return "community_report";
  }
  if (/\bgithub\.com\/[^/\s]+\/[^/\s]+\/discussions(?:[/?#\s]|$)/i.test(normalized) ||
      /\bgithub\.com\/search\?.*type=discussions/i.test(normalized)) {
    return "community_report";
  }
  if (/\bgithub\.com\/[^/\s]+\/[^/\s]+\/pull(?:[/?#\s]|$)/i.test(normalized)) {
    return "community_report";
  }
  if (/\bgithub\.com\/[^/\s]+\/[^/\s]+\/releases(?:[/?#\s]|$)/i.test(normalized) ||
      /\b(?:release\s+notes?|changelog|version\s+history)\b/i.test(normalized)) {
    return "github_releases";
  }

  if (/\b(?:ollama\.com|ollama\/ollama|github\.com.*ollama|vllm\.ai|vllm-project|llama-cpp|lm-studio|huggingface\.co.*model-card|huggingface\.co.*(?:qwen|llama|mistral|gemma))\b/i.test(normalized)) {
    return "model_runtime";
  }

  // Community reports (after official sources)
  if (
    /\b(?:reddit\.com|news\.ycombinator\.com|stackoverflow\.com|forum)\b/i.test(normalized) ||
    /\b(?:community\s+report|user\s+experience|forum|discussion\s+thread)\b/i.test(normalized)
  ) {
    return "community_report";
  }

  // Generic docs/readme (last, after official project matches)
  if (/\b(?:readme\.md|readme\.txt|changelog\.md|readme|docs\/|\/docs\b|documentation\s+page|api\s+docs|getting\s+started)\b/i.test(normalized)) {
    return "docs_readme";
  }

  // Independent blogs
  if (/\b(?:medium\.com|dev\.to|hackernoon|blog\.|\.blog\/|independent|third[\s-]party|review|comparison|analysis)\b/i.test(normalized) &&
      !/\b(?:reddit\.com|github\.com)\b/i.test(normalized)) {
    return "independent_blog";
  }

  return "generic";
}

export function makeSourceCandidate(input: {
  url: string;
  query: string;
  title?: string;
  snippet?: string;
  discoveredFrom?: string;
  intendedSourcePurpose?: ResearchSourcePurpose;
}): SourceCandidate {
  const normalized = normalizeSourceUrl(input.url);
  const classified = classifySourceUrl(normalized);
  const sourcePurpose = input.intendedSourcePurpose ?? classifySourcePurpose(normalized, `${input.title ?? ""} ${input.snippet ?? ""}`);
  return {
    url: normalized,
    title: input.title,
    snippet: input.snippet,
    query: input.query,
    discoveredFrom: input.discoveredFrom,
    sourcePurpose,
    intendedSourcePurpose: input.intendedSourcePurpose,
    ...classified,
  };
}

export function rankSourceCandidates(candidates: SourceCandidate[]): SourceCandidate[] {
  const seen = new Map<string, SourceCandidate>();
  for (const candidate of candidates) {
    const existing = seen.get(candidate.url);
    if (!existing || candidate.rank < existing.rank) {
      seen.set(candidate.url, candidate);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.rank - b.rank || a.url.localeCompare(b.url));
}

export function isSearchIndexUrl(url: string): boolean {
  return classifySourceUrl(url).sourceKind === "search_index";
}
