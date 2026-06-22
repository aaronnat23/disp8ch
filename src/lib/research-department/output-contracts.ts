// Output contract validators for research artifacts.
//
// These are generic, side-effect-free validators. They are reused by the
// regression tests, the test-run summary, and can be wired into any agent
// output check — they do not encode answers, only structural contracts.

export const CONFIDENCE_TAGS = ["verified", "likely", "unverified", "conflicting"] as const;
export type ConfidenceTag = (typeof CONFIDENCE_TAGS)[number];

const CONFIDENCE_TAG_RE = /\[(verified|likely|unverified|conflicting)\]/gi;
const URL_RE = /https?:\/\/[^\s)\]]+/i;
const MARKDOWN_LINK_RE = /\]\([^)]+\)/;
const SOURCE_REF_RE = /(source:|\]\([^)]+\)|\.\.?\/[\w./-]+\.md|https?:\/\/)/i;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function ok(): ValidationResult {
  return { valid: true, errors: [], warnings: [] };
}

/** Returns the set of confidence tags present in a block of text. */
export function extractConfidenceTags(text: string): ConfidenceTag[] {
  const out: ConfidenceTag[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  CONFIDENCE_TAG_RE.lastIndex = 0;
  while ((match = CONFIDENCE_TAG_RE.exec(text)) !== null) {
    const tag = match[1].toLowerCase() as ConfidenceTag;
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/** A single token is a valid confidence tag (case-insensitive, allowed set only). */
export function isValidConfidenceTag(token: string): boolean {
  const normalized = String(token || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (CONFIDENCE_TAGS as readonly string[]).includes(normalized);
}

/**
 * A Scout finding must carry source provenance frontmatter: a source URL,
 * a source type, a captured timestamp, and a title/body.
 */
export function validateFinding(markdown: string): ValidationResult {
  const result = ok();
  const text = String(markdown || "");
  if (!/^---[\s\S]*?---/.test(text.trim())) {
    result.errors.push("Finding is missing YAML frontmatter.");
  }
  if (!/source_url\s*:/i.test(text)) {
    result.errors.push("Finding is missing source_url.");
  } else if (!URL_RE.test(text)) {
    result.errors.push("Finding source_url is not a valid URL.");
  }
  if (!/source_type\s*:/i.test(text)) {
    result.errors.push("Finding is missing source_type.");
  }
  if (!/captured_at\s*:/i.test(text)) {
    result.errors.push("Finding is missing captured_at.");
  }
  if (!/^#\s+.+/m.test(text)) {
    result.warnings.push("Finding has no markdown title heading.");
  }
  // Scout must not synthesize: reject recommendation/analysis verbs in output.
  if (/\b(i recommend|you should|my analysis|in conclusion|recommendation:)\b/i.test(text)) {
    result.errors.push("Scout finding contains synthesis/recommendation language.");
  }
  result.valid = result.errors.length === 0;
  return result;
}

/**
 * An Analyst wiki note must cite sources for factual claims and tag every
 * claim with exactly one allowed confidence tag.
 */
export function validateWikiNote(markdown: string): ValidationResult {
  const result = ok();
  const text = String(markdown || "");
  const tags = extractConfidenceTags(text);
  if (tags.length === 0) {
    result.errors.push("Wiki note has no confidence tags.");
  }

  // Reject confidence tokens outside the allowed set, e.g. "[true]" / "[maybe]".
  const bracketTokens = text.match(/\[[a-z]+\]/gi) || [];
  for (const token of bracketTokens) {
    const inner = token.slice(1, -1).toLowerCase();
    // Ignore wikilinks and obvious non-confidence brackets.
    if (inner.length < 4) continue;
    if (/^(verified|likely|unverified|conflicting)$/.test(inner)) continue;
    if (/^(claims|evidence|related|notes|open|questions|topic|urgent|dir)$/.test(inner)) continue;
    if (/^(true|false|maybe|certain|confirmed|fact|high|low|medium)$/.test(inner)) {
      result.errors.push(`Invalid confidence-style tag: ${token}`);
    }
  }

  // Each claim bullet that asserts a fact must include a source reference.
  const claimLines = text
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s*\[(verified|likely|unverified|conflicting)\]/i.test(line));
  for (const line of claimLines) {
    if (!SOURCE_REF_RE.test(line)) {
      result.errors.push(`Claim is missing a source citation: ${line.trim().slice(0, 80)}`);
    }
  }
  if (claimLines.length === 0 && tags.length > 0) {
    result.warnings.push("Confidence tags present but no claim bullets detected.");
  }

  result.valid = result.errors.length === 0;
  return result;
}

/** Citation check: any line asserting a fact must contain a URL or file ref. */
export function validateCitations(markdown: string): ValidationResult {
  const result = ok();
  const text = String(markdown || "");
  const factLines = text
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s/.test(line) && /\b(is|are|will|has|reported|announced|released|raised|launched)\b/i.test(line));
  for (const line of factLines) {
    if (!URL_RE.test(line) && !MARKDOWN_LINK_RE.test(line) && !/\.md\b/.test(line) && !/source:/i.test(line)) {
      result.warnings.push(`Possible factual claim without citation: ${line.trim().slice(0, 80)}`);
    }
  }
  result.valid = true;
  return result;
}

export interface BriefValidationOptions {
  maxBullets?: number;
}

/**
 * A morning brief must contain only a heading (optional), 1..N top-level
 * bullets, and a final usage/cost line. Every item needs an explicit confidence
 * tag so downstream delivery never presents unlabelled model claims as fact.
 */
export function validateBrief(markdown: string, options: BriefValidationOptions = {}): ValidationResult {
  const result = ok();
  const text = String(markdown || "");
  const maxBullets = options.maxBullets ?? 5;
  const lines = text.split(/\r?\n/);
  // Recognize -, *, • bullets and numbered items (1. / 1)), including when the
  // line is wrapped in bold/emphasis markers (e.g. "**1. ...**" or "- **...**").
  const bulletIndexes = lines
    .map((line, index) => (/^\s*(?:[-*•]\s+|(?:[*_]{2}\s*)?\d+[.)]\s+)/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const bullets = bulletIndexes.map((index) => lines[index]!);
  if (bullets.length === 0) {
    result.errors.push("Brief has no bullet points.");
  }
  if (bullets.length > maxBullets) {
    result.errors.push(`Brief has ${bullets.length} bullets (max ${maxBullets}).`);
  }
  for (const bullet of bullets) {
    if (!/\[(verified|likely|unverified|conflicting)\]/i.test(bullet)) {
      result.errors.push(`Brief item is missing a confidence tag: ${bullet.trim().slice(0, 80)}`);
    }
  }

  if (bulletIndexes.length > 0) {
    const firstBullet = bulletIndexes[0]!;
    const lastBullet = bulletIndexes[bulletIndexes.length - 1]!;
    const preamble = lines
      .slice(0, firstBullet)
      .filter((line) => line.trim() && !/^\s*#{1,6}\s+\S/.test(line));
    if (preamble.length > 0) {
      result.errors.push("Brief contains prose before the first item.");
    }
    const trailing = lines
      .slice(lastBullet + 1)
      .filter((line) => line.trim() && !/\busage\b|\btokens?\b|\$\s*\d|cost/i.test(line));
    if (trailing.length > 0) {
      result.errors.push("Brief contains prose after the final item.");
    }
  }
  if (!/\busage\b|\btokens?\b|\$\s*\d|cost/i.test(text)) {
    result.warnings.push("Brief does not include a usage/cost line.");
  }
  result.valid = result.errors.length === 0;
  return result;
}

/** Detect whether a new claim contradicts an existing wiki claim. */
export function detectContradiction(
  newClaim: string,
  existingClaims: string[],
): { contradiction: boolean; against?: string } {
  const negate = (s: string) =>
    s
      .toLowerCase()
      .replace(/\bis not\b|\bisn't\b|\bno longer\b|\bnever\b/g, "§NEG§")
      .replace(/\bis\b|\bare\b|\bwill\b/g, "§POS§");
  const a = negate(newClaim);
  for (const existing of existingClaims) {
    const b = negate(existing);
    // Shared subject tokens but opposite polarity markers.
    const subjA = a.replace(/§NEG§|§POS§/g, "").trim();
    const subjB = b.replace(/§NEG§|§POS§/g, "").trim();
    const overlap = sharedTokenRatio(subjA, subjB);
    const aPolarity = a.includes("§NEG§") ? "neg" : "pos";
    const bPolarity = b.includes("§NEG§") ? "neg" : "pos";
    if (overlap > 0.5 && aPolarity !== bPolarity) {
      return { contradiction: true, against: existing };
    }
  }
  return { contradiction: false };
}

function sharedTokenRatio(a: string, b: string): number {
  const ta = new Set(a.split(/\W+/).filter((w) => w.length > 3));
  const tb = new Set(b.split(/\W+/).filter((w) => w.length > 3));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}
