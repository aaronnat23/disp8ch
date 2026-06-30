import { isCrossSurfaceAppMutationRequest, isBoardTaskMutationRequest } from "./cross-tab-intent";

export type AgenticMode =
  | "none"
  | "web_research"
  | "repo_inspection"
  | "code_edit"
  | "capability_audit"
  | "computer_use"
  | "app_design"
  | "design_studio"
  | "mixed";

export type AgenticTaskHint = {
  likelyNeedsRepo?: boolean;
  likelyNeedsWeb?: boolean;
  likelyNeedsAppState?: boolean;
  likelyNeedsMemory?: boolean;
  likelyNeedsDesignStudio?: boolean;
  likelyNeedsWorkflowCatalog?: boolean;
  likelyNeedsCodeEdit?: boolean;
  likelyNeedsImagePipeline?: boolean;
  likelyNeedsComputerUse?: boolean;
  safetyBoundary?: "read_only" | "proposal_only" | "confirmed_mutation" | "dedicated_pipeline";
  rawSignals?: string[];
  requestedSurfaces?: string[];
};

export type AgenticRoutingPolicy = {
  deterministicAllowed: boolean;
  agenticRequired: boolean;
  mode: AgenticMode;
  reason: string;
  confidence: "certain" | "high" | "medium" | "low";
  taskHints?: AgenticTaskHint;
};

export type CertainDeterministicKind =
  | "slash_command"
  | "protected_builtin"
  | "no_tool_boundary"
  | "memory_ack"
  | "chitchat"
  | "unknown_tool"
  | "image_pipeline"
  | "none";

export type CertainDeterministicDecision = {
  kind: CertainDeterministicKind;
  reason: string;
};

export type RoutingContext = {
  protectedBuiltin: boolean;
  explicitSlashCommand: boolean;
  intentKind?: string;
};

function isPlanOnlyRequest(message: string): boolean {
  return (
    /\bdo\s+not\s+(?:create|save|start|run|execute|schedule|send|publish|post|deploy|modify|change|edit|update|write)\b/i.test(message) ||
    /\bwithout\s+(?:creating|saving|starting|running|executing|scheduling|sending|publishing|posting|deploying|modifying|changing|editing|updating|writing)\b/i.test(message) ||
    /\bhold\s+for\s+review\b/i.test(message) ||
    /\b(?:review|approve|approval)\s+(?:first|gate|before)\b/i.test(message) ||
    /\b(?:plan|proposal|propose|outline|blueprint|draft\s+the\s+setup|design\s+the\s+workflow|design\s+a\s+(?:workflow|setup|process|routine|pipeline))\b/i.test(message) ||
    /\bdesign\b.{0,100}\b(?:workflow|setup|process|routine|pipeline)\b/i.test(message) ||
    /\binstead\s+of\s+(?:publishing|posting|sending|saving|creating|running|scheduling)\b/i.test(message)
  ) && !(
    /\b(?:create|save|build|generate|make)\b.{0,80}\b(?:design\s+studio\s+)?(?:project|artifact|html\s+artifact|dashboard\s+ui|landing\s+page|prototype|mockup|web\s+page)\b/i.test(message) ||
    /\b(?:use|open)\s+design\s+studio\b/i.test(message) ||
    /\b(?:give|send)\s+me\s+(?:the\s+)?(?:preview\s+link|artifact\s+id|project\s+id)\b/i.test(message)
  );
}

const MAX_TASK_HINT_RAW_SIGNALS = 6;
const MAX_TASK_HINT_SURFACES = 6;

function clip(value: string, max = 80): string {
  const v = String(value || "").replace(/\s+/g, " ").trim();
  return v.length <= max ? v : `${v.slice(0, max - 1).trimEnd()}…`;
}

function uniqueSignals(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const c = clip(item);
    if (!c) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= MAX_TASK_HINT_RAW_SIGNALS) break;
  }
  return out;
}

function uniqueSurfaces(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const c = clip(item, 40);
    if (!c) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= MAX_TASK_HINT_SURFACES) break;
  }
  return out;
}

function isCrossSurfaceAppMutation(message: string): boolean {
  const m = String(message || "").trim();
  // Keep the broader plan-only gate (covers "design a workflow", "blueprint",
  // etc.) on top of the shared canonical surface/write detection.
  if (!m || isPlanOnlyRequest(m)) return false;
  return isCrossSurfaceAppMutationRequest(m);
}

function isBoardTaskMutation(message: string): boolean {
  const m = String(message || "").trim();
  if (!m || isPlanOnlyRequest(m)) return false;
  return isBoardTaskMutationRequest(m);
}

/**
 * Returns true only when the message is definitely a deterministic request
 * that should bypass the universal agentic runtime. Structural signals only —
 * no benchmark IDs, no per-topic keyword tables.
 */
export function isCertainDeterministic(message: string, context: RoutingContext): CertainDeterministicDecision {
  const m = String(message || "").trim();
  const ml = m.toLowerCase();

  if (context.explicitSlashCommand) {
    return { kind: "slash_command", reason: "Exact slash command — deterministic handler." };
  }
  if (context.protectedBuiltin) {
    return { kind: "protected_builtin", reason: "Protected builtin command — deterministic handler." };
  }
  if (
    /\b(?:using\s+only\s+the\s+(?:text|content|words)\s+(?:above|below|provided|given)|do\s+not\s+(?:search|browse|look\s+up|fetch|use\s+tools)|without\s+(?:searching|browsing|looking\s+up|using\s+tools))\b/i.test(m)
  ) {
    return { kind: "no_tool_boundary", reason: "Explicit no-tool transformation boundary." };
  }
  if (
    m.length < 200 &&
    /\b(?:remember|save|store|note|keep)\b/i.test(ml) &&
    /\b(?:reply\s+(?:only\s+)?(?:saved|noted|ok)|say\s+(?:saved|noted)|acknowledge)\b/i.test(ml)
  ) {
    return { kind: "memory_ack", reason: "Exact memory acknowledgement — deterministic ack." };
  }
  if (
    /\b(?:call|use|run|invoke|execute)\s+(?:the\s+)?(?:tool\s+)?[a-z_]{3,30}\b/i.test(m) &&
    /\b(?:teleport|defragment|quantum|holographic|neural|moonbase|warp)(?=[a-z0-9_]|\b)/i.test(ml)
  ) {
    return { kind: "unknown_tool", reason: "Unknown/fictional tool request — deterministic fallback." };
  }
  if (m.length < 60 && /^(?:hi|hey|hello|bye|thanks|what\s+is\s+\d+|2\s*\+\s*2)/i.test(m)) {
    return { kind: "chitchat", reason: "Simple chitchat or math — no tools needed." };
  }
  if (
    /\b(?:generate|create|make|draw|render|produce)\b/i.test(ml) &&
    /\b(?:image|picture|illustration|poster|icon|banner|thumbnail|wallpaper|logo|avatar|hero\s+mockup)\b/i.test(ml) &&
    !/\b(?:inspect|audit|review|implementation|code|repo|repository)\b/i.test(ml)
  ) {
    return { kind: "image_pipeline", reason: "Direct image/artifact generation — use dedicated image pipeline." };
  }
  return { kind: "none", reason: "Not certain deterministic." };
}

/**
 * Derives structural task hints from the user message. Hints help the
 * universal agentic planner; they never decide whether to use agentic mode.
 */
export function inferTaskHints(message: string, context: RoutingContext): AgenticTaskHint {
  const m = String(message || "").trim();
  const ml = m.toLowerCase();
  const signals: string[] = [];
  const surfaces: string[] = [];
  const hint: AgenticTaskHint = { rawSignals: [], requestedSurfaces: [] };
  const codeFileMentioned = /\b(?:file|existing\s+file|src\/|server\/|scripts\/|components\/|lib\/|app\/|[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|html|css|py|go|rs|java|cs|php|rb|sql|yml|yaml))\b/i.test(m);
  const codeChangeIntent = /\b(?:edit|modify|update|change|patch|fix|replace|implement|create\s+or\s+update|create|write|diff|unified\s+diff|regression\s+test)\b/i.test(ml);
  const proposalOnlyCodeIntent = /\b(?:do\s+not\s+(?:edit|modify|update|change|patch|fix|write|create)|without\s+(?:editing|modifying|writing|creating)|proposal|propose|draft\s+(?:a\s+)?patch|produce\s+(?:a\s+)?(?:minimal\s+)?(?:unified\s+)?diff)\b/i.test(ml);

  if (
    /\b(?:repo|repository|codebase|workspace|src\/|server\/|scripts\/|this\s+app|this\s+project|this\s+code|file|function|implementation|module)\b/i.test(ml)
  ) {
    hint.likelyNeedsRepo = true;
    signals.push("repo-or-codebase-mention");
  }
  if (
    /\b(?:current|latest|recent|today|web|online|source|citation|link|docs?|documentation|release|version|changelog)\b/i.test(ml) ||
    /\bpublic\s+(?:web|internet|sources?|docs?|documentation|reports?|pages?|discussion)\b/i.test(ml)
  ) {
    hint.likelyNeedsWeb = true;
    signals.push("current-public-facts");
  }
  if (
    /\b(?:this\s+app|disp8ch|disp8ch|configured|available|supported|implemented|status|readiness|set\s+up|enable|installed)\b/i.test(ml)
  ) {
    hint.likelyNeedsAppState = true;
    signals.push("app-state-question");
  }
  if (
    /\b(?:computer\s+use|computer[-_\s]?observe|desktop|screen|active\s+window|current\s+window|focused\s+window|local\s+computer|my\s+computer|my\s+pc|use\s+my\s+computer)\b/i.test(ml) &&
    /\b(?:observe|look|see|inspect|read|report|tell|click|type|hotkey|scroll|drag|control|use)\b/i.test(ml)
  ) {
    hint.likelyNeedsComputerUse = true;
    surfaces.push("computer_use");
    signals.push("computer-use-request");
  }
  if (/\b(?:remember|recall|memory|saved\s+fact|codename|previously)\b/i.test(ml)) {
    hint.likelyNeedsMemory = true;
    signals.push("memory-or-recall");
  }
  if (
    /\b(?:designs?|design\s+studio|landing\s+page|prototype|mockup|dashboard\s+ui|poster|deck|html\s+artifact|web\s+page|pricing\s+page|hero|cta|mission\s+control)\b/i.test(ml)
  ) {
    hint.likelyNeedsDesignStudio = true;
    surfaces.push("designs");
    signals.push("design-studio-artifact");
  }
  if (
    /\b(?:workflow|automation|node|trigger|cron|schedule)\b/i.test(ml) ||
    (/\bpipeline\b/i.test(ml) && /\b(?:design|create|build|plan|draft|propose|set\s+up|automate|workflow)\b/i.test(ml))
  ) {
    hint.likelyNeedsWorkflowCatalog = true;
    surfaces.push("workflows");
    signals.push("workflow-or-automation");
  }
  if (
    codeChangeIntent &&
    codeFileMentioned &&
    !/\b(?:plan\s+(?:only|how)|draft\s+(?:a\s+)?plan)\b/i.test(ml)
  ) {
    hint.likelyNeedsCodeEdit = true;
    signals.push(proposalOnlyCodeIntent ? "explicit-code-patch-proposal" : "explicit-code-edit");
  }
  if (
    /\b(?:generate|create|make|draw|render|produce)\b/i.test(ml) &&
    /\b(?:image|picture|illustration|poster|icon|banner|thumbnail|wallpaper|logo|avatar|hero\s+mockup)\b/i.test(ml) &&
    !/\b(?:inspect|audit|review|explain|implementation|code|repo|repository)\b/i.test(ml)
  ) {
    hint.likelyNeedsImagePipeline = true;
    signals.push("image-or-poster");
  }

  // Surface hint extraction (broad): chat / boards / hierarchy / council / agents / settings / files / memory / designs
  const surfaceMatch = m.match(/\b(?:board|boards|task|tasks|kanban)\b/i);
  if (surfaceMatch) surfaces.push("boards");
  if (/\b(?:org|organization|hierarchy|goal|goals|vision|mission|okr|key\s*result)\b/i.test(ml)) surfaces.push("hierarchy");
  if (/\b(?:council|debate|deliberat|verdict|member|role)\b/i.test(ml)) surfaces.push("council");
  if (/\b(?:agent|agents|role|skill|extension)\b/i.test(ml)) surfaces.push("agents");
  if (/\b(?:setting|settings|provider|model|fast\s+mode|tool\s+mode)\b/i.test(ml)) surfaces.push("settings");
  if (/\b(?:file|folder|directory)\b/i.test(ml)) surfaces.push("files");
  if (/\b(?:automation|automations|webhook|webhooks|cron|schedule|schedules|scheduler)\b/i.test(ml)) surfaces.push("workflows");

  if (
    /\b(?:delete|drop|truncate|destroy|push\s+to\s+(?:prod|production)|publish|deploy|send\s+(?:money|payment))\b/i.test(ml) ||
    /\b(?:create|update|edit|modify|change|patch|fix|replace|implement|delete|save|run|start|execute|schedule|send|install|connect|configure|set\s+up|enable|disable|toggle|rotate|regenerate|reset)\b/i.test(ml)
  ) {
    // Mutation verbs default to proposal_only boundary; route layer escalates when
    // the user has clearly confirmed.
    hint.safetyBoundary = "proposal_only";
  }
  if (hint.likelyNeedsCodeEdit) hint.safetyBoundary = proposalOnlyCodeIntent ? "proposal_only" : "confirmed_mutation";
  if (hint.likelyNeedsImagePipeline) hint.safetyBoundary = "dedicated_pipeline";

  if (context.intentKind === "app-mutation-proposal") {
    hint.safetyBoundary = "confirmed_mutation";
  }

  hint.rawSignals = uniqueSignals(signals);
  hint.requestedSurfaces = uniqueSurfaces(surfaces);
  return hint;
}

function policyFromMode(
  mode: AgenticMode,
  reason: string,
  confidence: AgenticRoutingPolicy["confidence"],
  taskHints?: AgenticTaskHint,
): AgenticRoutingPolicy {
  return {
    deterministicAllowed: false,
    agenticRequired: true,
    mode,
    reason,
    confidence,
    taskHints,
  };
}

function deterministicPolicy(reason: string, mode: AgenticMode = "none"): AgenticRoutingPolicy {
  return {
    deterministicAllowed: true,
    agenticRequired: false,
    mode,
    reason,
    confidence: "certain",
  };
}

/**
 * Decides whether a user message should be handled deterministically or
 * through the universal agentic runtime. Structural signals only — no
 * benchmark IDs, no per-topic keyword tables.
 */
export function decideAgenticRouting(message: string, context: RoutingContext): AgenticRoutingPolicy {
  const m = String(message || "").trim();
  const ml = m.toLowerCase();
  const taskHints = inferTaskHints(message, context);

  const deterministic = isCertainDeterministic(message, context);
  if (deterministic.kind === "image_pipeline") {
    return deterministicPolicy(deterministic.reason);
  }
  if (deterministic.kind !== "none") {
    return deterministicPolicy(deterministic.reason);
  }

  // Typed cross-tab mutations need the confirmation-gated app-action planner.
  // If universal app-design handles them first, the user gets a read-only
  // design instead of an editable plan that can create/link the app objects.
  if (isCrossSurfaceAppMutation(message) || isBoardTaskMutation(message)) {
    return deterministicPolicy("App mutation — use typed app-action planner with confirmation.");
  }

  // ── Direct image/artifact generation ─────────────────────────────────
  if (taskHints.likelyNeedsImagePipeline) {
    return deterministicPolicy("Direct image/artifact generation — use dedicated image pipeline.");
  }

  // ── Explicit local computer-use requests ───────────────────────────────
  if (taskHints.likelyNeedsComputerUse) {
    return policyFromMode(
      "computer_use",
      "Explicit computer-use request — model should use computer_observe/action tools, not repo search.",
      "high",
      taskHints,
    );
  }

  // ── Explicit file/code editing (must run before web/repo checks) ─────
  if (taskHints.likelyNeedsCodeEdit) {
    return policyFromMode(
      "code_edit",
      "Explicit file/code edit request — model should read, modify, and verify workspace files.",
      "high",
      taskHints,
    );
  }

  // ── Explicit repo/code inspection (must precede generic web-research) ─
  if (
    /\b(?:inspect|audit|review|explain|how\s+does|where\s+is|find\s+(?:the|where)|code|implementation|function|file|module)\b/i.test(ml) &&
    /\b(?:repo|repository|codebase|workspace|src|server|scripts|this\s+app|this\s+project|this\s+code)\b/i.test(ml) &&
    !/\b(?:can\s+(?:this|it)|does\s+(?:this|it)|is\s+(?:this|it)\s+(?:able|capable|supported)|configured|available|supported|planned)\b/i.test(ml)
  ) {
    return policyFromMode(
      /\b(?:current|latest|web|online|source|citation|link|docs?|documentation)\b/i.test(ml) ||
      /\bpublic\s+(?:web|internet|sources?|docs?|documentation|reports?|pages?|discussion)\b/i.test(ml)
        ? "mixed"
        : "repo_inspection",
      "Explicit repo/code inspection — universal agentic investigation should inspect actual files.",
      "high",
      taskHints,
    );
  }

  // ── App/system capability questions ─────────────────────────────────
  if (
    /\b(?:can\s+(?:this|it)|does\s+(?:this|it)|is\s+(?:this|it)\s+(?:able|capable|supported)|what\s+(?:can|does)\s+(?:this|it)|tell\s+me\s+whether\s+this\s+app|implemented|configured|available|supported|planned)\b/i.test(ml) &&
    /\b(?:this\s+app|disp8ch|you|it)\b/i.test(ml) &&
    /\b(?:slack|teams|microsoft\s+teams|voice|stt|tts|image|video|youtube|transcript|memory|webhook|oauth|email|sms|send|browser|screenshot|tool|capabilit)\b/i.test(ml)
  ) {
    return policyFromMode(
      "mixed",
      "Non-trivial app/system capability question — universal agentic investigation required.",
      "high",
      taskHints,
    );
  }

  // ── Design Studio artifact creation/update ──────────────────────────
  if (
    /\b(?:create|make|design|build|draft|generate|update|change|revise|edit)\b/i.test(ml) &&
    /\b(?:designs?|design\s+studio|landing\s+page|prototype|mockup|dashboard\s+ui|poster|deck|html\s+artifact|web\s+page|pricing\s+page)\b/i.test(ml) &&
    !isPlanOnlyRequest(m)
  ) {
    return policyFromMode(
      "design_studio",
      "Design Studio artifact request — model should use typed design tools and persist a versioned artifact.",
      "high",
      taskHints,
    );
  }

  // ── Automations: cron/webhook live state and operations ─────────────
  const automationDecisionAdviceIntent =
    /\b(?:deciding|decide|decision|prioriti[sz]e|arguments?\s+for|arguments?\s+against|for\s+and\s+against|what\s+would\s+you\s+do|should\s+(?:i|we)|recommend|advice|advisor)\b/i.test(ml);
  const automationExplicitInventoryIntent =
    /\b(?:list|show|current|existing|status|active|enabled|configured|live|inventory|overview|sign|signature|hmac|curl|create|add|configure|set\s+up|rotate|regenerate|reset|toggle|enable|disable|delete|remove)\b/i.test(ml);
  if (
    /\b(?:webhook|webhooks|cron|schedule|schedules|scheduled|scheduler|automation|automations)\b/i.test(ml) &&
    /\b(?:list|show|current|existing|status|active|enabled|configured|live|inventory|state|overview|sign|signature|hmac|curl|create|add|configure|set\s+up|rotate|regenerate|reset|toggle|enable|disable|delete|remove)\b/i.test(ml) &&
    !(automationDecisionAdviceIntent && !automationExplicitInventoryIntent)
  ) {
    return policyFromMode(
      "app_design",
      "Automation state or operation request — model should use live Automations tools and workflow/webhook primitives.",
      "high",
      taskHints,
    );
  }

  // ── App operating designs: agents, boards, channels, profiles ──────
  if (
    /\b(?:design|create|build|plan|draft|propose|set\s+up|setup|outline|compare)\b/i.test(ml) &&
    (
      /\b(?:multi[-\s]?agent|org\s+chart|chief\s+of\s+staff|head\s+of\s+research|head\s+of\s+content|devops|profile|profiles|agent\s+setup|agent\s+runtime)\b/i.test(ml) ||
      /\b(?:kanban|board|boards|triage|to-do|ready|in\s+progress|blocked|done|subtasks?|assign\s+sub[-\s]?agents?)\b/i.test(ml) ||
      /\b(?:messaging\s+setup|morning\s+brief|mobile\s+task|channels?|schedules?|memory|safety\s+gates?|approval\s+gates?)\b/i.test(ml)
    )
  ) {
    return policyFromMode(
      "app_design",
      "App operating design request — model should use local app primitives, agents, boards, channels, schedules, and safety boundaries.",
      "high",
      taskHints,
    );
  }

  // ── Web research ────────────────────────────────────────────────────
  if (
    (
      /\b(?:research|search|look\s+up|find\s+(?:out|current)|browse|current|latest|recent|today|source|citation|link)\b/i.test(ml) &&
      /\b(?:web|online|internet|public|community|github|forum|reddit|hn|docs?|documentation)\b/i.test(ml)
    ) ||
    (
      /\b(?:research|search|look\s+up|find\s+out|browse)\b/i.test(ml) &&
      /\b(?:current|latest|recent|today|practical\s+way|best\s+practical|recommended\s+(?:way|setup|stack))\b/i.test(ml)
    )
  ) {
    return policyFromMode(
      "web_research",
      "Current/web research request — model must search and verify sources.",
      "high",
      taskHints,
    );
  }

  // ── Product compatibility / conflicting sources ─────────────────────
  if (
    /\b(?:whether|does|do|can|is|are|support|connect|work\s+with|compatible|integration|interoperab)\b/i.test(ml) &&
    /\b(?:currently|now|today|at\s+the\s+moment|right\s+now)\b/i.test(ml) &&
    /\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*|[a-z]+\.(?:dev|ai|io|chat|studio|com))\b/.test(m)
  ) {
    return policyFromMode(
      "web_research",
      "Product compatibility question — model must verify current support from sources.",
      "high",
      taskHints,
    );
  }

  // ── Implementation/behavior questions ───────────────────────────────
  if (
    /\b(?:how\s+does|what\s+does|explain\s+(?:how|why|the)|describe\s+(?:the|how)|walk\s+(?:me\s+)?through|trace|debug)\b/i.test(ml) &&
    /\b(?:work|implement|handle|process|route|execute|function|mechanism|behavio[u]?r)\b/i.test(ml)
  ) {
    return policyFromMode(
      "repo_inspection",
      "Implementation/behavior question — model should inspect code.",
      "medium",
      taskHints,
    );
  }

  // ── Workflow design ────────────────────────────────────────────────
  if (
    /\b(?:design|create|build|plan|draft|propose|set\s+up)\b/i.test(ml) &&
    /\b(?:workflow|automation|pipeline|flow)\b/i.test(ml)
  ) {
    return policyFromMode(
      "app_design",
      "Workflow design request — model should inspect available nodes/templates.",
      "medium",
      taskHints,
    );
  }

  // ── Named-entity evidence requests ─────────────────────────────────
  if (
    /\b(?:compare|versus|vs|alternative|recommend|best|which)\b/i.test(ml) &&
    (m.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || []).length >= 2
  ) {
    return policyFromMode(
      "web_research",
      "Multi-entity comparison — model must gather evidence for each.",
      "medium",
      taskHints,
    );
  }

  // ── "Whether X currently supports Y" ───────────────────────────────
  if (/\bwhether\b/i.test(ml) && /\b(?:currently|now|support|work|compatible)\b/i.test(ml)) {
    return policyFromMode(
      "web_research",
      "Current-state question — model must verify from sources.",
      "medium",
      taskHints,
    );
  }

  // ── Troubleshooting with product context ───────────────────────────
  if (
    /\b(?:crash|error|out\s+of\s+memory|oom|fail|broken|not\s+working|debug|troubleshoot|fix|issue|problem)\b/i.test(ml) &&
    /\b(?:model|ollama|llama|lm\s*studio|vllm|cuda|gpu|vram|context|quantiz|gguf)\b/i.test(ml)
  ) {
    return policyFromMode(
      "web_research",
      "Troubleshooting with product context — model needs current solutions.",
      "medium",
      taskHints,
    );
  }

  // ── General app capability/feature overview ────────────────────────
  if (
    /\b(?:what\s+can|what\s+does|overview|features?|capabilit|all\s+the|everything)\b/i.test(ml) &&
    /\b(?:this\s+app|disp8ch|you|it)\b/i.test(ml)
  ) {
    return policyFromMode(
      "repo_inspection",
      "App capability overview — model should inspect actual features.",
      "medium",
      taskHints,
    );
  }

  // ── Multi-step setup with product names ────────────────────────────
  if (
    /\b(?:walk\s+(?:me\s+)?through|step\s+by\s+step|guide|tutorial|set\s+up|install|configure|getting\s+started)\b/i.test(ml) &&
    (m.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || []).length >= 2
  ) {
    return policyFromMode(
      "web_research",
      "Multi-step setup with products — model needs current docs.",
      "medium",
      taskHints,
    );
  }

  // ── Project status / maintenance questions ─────────────────────────
  if (
    /\b(?:maintained|active(?:ly)?|latest\s+(?:release|version)|still\s+(?:active|maintained|developed)|status|up\s+to\s+date|alive|dead|abandoned)\b/i.test(ml) &&
    /\b(?:project|repo|library|tool|framework|app|extension)\b/i.test(ml)
  ) {
    return policyFromMode(
      "web_research",
      "Project status question — model needs current information.",
      "medium",
      taskHints,
    );
  }

  // ── Vague research with domain terms ───────────────────────────────
  if (
    /\b(?:tell\s+me\s+about|what\s+are|explain|describe|overview)\b/i.test(ml) &&
    /\b(?:ai|llm|model|coding|assistant|agent|workflow|automation|local|self[- ]?hosted)\b/i.test(ml) &&
    m.length > 30
  ) {
    return policyFromMode(
      "web_research",
      "Domain research request — model should gather current information.",
      "medium",
      taskHints,
    );
  }

  // ── Default: universal agentic runtime ────────────────────────────
  // Anything that survived is non-trivial but ambiguous. The model is
  // better at deciding the investigation path than a regex catalog, and
  // the universal runtime can still answer in one tool call when the
  // intent is easy.
  if (m.length >= 18) {
    return policyFromMode(
      "mixed",
      "Default non-trivial request — universal agentic runtime should decide tools and evidence.",
      "medium",
      taskHints,
    );
  }

  // Very short prompts that survived deterministic gates fall through
  // to deterministic handling (so a quick "thanks" or stray characters
  // do not burn model tokens).
  return deterministicPolicy("Short prompt without strong agentic signal — deterministic acceptable.");
}
