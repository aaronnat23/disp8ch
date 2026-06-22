export type BroadTaskKind =
  | "composition"
  | "transformation"
  | "web_research"
  | "repo_plan"
  | "app_workflow_design"
  | "app_workflow_edit"
  | "app_surface_explanation"
  | "benchmark_comparison"
  | "memory_recall"
  | "safe_action_plan"
  | "mixed";

import { determineTaskIntentContract } from "@/lib/channels/task-intent-contract";
export type BroadEvidenceNeed =
  | "none"
  | "current_web"
  | "repo_files"
  | "workflow_registry"
  | "app_tool_catalog"
  | "memory"
  | "benchmark_results"
  | "session_history"
  | "external_docs";

export type BroadTaskDecision = {
  kind: BroadTaskKind;
  confidence: "low" | "medium" | "high";
  evidenceNeeds: BroadEvidenceNeed[];
  mustUseTools: boolean;
  mustNotUseTools: boolean;
  readOnly: boolean;
  requiresConfirmation: boolean;
  reason: string;
};

const SESSION_ONLY_DIRECT_PATTERNS = [
  /\bbased\s+only\s+on\s+what\s+you\s+know\s+from\s+this\s+session\b/i,
  /\bbased\s+only\s+on\s+(?:this|our)\s+(?:session|conversation|chat)\b/i,
  /\bfrom\s+(?:this|our)\s+(?:session|conversation|chat)\s+only\b/i,
  /\busing\s+only\s+(?:this|our)\s+(?:session|conversation|chat)\b/i,
  /\buse\s+only\s+(?:this|our)\s+(?:session|conversation|chat)\b/i,
];

// ── Composition: draft/write/rewrite/release note/product update ──
// with no request to inspect, search, compare, verify, or use app state.
const COMPOSITION_PATTERNS = [
  /\b(?:draft|write|compose)\s+(?:a\s+)?(?:product\s+update|release\s+note|announcement|blog\s+post|summary|description)\b/i,
  /\b(?:write|draft)\s+(?:me\s+)?(?:a\s+)?(?:about\s+)?(?:update|note|summary)\b/i,
  /\b(?:draft|write)\s+(?:exactly\s+)?\d+[-\s]?(?:line|bullet|sentence|item)\s+(?:product\s+update|update)\b/i,
  /\b(?:make|turn|convert)\s+.+?\s+(?:shorter|more\s+technical|more\s+concise|bullet\s+points?|a\s+summary)\b/i,
  /\b(?:rewrite|rephrase|summarize)\s+(?:this|the\s+following|that|it)\b/i,
  /\b(?:draft|write)\s+(?:a\s+)?\w+\s+(?:update|note|announcement)\b/i,
];

// ── Transformation: follow-up editing of prior answer ──
const TRANSFORMATION_PATTERNS = [
  /\b(?:make|turn|convert)\s+(?:it|this|that|the\s+answer|the\s+response)\s+(?:more\s+technical|shorter|concise|brief|detailed|professional)\b/i,
  /\b(?:reduce|shorten|trim|cut)\s+(?:it|this|that|the\s+answer)\s+(?:to|down\s+to)\s+\d+/i,
  /\b(?:turn|make|convert|change)\s+(?:it|this|that|the\s+(?:answer|response|note|draft|text|update))\b[\s\S]{0,100}\binto\b/i,
  /\b(?:just|only|give\s+me)\s+(?:the\s+)?(?:technical|short|brief|summarized)\s+(?:version|one)\b/i,
  /\b(?:now\s+)?(?:make|turn|convert|change)\s+(?:it|this|that)\s+(?:into|to)\s+(?:bullet|a\s+list|\d+\s+lines?)\b/i,
  /\b(?:that'?s\s+too\s+(?:long|verbose|detailed|marketing)|too\s+(?:long|verbose|detailed|marketing))\b/i,
  /\b(?:make|turn|convert)\s+(?:it|this|that)\s+(?:shorter|more\s+technical|more\s+concise)\b/i,
  /\b(?:shorten|trim|cut|rewrite|rephrase)\s+(?:each|the|these|those)\s+(?:bullet|item|line|sentence)s?\b/i,
];

// ── Web research: latest/current/recent/search web ──
const WEB_RESEARCH_PATTERNS = [
  /\b(?:search|look\s+up|browse|research)\b[\s\S]{0,80}\b(?:web|online|latest|current|recent|public discussion|source links?)\b/i,
  /\b(?:latest|current|recent)\b[\s\S]{0,60}\b(?:discussion|news|updates?|developments?|trends?)\b/i,
  /\b(?:search\s+the\s+web|web\s+search|google\s+this|find\s+online)\b/i,
  /\b(?:summarize|find|research)\b[\s\S]{0,80}\b(?:top\s+\d+|themes?|sources?)\b[\s\S]{0,40}\b(?:link|url|href|source)\b/i,
  /\b(?:public\s+discussion|community\s+reaction|people\s+saying|what\s+(?:are|is)\s+people)\b/i,
  /\b(?:model\s+card|release\s+notes?|change[-\s]?log|changelog|benchmark\s+results?)\b[\s\S]{0,80}\b(?:online|web|search|find|look)\b/i,
  /\bresearch\s+whether\b[\s\S]{0,120}\b(?:currently\s+supports?|official\s+source|community\s+source|confirmed\s+facts|likely\s+inferences?|unknowns?)\b/i,
  /\b(?:currently\s+supports?|official\s+source|community\s+source)\b[\s\S]{0,120}\b(?:confirmed\s+facts|likely\s+inferences?|unknowns?|source\s+links?)\b/i,
];

// ── Repo plan: inspect/review/codebase/files/implementation plan ──
const REPO_PLAN_PATTERNS = [
  /\b(?:implementation\s+plan|fix\s+plan|upgrade\s+plan|improvement\s+plan)\b/i,
  /\b(?:inspect|review|analy[sz]e|examine)\b[\s\S]{0,80}\b(?:this\s+)?(?:codebase|repo|workspace|repository|code)\b/i,
  /\b(?:files?\s+to\s+touch|add\s+a\s+toast|toast\s+system|minimal\s+.*plan)\b/i,
  /\b(?:do not (?:implement|edit|create|save)|read.?only)\b[\s\S]{0,200}\b(?:plan|inspect|review)\b/i,
  /\b(?:code\s+review|review\s+code|audit|assess)\b[\s\S]{0,80}\b(?:for|in\s+)?\b(?:bug|security|performance|quality)\b/i,
  /\b(?:fast|balanced|thorough)\b[\s\S]{0,120}\b(?:tool\s+usage|tool\s+policy|broad\s+non[-\s]?deterministic|app\s+behavior|webchat\s+session)\b/i,
  /\b(?:tool\s+usage|tool\s+policy|thoroughness\s+policy)\b[\s\S]{0,120}\b(?:fast|balanced|thorough|broad\s+non[-\s]?deterministic|app\s+behavior)\b/i,
];

// ── App workflow design: design workflow/nodes/trigger/data flow ──
const APP_WORKFLOW_DESIGN_PATTERNS = [
  /\b(?:design|draft|blueprint|propose|suggest)\b[\s\S]{0,80}\b(?:workflow|node|trigger|automation|pipeline)\b/i,
  /\b(?:how\s+(?:would|could|can|should)\s+(?:I|we|you))\b[\s\S]{0,80}\b(?:build|create|make|implement|set\s+up)\b[\s\S]{0,80}\b(?:workflow|automation)\b/i,
  /\b(?:workflow\s+design|design\s+a\s+workflow|node\s+layout|canvas\s+design)\b/i,
  /\b(?:data\s+flow|node\s+type|trigger\s+type)\b[\s\S]{0,60}\b(?:workflow|automation)\b/i,
];

// ── App workflow editing: list/show/edit/change/update/run/disable/delete workflows or nodes ──
// These prompts must enable tools (workflow_list / workflow_get / workflow_update_node / etc.).
// The broad-task router only decides whether tools are allowed — the LLM still picks which specific tool.
const APP_WORKFLOW_EDIT_PATTERNS = [
  /\b(?:list|show|view|see|check|describe|get|read)\b[\s\S]{0,40}\b(?:workflow|workflows|workflow's|node|nodes)\b/i,
  /\b(?:what\s+workflows?|which\s+workflows?|workflows?\s+(?:do\s+i|do\s+we)\s+have)\b/i,
  /\b(?:edit|change|update|modify|set|adjust|swap|replace|tweak)\b[\s\S]{0,80}\b(?:workflow|node|prompt|url|header|tool|allowlist|schedule|cron|model|agent|temperature|timezone|expression|setting)\b/i,
  /\b(?:disable|enable|turn\s+off|turn\s+on|pause|resume|activate|deactivate)\b[\s\S]{0,80}\b(?:workflow|cron|schedule|trigger|automation)\b/i,
  /\b(?:duplicate|clone|copy)\b[\s\S]{0,80}\b(?:workflow|automation|pipeline)\b/i,
  /\b(?:delete|remove|trash|drop)\b[\s\S]{0,80}\b(?:workflow|automation|pipeline)\b/i,
  /\b(?:run|trigger|execute|fire|kick\s+off|start)\b[\s\S]{0,40}\b(?:workflow|the\s+\w+\s+(?:workflow|automation|pipeline|cycle))\b/i,
  /\b(?:is|when)\b[\s\S]{0,40}\b(?:done|finished|complete|completed|running|pending)\b[\s\S]{0,40}\b(?:workflow|execution|run)\b/i,
  /\b(?:cron|schedule)\b[\s\S]{0,80}\b(?:expression|run\s+at|every|weekday|weekend|daily|hourly|am|pm)\b/i,
  /\b(?:in\s+the\s+\w+\s+workflow|of\s+the\s+\w+\s+workflow)\b/i,
];

// ── App surface explanation ──
const APP_SURFACE_PATTERNS = [
  /\b(?:explain|describe|what\s+(?:is|are)|how\s+do(?:es)?)\b[\s\S]{0,80}\b(?:disp8ch|app|dashboard|sidebar|settings?|panel|surface)s?\b/i,
  /\b(?:how\s+(?:do|does|are))\b[\s\S]{0,60}\b(?:agents?|workflows?|boards?|hierarchy|council|scheduler|memory)\b[\s\S]{0,40}\b(?:work|used|configured?|set\s+up)\b/i,
  /\b(?:what\s+(?:are|is)\s+(?:the\s+)?(?:available\s+)?(?:channels?|extensions?|tools?|models?|skills?|agents?|templates?))\b/i,
];

// ── Benchmark comparison ──
// NOTE: bare "comparison" / "compare" no longer route to benchmark on their own.
// The TaskIntentContract and Routing Arbiter handle comparison routing now.
// These patterns only catch explicit comparison/benchmark artifact requests.
const BENCHMARK_PATTERNS = [
  /\b(?:benchmark)\b[\s\S]{0,80}\b(?:result|test|score|timing|run|VS|vs\.?|against)\b/i,
  /\b(?:compare|contrast)\b[\s\S]{0,80}\b(?:apps?|agents?|systems?|implementations?|repos?)\b[\s\S]{0,40}\b(?:result|test|benchmark|report|artifact|\.md)\b/i,
  /\brun\s+the\s+(?:comparison|benchmark|comparison\s+benchmark)\b/i,
  /\brun\s+the\s+[\w .-]{1,48}\s+comparison\b[\s\S]{0,80}\b(?:show|summari[sz]e|report|print|return)\b[\s\S]{0,40}\b(?:results?|scores?|timings?|outputs?)\b/i,
];

// ── Memory recall ──
const MEMORY_RECALL_PATTERNS = [
  /\b(?:remember|recall|what\s+did\s+(?:i|we|you)\s+say|what\s+(?:is|was)\s+(?:codename|test\s+fact)|saved\s+fact|last\s+time)\b/i,
  /\b(?:do\s+you\s+remember|have\s+(?:i|we)\s+(?:told|said|mentioned|discussed))\b/i,
];

// ── Safe action plan: create/schedule but asks for safety ──
const SAFE_ACTION_PATTERNS = [
  /\b(?:if\s+you\s+cannot\s+(?:safely|actually)|if\s+(?:not|unavailable)|explain\s+what\s+confirmation)\b/i,
  /\b(?:explain\s+what\s+(?:you|I|we)\s+need|confirmation\s+(?:you|I|we)\s+need)\b/i,
  /\b(?:without\s+(?:creating|scheduling|saving|running|executing|sending))\b/i,
  /\b(?:plan\s+to|propose|suggest)\s+(?:set\s+up|create|schedule|send|run)\b/i,
];

// ── Definite no-tool composition terms ──
const NO_TOOL_COMPOSITION_TERMS = new Set([
  "draft", "write", "compose", "rewrite", "spell", "grammar",
  "shorter", "concise", "more technical", "summarize",
  "paraphrase", "rephrase", "simplify", "translate",
]);

function hasNoInspectionRequest(message: string): boolean {
  const lowered = message.toLowerCase();
  const contract = determineTaskIntentContract(message);
  if (contract.operation === "compare" && contract.toolPolicy === "forbidden") return true;
  return !(
    /\b(?:search|find|look\s+up|browse|scrape|fetch|inspect|review|analy[sz]e|check|verify|audit|read|list|show|test)\b/i.test(lowered) ||
    /\b(?:use\s+(?:the\s+)?tools?|call\s+(?:the\s+)?tools?|with\s+tools?)\b/i.test(lowered) ||
    /(?:current|latest|recent|now|today|live|online)\b.*\b(?:version|state|status|discussion|news|info)/i.test(lowered) ||
    /\bapp\s+state\b/i.test(lowered) ||
    /\b(?:workspace|repo|codebase|files?|src\/|node_modules)\b/i.test(lowered)
  );
}

function hasOnlyCompositionWords(message: string): boolean {
  const lowered = message.toLowerCase();
  const tokens = lowered.split(/[^a-z]+/).filter(Boolean);
  const actionTokens = tokens.filter((t) => NO_TOOL_COMPOSITION_TERMS.has(t) || /^(?:a|an|the|in|of|to|for|and|or|is|it|this|that|me|my|about|with)$/.test(t));
  return actionTokens.length === tokens.length;
}

function isPriorTurnReference(message: string): boolean {
  return /^(?:it|this|that|the\s+(?:answer|response|one|update|draft|text))\b/i.test(message.trim()) ||
    /\b(?:make|turn|convert|change|transform|reduce|shorten|trim|cut)\s+(?:it|this|that|the\s+(?:answer|response|one|update|draft|text))\b/i.test(message.trim()) ||
    /\b(?:shorten|trim|cut|rewrite|rephrase)\s+(?:each|the|these|those)\s+(?:bullet|item|line|sentence)s?\b/i.test(message.trim()) ||
    /^that'?s\s+too\s+(?:long|verbose|detailed|marketing)\b/i.test(message.trim());
}

export function classifyBroadTask(message: string): BroadTaskDecision {
  const raw = message.trim();
  const lowered = raw.toLowerCase();

  // 0. Session-only synthesis: the route already injects recent chat history.
  // Do not force web/repo evidence just because the prompt says "compare".
  if (SESSION_ONLY_DIRECT_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "memory_recall",
      confidence: "high",
      evidenceNeeds: ["session_history"],
      mustUseTools: false,
      mustNotUseTools: true,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Explicit session-only answer request; use injected conversation context instead of tools",
    };
  }

  // 0b. Implicit recall: codename recall, test facts, stored values, remembered items.
  // Detects prompts like "What is comparison_codename?" or "read the stored fact"
  // that reference previously saved data without asking to search or inspect.
  if (
    /\b(?:codename|test\s+fact|stored|saved|remembered|read\s+(?:the\s+)?(?:stored|saved|memory|fact))\b/i.test(raw) &&
    !/\b(?:search|find|look\s+up|browse|fetch|web|online|inspect|repo|codebase|files?|plan|design)\b/i.test(raw) &&
    raw.split(/\s+/).length < 12
  ) {
    return {
      kind: "memory_recall",
      confidence: "high",
      evidenceNeeds: ["memory", "session_history"],
      mustUseTools: false,
      mustNotUseTools: true,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Implicit recall prompt referencing stored/codename/test-fact values — memory recall path",
    };
  }

  // 1. Transformation: follow-up edit of prior answer (check BEFORE composition)
  if (TRANSFORMATION_PATTERNS.some((p) => p.test(raw)) && isPriorTurnReference(raw)) {
    return {
      kind: "transformation",
      confidence: "high",
      evidenceNeeds: ["session_history"],
      mustUseTools: false,
      mustNotUseTools: true,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Follow-up editing request referencing prior assistant text",
    };
  }

  // 2. Definite composition: explicit draft/write with no inspection/verification
  if (COMPOSITION_PATTERNS.some((p) => p.test(raw)) && hasNoInspectionRequest(raw)) {
    return {
      kind: "composition",
      confidence: "high",
      evidenceNeeds: ["none"],
      mustUseTools: false,
      mustNotUseTools: true,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Explicit draft/write request without inspection, search, or verification indicators",
    };
  }

  // 3. Clear composition with only composition words (no inspection or mutation words)
  if (hasOnlyCompositionWords(raw) && !/^[^a-z]*$/.test(raw)) {
    return {
      kind: "composition",
      confidence: "medium",
      evidenceNeeds: ["none"],
      mustUseTools: false,
      mustNotUseTools: true,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Message consists of composition/editing words with no inspection or mutation indicators",
    };
  }

  // 4. Web research
  if (WEB_RESEARCH_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "web_research",
      confidence: "high",
      evidenceNeeds: ["current_web"],
      mustUseTools: true,
      mustNotUseTools: false,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Request for current/public web information with source/citation expectations",
    };
  }

  // 5. Benchmark comparison / comparison with explicit evidence needs
  const contract = determineTaskIntentContract(raw);
  if (contract.operation === "compare") {
    if (contract.toolPolicy === "forbidden") {
      // Session-only or provided-only comparison — no tools needed
      if (contract.requiresSessionHistory) {
        return {
          kind: "memory_recall",
          confidence: "high",
          evidenceNeeds: ["session_history"],
          mustUseTools: false,
          mustNotUseTools: true,
          readOnly: true,
          requiresConfirmation: false,
          reason: "Comparison with explicit session-only source boundary — no tools required",
        };
      }
      if (isPriorTurnReference(raw)) {
        return {
          kind: "transformation",
          confidence: "high",
          evidenceNeeds: ["session_history"],
          mustUseTools: false,
          mustNotUseTools: true,
          readOnly: true,
          requiresConfirmation: false,
          reason: "Comparison referencing prior turns — session-history transformation",
        };
      }
      return {
        kind: "composition",
        confidence: "high",
        evidenceNeeds: ["none"],
        mustUseTools: false,
        mustNotUseTools: true,
        readOnly: true,
        requiresConfirmation: false,
        reason: "Comparison with provided-only source boundary — no-tool composition",
      };
    }

    if (contract.requiresCurrentFacts) {
      return {
        kind: "web_research",
        confidence: "high",
        evidenceNeeds: ["current_web"],
        mustUseTools: true,
        mustNotUseTools: false,
        readOnly: true,
        requiresConfirmation: false,
        reason: "Comparison requiring current/public web facts with source/citation expectations",
      };
    }

    if (contract.evidenceSources.includes("benchmark_artifacts")) {
      return {
        kind: "benchmark_comparison",
        confidence: "high",
        evidenceNeeds: ["benchmark_results", "repo_files"],
        mustUseTools: true,
        mustNotUseTools: false,
        readOnly: true,
        requiresConfirmation: false,
        reason: "Comparison requiring benchmark artifacts and repo evidence",
      };
    }

    if (contract.requiresRepoEvidence) {
      return {
        kind: "repo_plan",
        confidence: "high",
        evidenceNeeds: ["repo_files"],
        mustUseTools: true,
        mustNotUseTools: false,
        readOnly: true,
        requiresConfirmation: false,
        reason: "Comparison requiring repo/codebase evidence",
      };
    }
  }

  // 5b. Catch-all benchmark pattern (only when NOT already handled by contract)
  if (contract.toolPolicy !== "forbidden" && BENCHMARK_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "benchmark_comparison",
      confidence: "high",
      evidenceNeeds: ["benchmark_results", "repo_files"],
      mustUseTools: true,
      mustNotUseTools: false,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Request for comparison/benchmark results with evidence expectations",
    };
  }

  // 6. Safe action plan
  if (SAFE_ACTION_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "safe_action_plan",
      confidence: "high",
      evidenceNeeds: ["none"],
      mustUseTools: false,
      mustNotUseTools: false,
      readOnly: true,
      requiresConfirmation: true,
      reason: "Plan request with explicit safety/confirmation boundary",
    };
  }

  // 7. App workflow design
  if (APP_WORKFLOW_DESIGN_PATTERNS.some((p) => p.test(raw))) {
    const readOnly = /do not create|do not save|do not run|plan\s+only|read.?only/i.test(raw);
    return {
      kind: "app_workflow_design",
      confidence: "high",
      evidenceNeeds: ["workflow_registry", "app_tool_catalog"],
      mustUseTools: true,
      mustNotUseTools: false,
      readOnly,
      requiresConfirmation: !readOnly && /create|build|save|run/i.test(raw),
      reason: "Request for disp8ch AI workflow/automation design that needs registry/tool-catalog grounding",
    };
  }

  // 7b. App workflow editing — list/show/edit/change/update/run/duplicate/delete workflows or nodes.
  // The LLM picks which specific workflow_* tool to call from the catalog (LLM-enrichment pattern).
  if (APP_WORKFLOW_EDIT_PATTERNS.some((p) => p.test(raw))) {
    const readOnly = /^(?:list|show|view|see|describe|check|read|what\s+|which\s+|is\s+|when\s+)/i.test(raw.trim()) ||
      /\b(?:do not (?:create|edit|save|delete|update)|read.?only|plan\s+only)\b/i.test(raw);
    const destructive = /\b(?:delete|remove|trash|drop)\b/i.test(raw) ||
      /\b(?:edit|change|update|modify|set|adjust|swap|replace|disable|enable|turn\s+(?:on|off))\b/i.test(raw);
    return {
      kind: "app_workflow_edit",
      confidence: "high",
      evidenceNeeds: ["workflow_registry", "app_tool_catalog"],
      mustUseTools: true,
      mustNotUseTools: false,
      readOnly,
      requiresConfirmation: !readOnly && destructive,
      reason: "Workflow inspection/editing request — LLM picks workflow_* tool from catalog",
    };
  }

  // 8. Repo plan
  if (REPO_PLAN_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "repo_plan",
      confidence: "high",
      evidenceNeeds: ["repo_files"],
      mustUseTools: true,
      mustNotUseTools: false,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Request for repo-grounded implementation/inspection plan",
    };
  }

  // 9. App surface explanation
  if (APP_SURFACE_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "app_surface_explanation",
      confidence: "high",
      evidenceNeeds: ["app_tool_catalog"],
      mustUseTools: false,
      mustNotUseTools: false,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Request for explanation of disp8ch AI app surfaces or capabilities",
    };
  }

  // 10. Memory recall
  if (MEMORY_RECALL_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "memory_recall",
      confidence: "high",
      evidenceNeeds: ["memory"],
      mustUseTools: false,
      mustNotUseTools: false,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Request for memory recall or conversation history lookup",
    };
  }

  // 11. Safe action plan
  if (SAFE_ACTION_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "safe_action_plan",
      confidence: "high",
      evidenceNeeds: ["none"],
      mustUseTools: false,
      mustNotUseTools: false,
      readOnly: true,
      requiresConfirmation: true,
      reason: "Plan request with explicit safety/confirmation boundary",
    };
  }

  // 12. Default: mixed / uncertain — let the model-led lane decide, but respect the contract.
  const contractForDefault = determineTaskIntentContract(raw);
  if (contractForDefault.toolPolicy === "forbidden") {
    return {
      kind: contractForDefault.operation === "transform" ? "transformation" : "composition",
      confidence: "high",
      evidenceNeeds: contractForDefault.requiresSessionHistory ? ["session_history"] : ["none"],
      mustUseTools: false,
      mustNotUseTools: true,
      readOnly: true,
      requiresConfirmation: false,
      reason: "Contract says toolPolicy=forbidden — no-tool composition path",
    };
  }

  const hasToolIndicators =
    /\b(?:search|find|look\s+up|browse|inspect|review|analy[sz]e|check|verify|audit|read\s+file|list\s+files?)\b/i.test(lowered) ||
    /\b(?:web|online|latest|current|codebase|repo|workspace|files?|src\/|plan|design)\b/i.test(lowered);

  return {
    kind: hasToolIndicators ? "mixed" : "composition",
    confidence: hasToolIndicators ? "low" : "medium",
    evidenceNeeds: hasToolIndicators ? ["repo_files", "current_web"] : ["none"],
    mustUseTools: contractForDefault.toolPolicy === "required" ? true : hasToolIndicators,
    mustNotUseTools: hasToolIndicators ? false : true,
    readOnly: true,
    requiresConfirmation: false,
    reason: hasToolIndicators
      ? "Ambiguous prompt with tool/inspection indicators — tools attached, model decides"
      : "Simple prompt with no clear inspection need — composition path",
  };
}

export function shouldBypassBroadSynthesisForComposition(
  message: string,
  broadTask?: BroadTaskDecision | null,
): boolean {
  const decision = broadTask ?? classifyBroadTask(message);
  // app_workflow_edit prompts go to the LLM workflow_* tool catalog, not synthesis.
  return decision.kind === "composition" || decision.kind === "transformation" || decision.kind === "app_workflow_edit";
}

export function shouldRequireEvidenceForTask(decision: BroadTaskDecision): boolean {
  return decision.evidenceNeeds.length > 0 && !decision.evidenceNeeds.every((n) => n === "none");
}

export function isFastCompositionTask(decision: BroadTaskDecision): boolean {
  return (decision.kind === "composition" || decision.kind === "transformation") &&
    decision.mustNotUseTools;
}

export function taskKindToLabel(kind: BroadTaskKind): string {
  const labels: Record<BroadTaskKind, string> = {
    composition: "Composition",
    transformation: "Transformation",
    web_research: "Web Research",
    repo_plan: "Repo Plan",
    app_workflow_design: "App Workflow Design",
    app_workflow_edit: "App Workflow Edit",
    app_surface_explanation: "App Surface Explanation",
    benchmark_comparison: "Benchmark Comparison",
    memory_recall: "Memory Recall",
    safe_action_plan: "Safe Action Plan",
    mixed: "Mixed/General",
  };
  return labels[kind];
}
