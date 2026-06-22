/**
 * Fuzzy File Patching — intelligent search-and-replace for LLM-driven file editing.
 *
 * When an LLM wants to edit a file, it sends `search` (the lines to find) and
 * `replace` (the replacement). This module finds the best match in the file
 * even when line numbers drift, whitespace varies, or the LLM's version is
 * slightly wrong.
 *
 * Strategy:
 *   1. Exact match (fast path)
 *   2. Whitespace-normalized match
 *   3. Blank-line-insensitive match
 *   4. Anchor match (stable first/last lines, drift in between)
 *   5. Fuzzy match (Levenshtein-based scoring of candidate windows)
 */

/* ── Types ──────────────────────────────────────────────────────────────── */

export type FuzzyPatchResult =
  | { success: true; patched: string; matchType: "exact" | "normalized" | "blankline" | "anchor" | "fuzzy"; matchLine: number; confidence: number }
  | { success: false; error: string };

/* ── Constants ──────────────────────────────────────────────────────────── */

/** Minimum confidence (0–1) for a fuzzy match to be accepted */
const MIN_FUZZY_CONFIDENCE = 0.6;

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Apply a search-and-replace patch to file content using fuzzy matching.
 *
 * @param original  - The full file content
 * @param search    - The block of text to find (from the LLM)
 * @param replace   - The replacement text
 * @returns Result with patched content or error
 */
export function applyFuzzyPatch(
  original: string,
  search: string,
  replace: string,
): FuzzyPatchResult {
  if (!search.trim()) {
    return { success: false, error: "Search block is empty" };
  }

  // ── 1. Exact match ───────────────────────────────────────────────────
  const exactIdx = original.indexOf(search);
  if (exactIdx !== -1) {
    const patched = original.slice(0, exactIdx) + replace + original.slice(exactIdx + search.length);
    const matchLine = original.slice(0, exactIdx).split("\n").length;
    return { success: true, patched, matchType: "exact", matchLine, confidence: 1.0 };
  }

  // ── 2. Whitespace-normalized match ───────────────────────────────────
  const normalizedResult = tryNormalizedMatch(original, search, replace);
  if (normalizedResult) {
    return normalizedResult;
  }

  // ── 3. Blank-line-insensitive match ──────────────────────────────────
  const blanklineResult = tryBlanklineInsensitiveMatch(original, search, replace);
  if (blanklineResult) {
    return blanklineResult;
  }

  // ── 4. Anchor-based match ────────────────────────────────────────────
  const anchorResult = tryAnchorMatch(original, search, replace);
  if (anchorResult) {
    return anchorResult;
  }

  // ── 5. Fuzzy sliding-window match ────────────────────────────────────
  const fuzzyResult = tryFuzzyMatch(original, search, replace);
  if (fuzzyResult) {
    return fuzzyResult;
  }

  return {
    success: false,
    error: "No match found — the search block does not match any region of the file (tried exact, whitespace-normalized, blank-line-insensitive, anchor, and fuzzy matching)",
  };
}

/* ── Whitespace-normalized match ────────────────────────────────────────── */

function normalizeLines(text: string): string[] {
  return text.split("\n").map(normalizeLine);
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function tryNormalizedMatch(
  original: string,
  search: string,
  replace: string,
): FuzzyPatchResult | null {
  const origLines = original.split("\n");
  const searchNorm = normalizeLines(search);
  const searchLen = searchNorm.length;

  // Remove trailing empty lines from search for flexible matching
  while (searchNorm.length > 0 && searchNorm[searchNorm.length - 1] === "") {
    searchNorm.pop();
  }
  if (searchNorm.length === 0) return null;
  const effectiveLen = searchNorm.length;

  for (let i = 0; i <= origLines.length - effectiveLen; i++) {
    let matched = true;
    for (let j = 0; j < effectiveLen; j++) {
      if (origLines[i + j].trim() !== searchNorm[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      // Determine how many original lines to replace — use searchLen (before trailing-empty trim)
      // but clamp to effectiveLen if the file doesn't have extra blank lines there
      const replaceCount = Math.min(searchLen, origLines.length - i);
      const actualReplace = Math.max(effectiveLen, replaceCount);
      const before = origLines.slice(0, i);
      const after = origLines.slice(i + actualReplace);
      const replaceLines = replace.split("\n");
      const patched = [...before, ...replaceLines, ...after].join("\n");
      return {
        success: true,
        patched,
        matchType: "normalized",
        matchLine: i + 1,
        confidence: 0.95,
      };
    }
  }
  return null;
}

/* ── Blank-line-insensitive match ─────────────────────────────────────── */

function tryBlanklineInsensitiveMatch(
  original: string,
  search: string,
  replace: string,
): FuzzyPatchResult | null {
  const origLines = original.split("\n");
  const searchLines = search.split("\n");
  const significantSearch = searchLines.map(normalizeLine).filter(Boolean);
  if (significantSearch.length === 0) return null;

  for (let start = 0; start < origLines.length; start++) {
    let origIndex = start;
    let searchIndex = 0;
    let consumed = 0;
    const maxConsumed = Math.max(searchLines.length + 6, significantSearch.length);

    while (origIndex < origLines.length && searchIndex < significantSearch.length && consumed <= maxConsumed) {
      const candidate = normalizeLine(origLines[origIndex] ?? "");
      if (!candidate) {
        origIndex++;
        consumed++;
        continue;
      }
      if (candidate !== significantSearch[searchIndex]) {
        break;
      }
      origIndex++;
      searchIndex++;
      consumed++;
    }

    if (searchIndex === significantSearch.length) {
      const before = origLines.slice(0, start);
      const after = origLines.slice(origIndex);
      const patched = [...before, ...replace.split("\n"), ...after].join("\n");
      return {
        success: true,
        patched,
        matchType: "blankline",
        matchLine: start + 1,
        confidence: 0.9,
      };
    }
  }

  return null;
}

/* ── Anchor match ──────────────────────────────────────────────────────── */

function tryAnchorMatch(
  original: string,
  search: string,
  replace: string,
): FuzzyPatchResult | null {
  const origLines = original.split("\n");
  const searchLines = search.split("\n");
  const significant = searchLines.map(normalizeLine).filter(Boolean);
  if (significant.length < 2) return null;

  const first = significant[0];
  const last = significant[significant.length - 1];
  const expectedSpan = Math.max(searchLines.length, significant.length);

  let bestScore = -1;
  let bestStart = -1;
  let bestEnd = -1;

  for (let start = 0; start < origLines.length; start++) {
    if (normalizeLine(origLines[start] ?? "") !== first) continue;

    const maxEnd = Math.min(origLines.length - 1, start + expectedSpan + 8);
    for (let end = start + 1; end <= maxEnd; end++) {
      if (normalizeLine(origLines[end] ?? "") !== last) continue;
      const candidate = origLines.slice(start, end + 1).join("\n");
      const score = computeSimilarity(candidate, search);
      if (score > bestScore) {
        bestScore = score;
        bestStart = start;
        bestEnd = end;
      }
    }
  }

  if (bestScore < 0.55 || bestStart < 0 || bestEnd < bestStart) {
    return null;
  }

  const before = origLines.slice(0, bestStart);
  const after = origLines.slice(bestEnd + 1);
  const patched = [...before, ...replace.split("\n"), ...after].join("\n");
  return {
    success: true,
    patched,
    matchType: "anchor",
    matchLine: bestStart + 1,
    confidence: Math.round(bestScore * 100) / 100,
  };
}

/* ── Fuzzy match (Levenshtein-based sliding window) ─────────────────────── */

function tryFuzzyMatch(
  original: string,
  search: string,
  replace: string,
): FuzzyPatchResult | null {
  const origLines = original.split("\n");
  const searchLines = search.split("\n");

  // Remove trailing empty search lines
  while (searchLines.length > 0 && searchLines[searchLines.length - 1].trim() === "") {
    searchLines.pop();
  }
  if (searchLines.length === 0) return null;

  const windowSize = searchLines.length;
  if (windowSize > origLines.length) return null;

  let bestScore = -1;
  let bestStart = -1;
  let bestLen = windowSize;

  // Slide a window of size windowSize ± 2 over the original
  for (let delta = 0; delta <= 2; delta++) {
    for (const sign of [0, 1, -1]) {
      const wSize = windowSize + sign * delta;
      if (wSize < 1 || wSize > origLines.length) continue;

      for (let i = 0; i <= origLines.length - wSize; i++) {
        const candidate = origLines.slice(i, i + wSize).join("\n");
        const score = computeSimilarity(candidate, searchLines.join("\n"));
        if (score > bestScore) {
          bestScore = score;
          bestStart = i;
          bestLen = wSize;
        }
      }
    }
  }

  if (bestScore < MIN_FUZZY_CONFIDENCE || bestStart < 0) {
    return null;
  }

  const before = origLines.slice(0, bestStart);
  const after = origLines.slice(bestStart + bestLen);
  const replaceLines = replace.split("\n");
  const patched = [...before, ...replaceLines, ...after].join("\n");

  return {
    success: true,
    patched,
    matchType: "fuzzy",
    matchLine: bestStart + 1,
    confidence: Math.round(bestScore * 100) / 100,
  };
}

/* ── Similarity scoring ─────────────────────────────────────────────────── */

/**
 * Compute a 0–1 similarity score between two strings.
 * Uses a line-level comparison for speed, falling back to
 * character-level Levenshtein for short strings.
 */
function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0;

  // Line-level comparison
  const aLines = a.split("\n").map(normalizeLine);
  const bLines = b.split("\n").map(normalizeLine);
  const maxLines = Math.max(aLines.length, bLines.length);

  if (maxLines === 0) return 1.0;

  let matchingLines = 0;
  const minLines = Math.min(aLines.length, bLines.length);

  for (let i = 0; i < minLines; i++) {
    if (aLines[i] === bLines[i]) {
      matchingLines++;
    } else {
      // Partial line similarity via character-level distance
      const lineSim = 1 - levenshteinDistance(aLines[i], bLines[i]) / Math.max(aLines[i].length, bLines[i].length, 1);
      if (lineSim > 0.7) {
        matchingLines += lineSim;
      }
    }
  }

  return matchingLines / maxLines;
}

/**
 * Standard Levenshtein edit distance.
 * Capped at 500 chars per input for performance.
 */
function levenshteinDistance(a: string, b: string): number {
  const sa = a.slice(0, 500);
  const sb = b.slice(0, 500);
  const la = sa.length;
  const lb = sb.length;

  if (la === 0) return lb;
  if (lb === 0) return la;

  // Single-row DP
  const row = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) row[j] = j;

  for (let i = 1; i <= la; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = sa[i - 1] === sb[j - 1] ? 0 : 1;
      const val = Math.min(
        row[j] + 1,        // deletion
        row[j - 1] + 1,    // insertion
        prev + cost,        // substitution
      );
      prev = row[j];
      row[j] = val;
    }
  }
  return row[lb];
}
