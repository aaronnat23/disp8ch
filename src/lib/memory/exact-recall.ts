export type ExactRecallCandidate = {
  id?: string;
  path?: string;
  content: string;
  score?: number;
  lastReinforcedAt?: string;
  updated?: string;
  created?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  sessionId?: string;
};

export type ExactRecallResolution<T extends ExactRecallCandidate> = {
  identifier: string;
  winner: T;
  grouped: T[];
  rankingQuery: string;
};

const IDENTIFIER_SUBJECT_RE =
  /\b(?:tokens?|identifiers?|ids?|release\s+gate|orange\s+circuit)\b/i;
const CODE_IDENTIFIER_RECALL_RE =
  /(?:\b(?:what|which|tell|remind|recall|retrieve|show|give|reply|respond|answer)\b.{0,48}\bcodes?\b|\bcodes?\b.{0,48}\b(?:saved?|stored?|recorded?|current|newest|latest|active|use\s+now|should\s+i\s+use)\b)/i;
const PROGRAMMING_CODE_CONTEXT_RE =
  /\b(?:source\s+code|code\s+(?:path|base|evidence|implementation|behavior|logic|file|change|review|quality|coverage)|coding|programming)\b/i;
const IDENTIFIER_RECALL_ACTION_RE =
  /\b(?:what|which|tell|remind|recall|retrieve|show|list|give|reply|respond|answer|use|saved?|stored?|recorded?|current|currently|newest|latest|active|history|versions?|older|previous|compare)\b/i;
const STRONG_IDENTIFIER_RECALL_RE =
  /\b(?:reply\s+with\s+only\s+(?:the\s+)?(?:token|identifier|id|code)|what\s+did\s+i\s+just\s+(?:say|store|save)|most\s+recently\s+stored|just\s+saved|which\s+one\s+should\s+i\s+use\s+now|(?:current|currently|newest|latest|active)\s+(?:token|identifier|id)|active\s+right\s+now|exact\s+(?:token|identifier|id))\b/i;
const IDENTIFIER_VALUE_RE = /\b[A-Z0-9]+(?:-[A-Z0-9]+){2,}\b/g;
const LONG_NUMBER_RE = /\b\d{8,}\b/g;
const TIME_FRAGMENT_RE = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g;

export type MemoryLane = "persistent_facts" | "session_history" | "ephemeral_test";
export type QueryRecallClass = "exact_current" | "exact_history" | "session_recent" | "semantic_memory";

export function normalizeExactRecallText(value: unknown): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function queryTargetsExactIdentifier(query: string): boolean {
  const text = String(query || "").trim();
  if (!text) return false;
  if (STRONG_IDENTIFIER_RECALL_RE.test(text)) return true;
  if (!PROGRAMMING_CODE_CONTEXT_RE.test(text) && CODE_IDENTIFIER_RECALL_RE.test(text)) return true;
  return IDENTIFIER_SUBJECT_RE.test(text) && IDENTIFIER_RECALL_ACTION_RE.test(text);
}

export function isValidIdentifierToken(value: string): boolean {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+){2,}$/.test(normalized)) return false;
  return normalized.split("-").filter((segment) => /[A-Z]/.test(segment)).length >= 2;
}

export function queryNeedsIdentifierComparison(query: string): boolean {
  const text = String(query || "").trim();
  if (!IDENTIFIER_SUBJECT_RE.test(text)) return false;
  return /\b(?:compare|history|versions?|candidates?|older\s+versions|previous\s+versions|list\s+(?:all\s+)?(?:versions|tokens|identifiers)|show\s+(?:me\s+)?(?:history|versions)|all\s+tokens|all\s+identifiers|every\s+version)\b/i.test(text);
}

export function queryPrefersRecentIdentifier(query: string): boolean {
  return /\b(?:newest|latest|recent|recently|current|currently|just|fresh|most\s+recent(?:ly)?)\b/i.test(query);
}

export function queryRejectsOlderCandidates(query: string): boolean {
  return /\b(?:newest|latest|current|currently|corrected|active|use\s+now|right\s+now|not\s+one\s+of\s+the\s+older|not\s+one\s+of\s+the\s+outdated|outdated|older)\b/i.test(
    query,
  );
}

export function queryAsksForNewestStoredIdentifier(query: string): boolean {
  return /\b(?:most\s+recently\s+stored|just\s+saved|use\s+now|active\s+right\s+now|which\s+one\s+should\s+i\s+use\s+now)\b/i.test(
    query,
  );
}

export function isIdentifierOnlyReplyQuery(query: string): boolean {
  return /\b(?:reply|respond|answer)\s+with\s+only\s+(?:the\s+)?(?:token|identifier|id|code)\b/i.test(query);
}

export function classifyExactRecallQuery(query: string): QueryRecallClass {
  const text = String(query || "").trim();
  if (!text) return "semantic_memory";
  if (queryNeedsIdentifierComparison(text)) return "exact_history";
  if (
    /\bwhat\s+did\s+i\s+just\s+(?:say|store|save)\b/i.test(text) ||
    /\b(?:what|which|tell|remind|recall|retrieve|show|list|summari[sz]e)\b[\s\S]{0,80}\b(?:earlier\s+in\s+this\s+chat|in\s+this\s+session|from\s+this\s+session)\b/i.test(text)
  ) {
    return "session_recent";
  }
  if (queryTargetsExactIdentifier(text)) return "exact_current";
  return "semantic_memory";
}

export function extractIdentifierValues(text: string): string[] {
  return Array.from(
    new Set(
      (text.match(IDENTIFIER_VALUE_RE) || [])
        .map((entry) => entry.trim())
        .filter((entry) => entry.split("-").filter((segment) => /[A-Z]/.test(segment)).length >= 2),
    ),
  );
}

export function extractIdentifierValue(text: string): string | null {
  return extractIdentifierValues(text)[0] ?? null;
}

export function buildIdentifierQueryVariant(query: string): string | null {
  if (!queryTargetsExactIdentifier(query)) return null;
  const variant = normalizeExactRecallText(query)
    .replace(
      /\b(?:what|which|exact|tokens?|identifiers?|ids?|newest|latest|current|currently|just|saved|most|recent|reply|respond|answer|with|only|the|should|use|for|this|one|ones|older|outdated|active|right|now|not|i)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return variant.split(/\s+/).length >= 2 ? variant : null;
}

export function stripIdentifiersForSubjectKey(text: string): string {
  return normalizeExactRecallText(
    text
      .replace(TIME_FRAGMENT_RE, " ")
      .replace(IDENTIFIER_VALUE_RE, " ")
      .replace(LONG_NUMBER_RE, " ")
      .replace(/\b(?:updated|stored|saved|recorded|release|gate|token|exact|newest|latest|current|reply|only|test)\b/gi, " "),
  );
}

export function scoreIdentifierCoverage(query: string, content: string): number {
  const queryTerms = Array.from(
    new Set(
      normalizeExactRecallText(query)
        .split(/\s+/)
        .filter(
          (term) =>
            term.length >= 4 &&
            !/^(?:what|which|exact|token|identifier|newest|latest|current|saved|recent|reply|with|only|should|this|that|just|most|use|used|into|from)$/i.test(term),
        ),
    ),
  );
  if (queryTerms.length === 0) return 0;
  const normalizedContent = normalizeExactRecallText(content);
  return queryTerms.reduce((sum, term) => sum + (normalizedContent.includes(term) ? 1 : 0), 0);
}

export function scoreIdentifierPrecision(query: string, content: string): number {
  const normalizedQuery = normalizeExactRecallText(query);
  const normalizedContent = normalizeExactRecallText(content);
  let penalty = 0;
  if (!normalizedQuery.includes("collision") && normalizedContent.includes("collision")) penalty += 1.2;
  if (!normalizedQuery.includes("test") && normalizedContent.includes("test")) penalty += 0.6;
  if (/\b(?:legacy|archived|archive|outdated|superseded)\b/i.test(content)) penalty += 2.2;
  if (/\bprevious\s+(?:sprint|run|release)\b/i.test(content)) penalty += 2.4;
  if (/\bold(?:er)?\b/i.test(content) && !/\bshould\s+i\s+compare\b/i.test(query)) penalty += 1.1;
  return -penalty;
}

export function scoreIdentifierSubjectFamily(query: string, content: string): number {
  const normalizedQuery = normalizeExactRecallText(query);
  const normalizedContent = normalizeExactRecallText(content);
  let score = 0;

  const weightedTerms: Array<[string, number]> = [
    ["collision", 4],
    ["current collision", 3],
    ["collision test", 3],
    ["test", 1.5],
    ["release gate", 1.5],
    ["orange circuit", 1.2],
  ];
  for (const [term, weight] of weightedTerms) {
    const queryHas = normalizedQuery.includes(term);
    const contentHas = normalizedContent.includes(term);
    if (queryHas && contentHas) score += weight;
    else if (queryHas && !contentHas) score -= weight;
  }

  const queryNumbers = Array.from(new Set(String(query).match(LONG_NUMBER_RE) || []));
  if (queryNumbers.length > 0) {
    const contentNumbers = new Set(String(content).match(LONG_NUMBER_RE) || []);
    score += queryNumbers.reduce((sum, number) => sum + (contentNumbers.has(number) ? 5 : -2), 0);
  }

  return score;
}

export function scoreIdentifierFreshnessCue(query: string, content: string): number {
  if (!queryRejectsOlderCandidates(query)) return 0;
  const identifier = extractIdentifierValue(content) || "";
  let score = 0;
  if (/-NEW-/i.test(identifier)) score += 4;
  if (/-MID-/i.test(identifier)) score += 1;
  if (/-OLD-/i.test(identifier)) score -= 4;
  if (/\b(?:newest|latest|current|active|corrected)\b/i.test(content)) score += 0.8;
  if (/\b(?:older|outdated|previous|superseded)\b/i.test(content)) score -= 0.8;
  return score;
}

export function coerceExactRecallTimestamp(candidate: ExactRecallCandidate): number {
  const values = [candidate.lastReinforcedAt, candidate.updated, candidate.created];
  for (const value of values) {
    const timestamp = Date.parse(String(value || ""));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

export function inferMemoryLaneFromCandidate(candidate: ExactRecallCandidate): MemoryLane {
  const content = String(candidate.content || "");
  const path = String(candidate.path || "");
  const tags = Array.isArray(candidate.tags) ? candidate.tags.map((tag) => String(tag).trim().toLowerCase()) : [];
  const metadata = candidate.metadata ?? {};
  if (candidate.sessionId || path.startsWith("session:")) return "session_history";
  if (
    tags.includes("scope:test") ||
    String(metadata.scope || "").toLowerCase() === "test" ||
    String(metadata.lane || "").toLowerCase() === "ephemeral_test" ||
    /\bscope\s*[:=]\s*test\b/i.test(content) ||
    /\bregression\b/i.test(content) ||
    /\bcollision test\b/i.test(content)
  ) {
    return "ephemeral_test";
  }
  return "persistent_facts";
}

export function inferPreferredMemoryLane(query: string): MemoryLane {
  if (/\b(?:what\s+did\s+i\s+just\s+(?:say|store)|earlier\s+in\s+this\s+chat|in\s+this\s+session)\b/i.test(query)) {
    return "session_history";
  }
  if (
    /\b(?:regression|collision|collision\s+test|regression\s+test|archived\s+run|previous\s+sprint|release\s+gate)\b/i.test(
      query,
    )
  ) {
    return "ephemeral_test";
  }
  return "persistent_facts";
}

export function applyLaneScoreMultiplier(query: string, candidate: ExactRecallCandidate): number {
  const preferred = inferPreferredMemoryLane(query);
  const lane = inferMemoryLaneFromCandidate(candidate);
  const expiresAt = Date.parse(String(candidate.metadata?.expiresAt || ""));
  const isExpiredTestCandidate = lane === "ephemeral_test" && Number.isFinite(expiresAt) && expiresAt <= Date.now();
  if (isExpiredTestCandidate) return preferred === "ephemeral_test" ? 0.55 : 0.18;
  if (preferred === lane) return 1.12;
  if (lane === "ephemeral_test" && preferred !== "ephemeral_test") return 0.45;
  if (lane === "session_history" && preferred === "persistent_facts") return 0.82;
  if (lane === "persistent_facts" && preferred === "session_history") return 0.86;
  return 1;
}

export function filterExactIdentifierCandidates<T extends ExactRecallCandidate>(query: string, candidates: T[]): T[] {
  if (candidates.length <= 1) return candidates;
  const normalizedQuery = normalizeExactRecallText(query);
  let filtered = [...candidates];

  const requirePhrase = (phrase: string) => {
    if (!normalizedQuery.includes(phrase)) return;
    const narrowed = filtered.filter((candidate) => normalizeExactRecallText(candidate.content).includes(phrase));
    if (narrowed.length > 0) filtered = narrowed;
  };

  requirePhrase("release gate");
  requirePhrase("collision");
  requirePhrase("collision test");
  requirePhrase("orange circuit");

  const queryNumbers = Array.from(new Set(String(query).match(LONG_NUMBER_RE) || []));
  if (queryNumbers.length > 0) {
    const narrowed = filtered.filter((candidate) => queryNumbers.some((number) => String(candidate.content).includes(number)));
    if (narrowed.length > 0) filtered = narrowed;
  }

  const staleTrimmed = filtered.filter(
    (candidate) => !/\b(?:legacy|archived|archive|outdated|superseded|previous\s+(?:sprint|run|release))\b/i.test(candidate.content),
  );
  if (staleTrimmed.length > 0) filtered = staleTrimmed;

  if (queryRejectsOlderCandidates(query)) {
    const narrowed = filtered.filter((candidate) => scoreIdentifierFreshnessCue(query, candidate.content) >= 0);
    if (narrowed.length > 0) filtered = narrowed;
  }

  return filtered;
}

export function compareExactRecallCandidates(query: string, left: ExactRecallCandidate, right: ExactRecallCandidate): number {
  const rightFamily = scoreIdentifierSubjectFamily(query, right.content);
  const leftFamily = scoreIdentifierSubjectFamily(query, left.content);
  if (rightFamily !== leftFamily) return rightFamily - leftFamily;

  const rightFreshness = scoreIdentifierFreshnessCue(query, right.content);
  const leftFreshness = scoreIdentifierFreshnessCue(query, left.content);
  if (rightFreshness !== leftFreshness) return rightFreshness - leftFreshness;

  const rightCoverage = scoreIdentifierCoverage(query, right.content);
  const leftCoverage = scoreIdentifierCoverage(query, left.content);
  if (rightCoverage !== leftCoverage) return rightCoverage - leftCoverage;

  const rightPrecision = scoreIdentifierPrecision(query, right.content);
  const leftPrecision = scoreIdentifierPrecision(query, left.content);
  if (rightPrecision !== leftPrecision) return rightPrecision - leftPrecision;

  const rightRecency = coerceExactRecallTimestamp(right);
  const leftRecency = coerceExactRecallTimestamp(left);
  if (rightRecency !== leftRecency) return rightRecency - leftRecency;

  const rightScore = Number(right.score || 0) * applyLaneScoreMultiplier(query, right);
  const leftScore = Number(left.score || 0) * applyLaneScoreMultiplier(query, left);
  return rightScore - leftScore;
}

export function reorderIdentifierFocusedResults<T extends ExactRecallCandidate>(query: string, ranked: T[]): T[] {
  if (!queryTargetsExactIdentifier(query) || ranked.length <= 1) return ranked;

  const candidates = ranked.filter((entry) => extractIdentifierValues(entry.content).length > 0);
  if (candidates.length < 2) return ranked;

  const entryKey = (entry: T) => `${entry.path || ""}:${entry.id || ""}:${entry.content}`;
  const groups = new Map<string, T[]>();
  for (const entry of candidates) {
    const key = stripIdentifiersForSubjectKey(entry.content) || normalizeExactRecallText(entry.content);
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }

  const staleKeys = new Set<string>();
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    const sorted = [...entries].sort((left, right) => compareExactRecallCandidates(query, left, right));
    for (const stale of sorted.slice(1)) staleKeys.add(entryKey(stale));
  }

  if (staleKeys.size === 0) return ranked;
  const fresh = ranked.filter((entry) => !staleKeys.has(entryKey(entry)));
  const stale = ranked.filter((entry) => staleKeys.has(entryKey(entry)));
  return [...fresh, ...stale];
}

export function resolveExactIdentifierCandidate<T extends ExactRecallCandidate>(
  query: string,
  candidates: T[],
  sessionContext = "",
): ExactRecallResolution<T> | null {
  if (!queryTargetsExactIdentifier(query) || queryNeedsIdentifierComparison(query)) return null;
  const rankingQuery = `${sessionContext} ${query}`.trim();
  const filtered = filterExactIdentifierCandidates(rankingQuery, candidates.filter((entry) => extractIdentifierValue(entry.content)));
  if (!filtered.length) return null;

  const newestTimestamp = Math.max(...filtered.map(coerceExactRecallTimestamp));
  const narrowed =
    (queryRejectsOlderCandidates(rankingQuery) || queryAsksForNewestStoredIdentifier(rankingQuery)) && newestTimestamp > 0
      ? filtered.filter((entry) => newestTimestamp - coerceExactRecallTimestamp(entry) <= 180_000)
      : filtered;
  const pool = narrowed.length > 0 ? narrowed : filtered;
  const winner = [...pool].sort((left, right) => compareExactRecallCandidates(rankingQuery, left, right))[0];
  if (!winner) return null;
  const identifier = extractIdentifierValue(winner.content);
  if (!identifier) return null;
  return {
    identifier,
    winner,
    grouped: pool,
    rankingQuery,
  };
}
