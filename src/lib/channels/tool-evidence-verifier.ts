/**
 * Tool-evidence verifier. A deterministic guard that prevents a final answer
 * from CLAIMING it used capabilities (browser navigation/screenshots, desktop
 * computer use) when no matching tool was actually invoked in the turn.
 *
 * This is allowed runtime structure: a verifier that requires a missing
 * evidence category. It carries no per-topic answers, no benchmark IDs, and no
 * canned conclusions — it only checks whether a first-person capability claim is
 * backed by real tool events, and neutralizes the claim when it is not.
 *
 * It is deliberately conservative: it only acts on explicit first-person "I
 * navigated/opened the browser / took a screenshot / clicked on the desktop"
 * style claims, never on neutral descriptions of what a capability can do.
 */

export type ToolEvidenceCategory = "browser" | "computer_use";

export type ToolEvidenceVerifyResult = {
  answer: string;
  changed: boolean;
  /** Categories whose claims were unsupported and neutralized. */
  flagged: ToolEvidenceCategory[];
};

function hasBrowserEvidence(usedToolNames: Iterable<string>): boolean {
  for (const name of usedToolNames) {
    if (typeof name === "string" && name.startsWith("browser_")) return true;
  }
  return false;
}

function hasComputerEvidence(usedToolNames: Iterable<string>): boolean {
  for (const name of usedToolNames) {
    if (typeof name === "string" && name.startsWith("computer_")) return true;
  }
  return false;
}

// First-person claims of having actually driven a browser. Present/past/perfect.
// Requires both an action verb and a browser/page object so neutral prose like
// "you can browse the web with the browser tool" is NOT matched.
const BROWSER_NAV_CLAIM =
  /\b(?:i|i['’]ve|i\s+have|we|we['’]ve|we\s+have)\s+(?:just\s+|already\s+)?(?:navigat\w*|brows\w*|visit\w*|open\w*|load\w*|access\w*|went\s+to|pulled\s+up)\b[^.!?\n]*(?:\b(?:browser|web\s*page|webpage|page|url|website|site)\b|https?:\/\/\S+)/i;

const SCREENSHOT_CLAIM =
  /\b(?:i|i['’]ve|i\s+have|we|we['’]ve|we\s+have)\s+(?:just\s+|already\s+)?(?:took|taken|captured|grabbed|saved|made)\s+(?:a\s+|the\s+)?screenshot/i;

const USED_BROWSER_CLAIM =
  /\b(?:i|we)\s+(?:just\s+)?us(?:ed|ing)\s+(?:the\s+)?browser(?:\s+(?:tool|navigation|automation))?/i;

// First-person claims of having driven the local desktop / computer use.
const COMPUTER_CLAIM =
  /\b(?:i|i['’]ve|i\s+have|we|we['’]ve|we\s+have)\s+(?:just\s+|already\s+)?(?:clicked|typed|controlled|observed|interacted\s+with|automated)\b[^.!?\n]*\b(?:desktop|screen|app\s+window|application\s+window|on\s+your\s+(?:computer|machine|pc))\b/i;

const USED_COMPUTER_CLAIM =
  /\b(?:i|we)\s+(?:just\s+)?us(?:ed|ing)\s+computer[-\s]?use\b/i;

const BROWSER_DISCLAIMER =
  "I could not verify this with browser tools in this session, so treat any browsing-based detail as unconfirmed.";
const COMPUTER_DISCLAIMER =
  "I could not verify this with computer-use tools in this session, so treat any desktop-action detail as unconfirmed.";

function splitSentences(line: string): string[] {
  // Keep the delimiter with the sentence so rejoining is loss-free.
  const parts = line.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g);
  return parts ?? [line];
}

/**
 * Neutralize unsupported capability claims in a final answer.
 *
 * @param answer the draft final answer
 * @param usedToolNames the tool names actually invoked during the turn
 */
export function verifyToolEvidenceClaims(answer: string, usedToolNames: Iterable<string>): ToolEvidenceVerifyResult {
  const text = String(answer || "");
  if (!text.trim()) return { answer: text, changed: false, flagged: [] };

  const browserOk = hasBrowserEvidence(usedToolNames);
  const computerOk = hasComputerEvidence(usedToolNames);
  if (browserOk && computerOk) return { answer: text, changed: false, flagged: [] };

  const flagged = new Set<ToolEvidenceCategory>();
  const lines = text.split(/\r?\n/);
  const outLines: string[] = [];

  for (const line of lines) {
    const sentences = splitSentences(line);
    const keptSentences: string[] = [];
    for (const sentence of sentences) {
      const browserClaim =
        !browserOk && (BROWSER_NAV_CLAIM.test(sentence) || SCREENSHOT_CLAIM.test(sentence) || USED_BROWSER_CLAIM.test(sentence));
      const computerClaim =
        !computerOk && (COMPUTER_CLAIM.test(sentence) || USED_COMPUTER_CLAIM.test(sentence));
      if (browserClaim) flagged.add("browser");
      if (computerClaim) flagged.add("computer_use");
      if (browserClaim || computerClaim) {
        // Drop the unsupported claim sentence; the disclaimer is appended once.
        continue;
      }
      keptSentences.push(sentence);
    }
    outLines.push(keptSentences.join(""));
  }

  if (flagged.size === 0) return { answer: text, changed: false, flagged: [] };

  let next = outLines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const disclaimers: string[] = [];
  if (flagged.has("browser")) disclaimers.push(BROWSER_DISCLAIMER);
  if (flagged.has("computer_use")) disclaimers.push(COMPUTER_DISCLAIMER);
  next = `${next}\n\n${disclaimers.join(" ")}`.trim();

  return { answer: next, changed: true, flagged: [...flagged] };
}
