export type WebChatIntentKind =
  | "direct-answer"
  | "read-only-tool"
  | "unknown-tool"
  | "app-navigation"
  | "app-read"
  | "app-mutation-proposal"
  | "workflow-execution"
  | "clarification"
  | "fallback";

export type WebChatIntent = {
  kind: WebChatIntentKind;
  confidence: number;
  reason: string;
  readOnly: boolean;
  requiresConfirmation: boolean;
  surface?: "chat" | "workflows" | "boards" | "hierarchy" | "council" | "agents" | "settings" | "files" | "memory" | "designs";
  surfaceConfidence?: number;
  requestedToolName?: string;
};

export type WebChatIntentContext = {
  sessionId: string;
};

// Chitchat: greetings, math, creative writing, pure knowledge trivia —
// these get the no-tools fast-path because the model can answer from
// internal knowledge and never needs to inspect the workspace.
const CHITCHAT_PATTERNS = [
  /^(?:hi|hey|hello|hiya|yo|hola|sup|heya|howdy|good\s+(?:morning|afternoon|evening|day)|g'?day)[\s!.]*$/i,
  /^(?:bye|goodbye|see\s+ya|cya|later|ttyl|night)[\s!.]*$/i,
  /^(?:thanks|thank\s+you|thx|ty|cheers|appreciate\s+it)[\s!.]*$/i,
  /^(?:how\s+are\s+you|how\s+(?:ya|u)\s+doin|how\s+is\s+it\s+going|what'?s\s+up)[\s?!.]*$/i,
  /^(?:write\s+(?:me\s+)?a\s+(?:poem|haiku|limerick|song|joke|story|riddle|sonnet)|tell\s+me\s+a\s+joke|tell\s+me\s+a\s+story)[\s.!?]*$/i,
  /^(?:what\s+is|what'?s)\s+\d+(?:\.?\d*)\s*[\+\-\*\/\%x×÷]\s*\d+(?:\.?\d*)[\s?]*$/i,
  /^(?:what\s+is\s+\d+(?:%|percent)\s+of\s+\d+)[\s?]*$/i,
  /^(?:is\s+\d+\s+(?:a\s+)?prime|is\s+prime\s+\d+|check\s+if\s+\d+\s+is\s+prime)[\s?]*$/i,
  /^(?:what\s+(?:is|are)|explain)\s+(?:a\s+|the\s+)?(?:closure|monad|lambda|callback|promise|async|await|prototype|inheritance|polymorphism|encapsulation|memoization|recursion|tail\s+call|event\s+loop|microtasks?|garbage\s+collection)\b/i,
  /^(?:what\s+(?:is|are)|explain)\s+(?:the\s+)?(?:difference|diff)\s+between/i,
  /^what\s+(?:is|are)\s+(?:the\s+)?(?:capital\s+of|population\s+of|largest|smallest|tallest|longest)/i,
  /^(?:what\s+is|when\s+was|who\s+was|where\s+is)\s+[a-z]{3,}/i,
];

function isChitchat(message: string): boolean {
  const m = message.trim();
  if (m.length < 2) return true;
  return CHITCHAT_PATTERNS.some((r) => r.test(m));
}

const READ_ONLY_INDICATORS = [
  /explain/i,
  /compare/i,
  /summarize/i,
  /inspect/i,
  /\blist\b/i,
  /show me what/i,
  /tell me/i,
  /what is/i,
  /^what\b/i,
  /how do/i,
  /how would/i,
  /implementation plan/i,
  /do not edit/i,
  /do not implement/i,
  /do not execute/i,
  /do not create/i,
  /do not save/i,
  /ask before/i,
];

const PROPOSAL_WORDS = /\b(plan|proposal|propose|suggest|draft|design)\b/i;

const TOOL_ACTIVITY_INDICATORS = [
  /\bresearch\b/i,
  /\bsearch\s+(for|the)\b/i,
  /\bfind\s+(out|the|a)\b/i,
  /\blook\s+up\b/i,
  /\bfetch\b/i,
  /\bbrowse\b/i,
  /\bscrape\b/i,
  /\bcrawl\b/i,
  /\binspect\b/i,
];

const MUTATION_VERBS = [
  /\bcreate\b/i,
  /\bupdate\b/i,
  /\bedit\b/i,
  /\bmodify\b/i,
  /\bchange\b/i,
  /\bpatch\b/i,
  /\bfix\b/i,
  /\breplace\b/i,
  /\bimplement\b/i,
  /\bdelete\b/i,
  /\bsave\b/i,
  /\brun\b/i,
  /\bstart\b/i,
  /\bexecute\b/i,
  /\bschedule\b/i,
  /\bconfigure\b/i,
  /\bset\s+up\b/i,
  /\benable\b/i,
  /\bdisable\b/i,
  /\btoggle\b/i,
  /\brotate\b/i,
  /\bregenerate\b/i,
  /\breset\b/i,
  /\bpause\b/i,
  /\bresume\b/i,
  /\binstall\b/i,
  /\bconnect\b/i,
  /\bsend\b/i,
];

const READ_ONLY_MUTATION_PHRASES = [
  /create.*plan/i,
  /create.*draft/i,
  /create.*proposal/i,
  /plan to/i,
  /how would.*create/i,
  /do not create/i,
  /do not edit/i,
  /do not modify/i,
  /do not change/i,
  /do not patch/i,
  /do not fix/i,
  /do not write/i,
  /do not save/i,
  /do not start/i,
  /do not run/i,
  /do not execute/i,
  /do not schedule/i,
  /do not begin/i,
  /do not launch/i,
  /without creating/i,
  /without editing/i,
  /without modifying/i,
  /without writing/i,
  /without saving/i,
  /but do not/i,
  /don't create/i,
  /don't save/i,
  /don't run/i,
  /don't start/i,
  /ask before saving/i,
];

const SURFACE_KEYWORDS: Record<NonNullable<WebChatIntent["surface"]>, RegExp[]> = {
  chat:      [/^$/],
  council:   [/\bcouncil\b/i, /\bdebate\b/i, /\bdeliberat/i, /\bverdict\b/i],
  workflows: [/\bworkflow\b/i, /\bcron\b/i, /\bnode\b/i, /\btrigger\b/i, /\bwebhook\b/i, /\bautomation\b/i],
  boards:    [/\bboard\b/i, /\btask\b/i, /\bkanban\b/i],
  hierarchy: [/\borg(anization)?\b/i, /\bhierarchy\b/i, /\bgoal\b/i],
  agents:    [/\bagent\b/i],
  settings:  [/\bsetting/i, /\bsession\s+mode\b/i, /\btool\s+mode\b/i, /\bfast\s+mode\b/i],
  files:     [/\bfile\b/i, /\bfolder\b/i, /\bdirectory\b/i],
  memory:    [/\bmemory\b/i, /\brecall\b/i],
  designs:   [/\bdesigns?\b/i, /\bdesign\s+studio\b/i],
};

const KNOWN_TOOL_NAMES = new Set([
  "web_search",
  "web_extract",
  "web_crawl",
  "fetch_url",
  "browser_action",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_back",
  "browser_press",
  "browser_get_text",
  "browser_get_links",
  "browser_get_images",
  "browser_vision",
  "browser_cdp",
  "browser_dialog",
  "browser_wait",
  "browser_screenshot",
  "browser_console",
  "computer_observe",
  "computer_list_apps",
  "computer_launch_app",
  "computer_focus_app",
  "computer_click",
  "computer_type",
  "computer_set_value",
  "computer_hotkey",
  "computer_scroll",
  "computer_drag",
  "computer_zoom",
  "computer_wait",
  "computer_stop",
  "read_file",
  "list_files",
  "search_files",
  "memory_search",
  "memory_get",
  "memory_store",
  "session_recall",
  "session_todo",
  "documents_list",
  "documents_search",
  "documents_semantic_search",
  "document_get",
  "pc_specs",
  "channel_status",
  "write_file",
  "bash_exec",
  "run_python",
  "http_request",
  "send_message",
  "board_task",
  "schedules_list",
  "webhooks_list",
  "webhooks_create",
  "webhooks_rotate_secret",
  "webhooks_toggle",
  "webhooks_delete",
]);

function hasReadOnlyIndicator(message: string): boolean {
  return READ_ONLY_INDICATORS.some((r) => r.test(message));
}

function hasProposalWord(message: string): boolean {
  return PROPOSAL_WORDS.test(message);
}

function hasToolActivity(message: string): boolean {
  return TOOL_ACTIVITY_INDICATORS.some((r) => r.test(message));
}

function hasMutationVerb(message: string): boolean {
  return MUTATION_VERBS.some((r) => r.test(message));
}

function detectAppSurfaceScored(message: string): { surface: WebChatIntent["surface"]; confidence: number } | null {
  const words = message.split(/\s+/);
  const first6 = words.slice(0, 6).join(" ");
  let bestSurface: WebChatIntent["surface"] | undefined;
  let bestScore = 0;

  for (const [surface, patterns] of Object.entries(SURFACE_KEYWORDS) as [WebChatIntent["surface"] & string, RegExp[]][]) {
    let score = 0;
    for (const pattern of patterns) {
      const matches = (message.match(new RegExp(pattern.source, "gi")) || []).length;
      score += matches;
      if (pattern.test(first6)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSurface = surface;
    }
  }

  if (bestScore === 0 || !bestSurface) return null;
  return { surface: bestSurface, confidence: Math.min(1, bestScore / 4) };
}

function isExplicitMutation(message: string): boolean {
  if (
    /\b(?:design\s+studio|designs?\s+tab|design\s+artifact)\b/i.test(message) &&
    /\b(?:build|create|make|generate|save|update|edit|modify|change|patch|fix|replace|revise)\b/i.test(message) &&
    !READ_ONLY_MUTATION_PHRASES.some((r) => r.test(message))
  ) {
    return true;
  }
  if (hasProposalWord(message) && !/\b(and|then)\s+(create|save|run|start|execute|configure|set\s+up|enable|disable|toggle|rotate|regenerate|reset)\b/i.test(message)) {
    return false;
  }
  if (!hasMutationVerb(message)) return false;
  return !READ_ONLY_MUTATION_PHRASES.some((r) => r.test(message));
}

function detectToolRequest(message: string): string | null {
  const called = message.match(/\btool\s+called\s+([a-z_]\w*)/i);
  if (called?.[1]) return called[1].toLowerCase();

  const imaginary = message.match(/\b(?:call|use|run|invoke)\s+(?:the\s+)?(?:imaginary|non[-\s]?existent|fake)\s+tool\s+([a-z_]\w*)/i);
  if (imaginary?.[1]) return imaginary[1].toLowerCase();

  const directCall = message.match(/\b(?:call|run|invoke)\s+(?:the\s+)?tool\s+([a-z_]\w*)\b/i);
  if (directCall?.[1]) return directCall[1].toLowerCase();

  const m = message.match(/use\s+(?:the\s+)?tool\s+(?:called\s+)?([a-z_]\w*)/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

export function classifyWebChatIntent(message: string, _context: WebChatIntentContext): WebChatIntent {
  const msg = message.toLowerCase().trim();

  const requestedToolName = detectToolRequest(msg);
  if (requestedToolName) {
    if (KNOWN_TOOL_NAMES.has(requestedToolName)) {
      return {
        kind: "read-only-tool",
        confidence: 0.9,
        reason: `Known tool name "${requestedToolName}" detected in message`,
        readOnly: true,
        requiresConfirmation: false,
        requestedToolName,
      };
    }
    return {
      kind: "unknown-tool",
      confidence: 0.95,
      reason: `Unrecognized tool name "${requestedToolName}" detected in message`,
      readOnly: true,
      requiresConfirmation: false,
      requestedToolName,
    };
  }

  // Pure chitchat gets the no-tools fast-path. Every other prompt —
  // including vague/novel/multi-step ones — defaults to read-only
  // tools so the model can inspect the workspace, search memory, or
  // ask a clarifying question instead of preamble-stopping or faking
  // tool-call markup. This is the tool-first posture: tools always
  // available, model decides per-turn.
  if (isChitchat(msg)) {
    return {
      kind: "direct-answer",
      confidence: 0.95,
      reason: "Pure chitchat or knowledge-only question (no tools needed)",
      readOnly: true,
      requiresConfirmation: false,
    };
  }

  const scored = detectAppSurfaceScored(msg);
  const surface = scored?.surface;
  const hasMutation = isExplicitMutation(msg);
  const hasProposal = hasProposalWord(msg);
  const hasReadOnly = hasReadOnlyIndicator(msg);
  const hasTools = hasToolActivity(msg);

  if (hasMutation && surface && !hasReadOnly) {
    const result: WebChatIntent = {
      kind: "app-mutation-proposal",
      confidence: 0.85,
      reason: `Explicit mutation verb with app surface "${surface}"`,
      readOnly: false,
      requiresConfirmation: true,
      surface,
    };
    if (scored) result.surfaceConfidence = scored.confidence;
    return result;
  }

  if (hasReadOnly || hasProposal || (surface && !hasMutation) || hasTools) {
    const result: WebChatIntent = {
      kind: "read-only-tool",
      confidence: 0.8,
      reason: "Read-only indicators or proposal words detected — attaching tools",
      readOnly: true,
      requiresConfirmation: false,
      surface,
    };
    if (scored) result.surfaceConfidence = scored.confidence;
    return result;
  }

  // Default non-chitchat prompts: always attach read-only tools so the
  // model can inspect the workspace, search memory, or ask a clarifying
  // question. This closes the critical reference-app gap where vague/novel
  // prompts reached the LLM with zero tools and produced preamble-only
  // half-answers or fake tool-call markup.
  return {
    kind: "read-only-tool",
    confidence: 0.7,
    reason: "Non-chitchat default — attaching read-only tools",
    readOnly: true,
    requiresConfirmation: false,
  };
}
