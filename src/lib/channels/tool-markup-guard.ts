import { logger } from "@/lib/utils/logger";

const log = logger.child("tool-markup-guard");

const MARKUP_LEAK_PATTERNS = [
  /<｜｜DSML｜｜tool_calls>/i,
  /(^|\n)\s*<tool_call\b/i,
  /(^|\n)\s*<invoke\s+name\s*=/i,
  /"tool_calls"\s*:/i,
  /"function_call"\s*:/i,
  /(^|\n)\s*<function_call\b/i,
  /assistant\s+to\s*=/i,
];

// Call-marker families — patterns that describe wrapper syntaxes invented
// by LLMs when they want to call a tool but have none available. This set
// intentionally does NOT enumerate wrappers (the 5th variant is always
// coming) — it covers structural marker families.
const CALL_MARKER_FAMILIES = [
  /(^|\n)\s*<function.?calls/i,
  /(^|\n)\s*<tool.?calls/i,
  /(^|\n)\s*<invoke\b/i,
  /startof_tool/i,
  /(^|\n)\s*<[^>]*dsml|dsml[\s_-]*(?:tool|call|invoke)/i,
  /(^|\n)\s*<\?xml.*<function/i,
  /(^|\n)\s*<assistant_response/i,
  /\bassistant\s+to\s*=/i,
];

// When GAP-1 (always-on read-only tools) is in effect, fake-tool markup
// should essentially disappear. This generic detector is the safety net:
// it keys off KNOWN TOOL NAMES (a closed set we own) rather than guessing
// the next wrapper syntax an LLM might invent.

let _cachedToolCatalog: Set<string> | null = null;
async function getToolCatalog(): Promise<Set<string>> {
  if (_cachedToolCatalog) return _cachedToolCatalog;
  try {
    const toolsMod = await import("@/lib/engine/tools");
    const catalog = (toolsMod as { TOOL_CATALOG?: Record<string, unknown> }).TOOL_CATALOG || {};
    _cachedToolCatalog = new Set(Object.keys(catalog));
    return _cachedToolCatalog;
  } catch {
    return new Set<string>();
  }
}

function isCallMarkerFamily(text: string): boolean {
  return CALL_MARKER_FAMILIES.some((r) => r.test(text));
}

function extractTagNames(text: string): string[] {
  const names: string[] = [];
  const tagRe = /<(\w[\w-]*)/g;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    names.push(m[1].toLowerCase());
  }
  const tokenRe = /\b(?:tool_name|tool-name|function_name|function-name)\s*[:>]\s*(\w[\w-]*)/gi;
  while ((m = tokenRe.exec(text)) !== null) {
    names.push(m[1].toLowerCase());
  }
  const colonToolRe = /\btool_name\s*:\s*(\w[\w-]*)/gi;
  while ((m = colonToolRe.exec(text)) !== null) {
    names.push(m[1].toLowerCase());
  }
  return [...new Set(names)];
}

export function hasLeakedToolMarkup(response: string): boolean {
  const trimmed = response.trim();
  if (trimmed.startsWith("```json") || trimmed.startsWith("```")) {
    try {
      const json = trimmed.replace(/```(?:json)?\s*|\s*```/g, "");
      const parsed = JSON.parse(json);
      if (
        parsed &&
        typeof parsed === "object" &&
        "tool_calls" in parsed
      )
        return true;
    } catch {
      /* not valid JSON — fall through to pattern check */
    }
  }

  const prose = response.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");

  if (MARKUP_LEAK_PATTERNS.some((p) => p.test(prose))) return true;

  if (isCallMarkerFamily(prose)) return true;

  return false;
}

export async function hasLeakedToolMarkupDeep(response: string): Promise<boolean> {
  if (hasLeakedToolMarkup(response)) return true;

  // Generic detector: extract tag names and check whether any resolves to a
  // known tool. Keys off our closed set of tool names so it catches any
  // wrapper syntax — but must not false-positive on legitimate content that
  // merely *shows* a tool name (e.g. the user asked for example XML, or the
  // answer is a security audit discussing tool mechanisms).
  try {
    const catalog = await getToolCatalog();
    if (catalog.size === 0) return false;
    // Strip fenced code blocks + inline code spans first: a tool name the
    // user explicitly asked to see as an example belongs in a code block and
    // is not a leaked call.
    const prose = response.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
    const toolTags = extractTagNames(prose).filter((name) => catalog.has(name));
    if (toolTags.length === 0) return false;

    // A known tool used directly as an XML element is call scaffolding even
    // when it is the only tool in the response and has no generic wrapper.
    // This catches forms such as <browser_navigate>...</browser_navigate>.
    const directToolElement = toolTags.some((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`<\\/?${escaped}\\b`, "i").test(prose);
    });
    if (directToolElement) {
      log.warn("tool-markup-guard: generic detector caught direct tool element", { toolTags });
      return true;
    }

    // Check for actual call scaffolding (XML tags, parameter blocks, function_call structure)
    const hasScaffolding =
      /<parameter\b|<arg(?:ument)?\b|<tool[_-]params\b|\btool[_-]name\s*[:>]|<\/?(?:function|tool)[_-]?calls?\b/i.test(prose);
    if (hasScaffolding) {
      log.warn("tool-markup-guard: generic detector caught leaked tool markup with scaffolding", { toolTags });
      return true;
    }

    // Multiple tool tags: check if they appear in a "leak" context (consecutive,
    // in a list-like structure, or with call syntax) vs normal prose discussion.
    if (toolTags.length >= 2) {
      // Check if tool names appear in a sentence-like context (surrounded by words)
      // vs in a call-like context (consecutive, with parameters, or as XML tags).
      const toolNamePattern = Array.from(new Set(toolTags)).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      // Find all occurrences of tool names in prose
      const toolMentions = prose.match(new RegExp(`\\b(?:${toolNamePattern})\\b`, "gi")) || [];

      // If tool names are mentioned in normal sentence context (with surrounding words),
      // this is likely meta-discussion, not a leak. Check for "the X tool", "using X",
      // "X returns", "X is", "called X", etc.
      const isProseDiscussion = toolMentions.some((mention) => {
        const idx = prose.indexOf(mention);
        const before = prose.slice(Math.max(0, idx - 30), idx).toLowerCase();
        const after = prose.slice(idx + mention.length, idx + mention.length + 30).toLowerCase();
        // Tool name in prose context: preceded by article/verb/preposition, followed by verb/punctuation
        return /\b(?:the|a|an|using|use|via|called|named|like|such\s+as|including|from|with|through|by)\s+$/i.test(before) ||
          /^\s+(?:is|are|was|were|returns?|provides?|handles?|checks?|reads?|writes?|searches?|lists?|executes?|runs?|calls?|tool|function|name|node|type|module)\b/i.test(after) ||
          /^\s*[.,;:)\]]/i.test(after);
      });

      if (isProseDiscussion) {
        // Tool names in normal prose — not a leak
        return false;
      }

      log.warn("tool-markup-guard: generic detector caught leaked tool markup", { toolTags });
      return true;
    }
  } catch {
    /* non-critical — the wrapper-lexicon patterns above are the primary defence */
  }

  return false;
}

export function buildRepairInstruction(
  originalMessage: string,
  leakedResponse: string,
): string {
  return `The system generated raw tool-call markup instead of a final answer. Convert this into a normal user-facing response.

User's original request: ${originalMessage}

Raw system output (DO NOT repeat this):
${leakedResponse.slice(0, 800)}

Instructions:
1. Answer the user's request directly in natural language.
2. Do NOT include any XML tags, function_call blocks, tool_calls JSON, or internal markup.
3. If the user asked for a plan or list, provide it clearly.
4. Be concise and direct.`;
}

export function buildMarkupFallbackResponse(originalMessage: string): string {
  if (/list.*files|show.*files|inspect.*workspace/i.test(originalMessage)) {
    return "I was unable to complete a clean workspace inspection. You can view files at /files and documents at /documents. To inspect safely, ask me to list files or read specific paths.";
  }
  return "I was unable to produce a clean response for this request. Please try rephrasing, or ask me to explain what happened.";
}
