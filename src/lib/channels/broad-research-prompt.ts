import { determineTaskIntentContract } from "@/lib/channels/task-intent-contract";

const BROAD_RESEARCH_PATTERNS = [
  /\bresearch\b/i,
  /\binvestigat(?:e|ion)\b/i,
  /\blook\s+into\b/i,
  /\bfind\s+out\b/i,
  /\bsynthesi[sz]e\b/i,
  /\bsummar(?:y|ize)\s+across\b/i,
  /\bthemes?\b/i,
  /\btradeoffs?\b/i,
  /\bcurrent\s+(?:state|best|tools?|support)\b/i,
  /\bwhat\s+(?:are|do)\s+people\s+(?:use|using|say)\b/i,
  /\bbest\s+(?:way|approach|tool|runner|option)\b/i,
  /\bhow\s+(?:can|do|would)\s+we\s+improve\b/i,
  /\bclose\s+the\s+gap\b/i,
  /\bsource\s+links?\b/i,
  /\bcite\s+sources?\b/i,
];

const CURRENT_FACT_PATTERNS = [
  /\blatest\b/i,
  /\bcurrent\b/i,
  /\btoday\b/i,
  /\bnow\b/i,
  /\brecent\b/i,
  /\bprice\b/i,
  /\bpricing\b/i,
  /\b(?:latest|upcoming|recent|next|status\s+of)\s+release\b/i,
  /\bfind\s+release\s+notes?\b/i,
  /\brelease\s+(?:online|on\s+the\s+web|search)\b/i,
  /\bmodel\s+card\b/i,
  /\bdocs?\b/i,
  /\bgithub\b/i,
  /\bpeople\s+(?:use|using|say)\b/i,
  /\bcommunity\b/i,
];

const REPO_GROUNDING_PATTERNS = [
  /\bthis\s+(?:app|repo|repository|codebase|project|workspace)\b/i,
  /\bdisp8ch\b/i,
  /\bimplementation\s+plan\b/i,
  /\bfile\s+paths?\b/i,
  /\bsrc\//i,
  /\broute\.ts\b/i,
];

const SESSION_ONLY_DIRECT_PATTERNS = [
  /\bbased\s+only\s+on\s+what\s+you\s+know\s+from\s+this\s+session\b/i,
  /\bbased\s+only\s+on\s+(?:this|our)\s+(?:session|conversation|chat)\b/i,
  /\bfrom\s+(?:this|our)\s+(?:session|conversation|chat)\s+only\b/i,
  /\busing\s+only\s+(?:this|our)\s+(?:session|conversation|chat)\b/i,
  /\buse\s+only\s+(?:this|our)\s+(?:session|conversation|chat)\b/i,
  /\bdo\s+not\s+(?:search|browse|look\s+up|fetch|inspect|read|use\s+tools?)\b/i,
];

const EXTERNAL_OR_INSPECTION_PATTERNS = [
  /\b(?:search|browse|look\s+up|fetch|crawl|web|online|internet|source\s+links?|cite\s+sources?)\b/i,
  /\b(?:latest|current|recent|today|now|live|public\s+discussion|community)\b/i,
  /\b(?:inspect|read|list|check|verify|audit|review|analy[sz]e)\b[\s\S]{0,80}\b(?:repo|repository|codebase|workspace|files?|docs?)\b/i,
  /\b(?:benchmark\s+results?|test\s+results?|run\s+reports?|score|timing|tps)\b/i,
];

export function isSessionOnlyDirectAnswerPrompt(message: string): boolean {
  const text = String(message || "").trim();
  if (!text) return false;
  if (!SESSION_ONLY_DIRECT_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return !EXTERNAL_OR_INSPECTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function isLikelyBroadResearchPrompt(message: string): boolean {
  const text = String(message || "").trim();
  if (!text) return false;
  if (isSessionOnlyDirectAnswerPrompt(text)) return false;
  const contract = determineTaskIntentContract(text);
  if (contract.toolPolicy === "forbidden") return false;
  if (contract.requiresCurrentFacts) return true;
  return BROAD_RESEARCH_PATTERNS.some((pattern) => pattern.test(text));
}

export function needsCurrentPublicFacts(message: string): boolean {
  const text = String(message || "").trim();
  if (!text) return false;
  const contract = determineTaskIntentContract(text);
  if (contract.toolPolicy === "forbidden") return false;
  if (contract.requiresCurrentFacts) return true;
  return CURRENT_FACT_PATTERNS.some((pattern) => pattern.test(text));
}

export function needsRepoGrounding(message: string): boolean {
  const text = String(message || "").trim();
  if (!text) return false;
  return REPO_GROUNDING_PATTERNS.some((pattern) => pattern.test(text));
}

export function getBroadResearchSourceHints(message: string): string {
  const text = String(message || "");
  const hints: string[] = [];

  if (/\b(?:local|ollama|llama\.cpp|lm\s*studio|vllm|sglang|gguf|openai-compatible|model\s+card|vram|gpu\s+memory)\b/i.test(text)) {
    hints.push(
      "For local-model questions, derive named models/runtimes/platforms from the prompt and verify them with official model cards, runtime docs, compatibility docs, and current community issue/discussion sources.",
    );
  }

  if (/\b(?:repo|codebase|workspace|this\s+app|this\s+project|implementation|configuration|provider|runtime)\b/i.test(text)) {
    hints.push(
      "For repo-grounded research, discover relevant files with search_files/list_files first, then read only current source/config/runtime paths that prove the claim.",
    );
  }

  return hints.join("\n");
}

export const BROAD_RESEARCH_TOOL_GUIDANCE = `
For broad research, comparison, and synthesis requests:

1. Decide whether the answer needs current web data, repo data, memory, or all of them.
2. If current facts, public adoption, prices, docs, model support, release status, or recent tooling behavior matter, use web tools.
3. Use multiple search phrasings when the first query is sparse, ambiguous, or biased.
4. Prefer primary sources: official docs, model cards, GitHub issues/releases, source code, and benchmark artifacts.
5. For community adoption questions, clearly label evidence as community signal, not proof.
6. If sources disagree, explain the disagreement and choose the lowest-risk path.
7. Ground repo claims in real file paths from this workspace.
8. Search results are hints. Fetch or open a source before treating it as evidence.
9. Do not cite a URL unless it appears in fetched/browser evidence.
10. Do not invent tool calls or tool markup. If a needed tool is unavailable, say what cannot be verified.
11. Keep the final answer actionable: findings, decision, implementation steps, and verification.
`.trim();

export const BROAD_RESEARCH_SEARCH_RECOVERY = `
If the first search returns weak results:

- Try exact model, product, or repository names.
- Try runner-specific or provider-specific searches.
- Try GitHub issues/releases for breakage, compatibility, and performance.
- Try Hugging Face model card searches for local model support.
- Try official docs for API compatibility.
- Try community terms only after primary sources.
- Do not stop at "no results" unless at least two materially different searches failed.
`.trim();

export const BROAD_RESEARCH_QUALITY_GATE = `
Before finalizing a broad answer, check:

- Did you answer the user's actual decision?
- Did you separate verified facts from inference?
- Did you mention source dates or current uncertainty when relevant?
- Did you include concrete next steps?
- Did you avoid overclaiming community popularity?
- Did you include enough detail for implementation?
- Did every cited URL come from a fetched or browser-opened source, not only a search result?

If the answer fails this check, revise once before returning.
`.trim();
