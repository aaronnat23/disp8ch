/**
 * Shared cross-tab intent layer.
 *
 * One source of truth for "what kind of app work is this turn?" so that
 * `route.ts`, `agentic-routing-policy.ts`, `app-action-eligibility.ts`, and
 * `router.ts` stop duplicating slightly-different copies of the same regexes.
 *
 * Design principle (see the cross-tab plan): deterministic code only decides
 * safety/confirmation/dry-run boundaries. The model decides the actual
 * multi-tab plan. So this module is intentionally a *structural fallback brain*
 * — it counts surfaces and detects explicit safety boundaries, and it never
 * bakes per-topic answers.
 */

export type AppSurface =
  | "agents"
  | "hierarchy"
  | "goals"
  | "council"
  | "workflows"
  | "scheduler"
  | "boards"
  | "channels"
  | "documents"
  | "memory"
  | "models"
  | "docs";

export type CrossTabIntentKind =
  | "read"
  | "design"
  | "mutation_proposal"
  | "confirmed_mutation"
  | "dry_run"
  | "hypothetical"
  | "clarify";

export type CrossTabIntent = {
  kind: CrossTabIntentKind;
  surfaces: AppSurface[];
  writeSignals: string[];
  readOnlySignals: string[];
  planOnly: boolean;
  hypothetical: boolean;
  confidence: "low" | "medium" | "high";
  reason: string;
};

// ---------------------------------------------------------------------------
// Canonical structural signals (kept identical to the previous inline copies
// in route.ts/router.ts so existing green regressions stay green).
// ---------------------------------------------------------------------------

const NEGATED_WRITE =
  /\b(?:do\s+not|don'?t|without)\s+(?:creat(?:e|ing)?|chang(?:e|ing)?|modif(?:y|ying)?|updat(?:e|ing)?|mak(?:e|ing)?|add(?:ing)?|run(?:ning)?|execut(?:e|ing)?|sav(?:e|ing)?|schedul(?:e|ing)?)\b/i;

const PLAN_ONLY_PHRASE =
  /\b(?:plan\s+only|just\s+the\s+plan|proposal\s+only|hypothetical|what\s+would\s+happen|show\s+me\s+what\s+would\s+happen)\b/i;

const HYPOTHETICAL_PHRASE =
  /\b(?:hypothetical|what\s+would\s+happen|show\s+me\s+what\s+would\s+happen|pretend|dry[-\s]?run|simulate(?:\s+only)?)\b/i;

const WRITE_OR_SETUP =
  /\b(?:create|make|build|add|connect|schedule|set\s*up|setup|assemble|prepare|configure|organize|form|spin\s+up|put|assign|link|attach|apply|switch|change|update|rename|run|execute|have|turn\s+(?:the\s+|this\s+)?[\w\s]{0,30}\binto|convert)\b/i;

/** The 10 mutation-surface probes — order/content preserved for parity. */
const EXPLICIT_COUNCIL_SURFACE =
  /\bcouncil\b|\b(?:have|let|ask|get|run)\s+(?:them|the\s+agents?|agents?|the\s+org(?:anization)?|the\s+team|the\s+crew|the\s+council)\s+(?:to\s+)?(?:decide|discuss|debate|deliberate|vote|choose|pick)\b/i;

const EXPLICIT_AGENT_DECISION_SURFACE =
  /\b(?:have|let|ask|get|run)\s+(?:them|the\s+agents?|agents?|the\s+org(?:anization)?|the\s+team|the\s+crew|the\s+council)\s+(?:to\s+)?(?:decide|discuss|debate|deliberate|vote|choose|pick)\b/i;

const MUTATION_SURFACE_PROBES: RegExp[] = [
  /\b(?:agents?|assistants?|workers?|people|person|members?)\b/i,
  /\b(?:org(?:anization)?s?|hierarch(?:y|ies)|teams?|crews?|departments?|structure)\b/i,
  /\b(?:workflows?|flows?|automations?|pipelines?|templates?|monitor|monitoring|check)\b/i,
  /\b(?:schedule|scheduled|daily|weekly|recurring|cron|every\s+(?:day|week|morning|weekday))\b/i,
  /\b(?:boards?|tasks?|cards?|todo|kanban|follow[-\s]?ups?|track|tracking)\b/i,
  /\b(?:channels?|telegram|discord|whatsapp|slack|teams|webchat|alerts?|notifications?)\b/i,
  /\b(?:goals?|objectives?|milestones?|targets?)\b/i,
  /\b(?:skills?)\b/i,
  /\b(?:extensions?|plugins?|tools?)\b/i,
];

function countMutationSurfaces(value: string): number {
  let count = MUTATION_SURFACE_PROBES.filter((p) => p.test(value)).length;
  if (EXPLICIT_COUNCIL_SURFACE.test(value) || EXPLICIT_AGENT_DECISION_SURFACE.test(value)) count += 1;
  return count;
}

/**
 * True when the message is a cross-surface (3+) app mutation that should be
 * handled by the typed, confirmation-gated planner. Behaviour-identical to the
 * prior inline `isCrossSurfaceAppMutationRequest` in route.ts/router.ts.
 */
export function isCrossSurfaceAppMutationRequest(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  if (NEGATED_WRITE.test(value) || PLAN_ONLY_PHRASE.test(value)) return false;
  if (!WRITE_OR_SETUP.test(value)) return false;
  return countMutationSurfaces(value) >= 3;
}

const BOARD_NEGATION =
  /\b(?:do\s+not|don'?t|without)\s+(?:creat(?:e|ing)?|add(?:ing)?|mak(?:e|ing)?|sav(?:e|ing)?|chang(?:e|ing)?)\b/i;

/**
 * True when the message asks to create/log a board task. Behaviour-identical to
 * the prior inline `isBoardTaskMutationRequest`.
 */
export function isBoardTaskMutationRequest(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  if (BOARD_NEGATION.test(value) || PLAN_ONLY_PHRASE.test(value)) return false;
  const explicitTask = /\b(?:board\s+tasks?|tasks?|todo)\b/i.test(value);
  const boardCard =
    /\b(?:boards?|kanban|backlog)\b/i.test(value) &&
    /\bcards?\b/i.test(value);
  const trackedFollowUp =
    /\b(?:create|add|log|record|track)\s+(?:the\s+)?follow[-\s]?ups?\b/i.test(value) ||
    /\bfollow[-\s]?up\s+(?:tasks?|items?|cards?|work)\b/i.test(value);
  return (
    /\b(?:create|make|add|log|record|track)\b/i.test(value) &&
    (explicitTask || boardCard || trackedFollowUp)
  );
}

// ---------------------------------------------------------------------------
// Surface mapping for the richer semantic intent.
// ---------------------------------------------------------------------------

const SURFACE_MAP: Array<{ surface: AppSurface; pattern: RegExp }> = [
  // A "team"/"crew"/"squad" implies both an org structure (hierarchy) and the
  // agents that staff it — so those words flag the agents surface too.
  { surface: "agents", pattern: /\b(?:agents?|assistants?|workers?|people|person|members?|skills?|extensions?|plugins?|tools?|teams?|crews?|squads?)\b/i },
  { surface: "hierarchy", pattern: /\b(?:org(?:anization)?s?|hierarch(?:y|ies)|teams?|crews?|departments?|structure|reporting\s+line)\b/i },
  { surface: "goals", pattern: /\b(?:goals?|objectives?|milestones?|targets?|okrs?)\b/i },
  { surface: "council", pattern: /\bcouncil\b|(?:\b(?:have|let|ask|get|run)\s+(?:them|the\s+agents?|agents?|the\s+org(?:anization)?|the\s+team|the\s+crew|the\s+council)\s+(?:to\s+)?(?:decide|discuss|debate|deliberate|vote|choose|pick)\b)/i },
  { surface: "workflows", pattern: /\b(?:workflows?|flows?|automations?|pipelines?|templates?|monitor(?:ing)?)\b/i },
  { surface: "scheduler", pattern: /\b(?:schedule[ds]?|scheduling|daily|weekly|recurring|cron|every\s+(?:day|week|morning|weekday)|automations?\s+tab)\b/i },
  { surface: "boards", pattern: /\b(?:boards?|tasks?|cards?|todo|kanban|follow[-\s]?ups?|track(?:ing)?|backlog|inbox)\b/i },
  { surface: "channels", pattern: /\b(?:channels?|telegram|discord|whatsapp|slack|teams|bluebubbles|alerts?|notifications?)\b/i },
  { surface: "documents", pattern: /\b(?:docs?|documents?|data\s+sources?|source\s+packs?|pdfs?|files?|notes?|uploads?)\b/i },
  { surface: "memory", pattern: /\b(?:memory|memories|remember|recall|knowledge\s+base)\b/i },
  { surface: "models", pattern: /\b(?:models?|providers?|api\s+keys?|llm\s+config)\b/i },
  { surface: "docs", pattern: /\b(?:help\s+docs?|documentation|how\s+(?:do|does)\s+.*\s+work)\b/i },
];

function detectSurfaces(value: string): AppSurface[] {
  const out: AppSurface[] = [];
  for (const { surface, pattern } of SURFACE_MAP) {
    if (pattern.test(value) && !out.includes(surface)) out.push(surface);
  }
  if (/\btrack\s+record\b/i.test(value)) {
    const index = out.indexOf("boards");
    if (index >= 0) out.splice(index, 1);
  }
  return out;
}

const WRITE_VERBS: Array<{ token: string; pattern: RegExp }> = [
  { token: "create", pattern: /\bcreate\b/i },
  { token: "build", pattern: /\bbuild\b/i },
  { token: "make", pattern: /\bmake\b/i },
  { token: "add", pattern: /\badd\b/i },
  { token: "set up", pattern: /\bset\s*up\b/i },
  { token: "organize", pattern: /\borgani[sz]e\b/i },
  { token: "assemble", pattern: /\bassemble\b/i },
  { token: "schedule", pattern: /\bschedule\b/i },
  { token: "assign", pattern: /\bassign\b/i },
  { token: "link", pattern: /\blink\b/i },
  { token: "attach", pattern: /\battach\b/i },
  { token: "connect", pattern: /\bconnect\b/i },
  { token: "run", pattern: /\brun\b/i },
  { token: "apply", pattern: /\bapply\b/i },
  { token: "update", pattern: /\bupdate\b/i },
  { token: "switch", pattern: /\bswitch\b/i },
  { token: "track", pattern: /\btrack\b/i },
  { token: "turn into", pattern: /\bturn\s+(?:the\s+|this\s+)?[\w\s]{0,30}\binto\b/i },
  { token: "convert", pattern: /\bconvert\b/i },
];

const READONLY_SIGNALS: Array<{ token: string; pattern: RegExp }> = [
  { token: "without changing", pattern: /\bwithout\s+chang(?:e|ing)\b/i },
  { token: "plan only", pattern: /\bplan\s+only\b|\bjust\s+the\s+plan\b|\bproposal\s+only\b/i },
  { token: "don't create", pattern: NEGATED_WRITE },
  { token: "list/show", pattern: /^(?:what|which|who|where|how|are|is|does|do|show|list|display|give|tell|summari[sz]e)\b/i },
  { token: "suggest", pattern: /\b(?:suggest|recommend|review)\b.*\b(?:without|don'?t|do\s+not)\b/i },
];

/**
 * Resolve the semantic cross-tab intent for a turn. Structural only.
 */
export function detectCrossTabIntent(raw: string): CrossTabIntent {
  const value = String(raw || "").trim();
  const surfaces = detectSurfaces(value);
  const writeSignals = WRITE_VERBS
    .filter((v) => v.pattern.test(value))
    .map((v) => v.token)
    .filter((token) => !(token === "track" && /\btrack\s+record\b/i.test(value)));
  const readOnlySignals = READONLY_SIGNALS.filter((v) => v.pattern.test(value)).map((v) => v.token);
  const planOnly = NEGATED_WRITE.test(value) || PLAN_ONLY_PHRASE.test(value);
  const hypothetical = HYPOTHETICAL_PHRASE.test(value);

  // 1. Hypothetical / dry-run — explicit "what would happen", "pretend", "dry run".
  if (hypothetical && /\bworkflow|create|build|set\s*up|schedule|run\b/i.test(value)) {
    return {
      kind: "hypothetical",
      surfaces,
      writeSignals,
      readOnlySignals,
      planOnly: true,
      hypothetical: true,
      confidence: "high",
      reason: "Hypothetical/dry-run phrasing — no writes, preview only.",
    };
  }

  // 2. Cross-surface mutation (3+ surfaces, write verb, no negation) — the
  //    canonical typed-plan trigger.
  if (isCrossSurfaceAppMutationRequest(value)) {
    return {
      kind: "mutation_proposal",
      surfaces,
      writeSignals,
      readOnlySignals,
      planOnly: false,
      hypothetical: false,
      confidence: surfaces.length >= 3 ? "high" : "medium",
      reason: `Cross-surface mutation across ${surfaces.length} surfaces — typed pending plan.`,
    };
  }

  // 3. Board-task mutation (single surface, but a confirm-write).
  if (isBoardTaskMutationRequest(value)) {
    return {
      kind: "mutation_proposal",
      surfaces: surfaces.includes("boards") ? surfaces : [...surfaces, "boards"],
      writeSignals,
      readOnlySignals,
      planOnly: false,
      hypothetical: false,
      confidence: "high",
      reason: "Board-task creation — typed pending plan (confirm-write).",
    };
  }

  // 4. Plan-only / negated write with app surfaces — a read-only design answer.
  if (planOnly && surfaces.length > 0) {
    return {
      kind: "design",
      surfaces,
      writeSignals,
      readOnlySignals,
      planOnly: true,
      hypothetical: false,
      confidence: "medium",
      reason: "Explicit no-write boundary with app surfaces — design/read answer.",
    };
  }

  // 5. Read-only phrasing with an app surface, no write verb.
  const startsReadOnly = /^(?:what|which|who|where|how|are|is|does|do|show|list|display|give|tell|summari[sz]e)\b/i.test(value);
  if (surfaces.length > 0 && writeSignals.length === 0 && startsReadOnly) {
    return {
      kind: "read",
      surfaces,
      writeSignals,
      readOnlySignals,
      planOnly: false,
      hypothetical: false,
      confidence: "medium",
      reason: "Read/status question about app surfaces.",
    };
  }

  // 6. Write verb + at least one surface but below the cross-surface bar — still
  //    a mutation proposal (single-surface create/build/setup).
  if (writeSignals.length > 0 && surfaces.length >= 1) {
    return {
      kind: "mutation_proposal",
      surfaces,
      writeSignals,
      readOnlySignals,
      planOnly: false,
      hypothetical: false,
      confidence: surfaces.length >= 2 ? "medium" : "low",
      reason: `Single/low-surface mutation (${surfaces.join(", ") || "app"}).`,
    };
  }

  // 7. Fallback — treat as read/design with low confidence; the universal
  //    runtime handles it as normal help.
  return {
    kind: surfaces.length > 0 ? "design" : "read",
    surfaces,
    writeSignals,
    readOnlySignals,
    planOnly,
    hypothetical,
    confidence: "low",
    reason: "No clear cross-tab mutation signal.",
  };
}

/** The model should synthesize a typed pending app plan for this turn. */
export function shouldUseTypedAppPlan(intent: CrossTabIntent): boolean {
  return intent.kind === "mutation_proposal";
}

/** The universal runtime must not freeform-answer this as completed work. */
export function shouldBypassUniversalFreeform(intent: CrossTabIntent): boolean {
  return intent.kind === "mutation_proposal";
}

/** This intent must be held as a pending plan until the user confirms. */
export function shouldRequireConfirmation(intent: CrossTabIntent): boolean {
  return intent.kind === "mutation_proposal" || intent.kind === "confirmed_mutation";
}
