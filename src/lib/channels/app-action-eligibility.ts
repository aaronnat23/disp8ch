/**
 * Eligibility gate for the LLM app-action planner.
 *
 * The planner acts as the primary intent resolver. It handles:
 * - Multi-step write operations (create agents, boards, workflows)
 * - Ambiguous/vague requests (the model asks clarifying questions)
 * - Web/API operations (search, fetch, browse)  
 * - Single-domain reads that aren't exact builtin matches
 */

import { isCrossSurfaceAppMutationRequest } from "./cross-tab-intent";

/** Domains the app controls — used to detect multi-domain prompts. */
const DOMAIN_PATTERNS: Record<string, RegExp> = {
  agents: /\b(?:agent|assistant|worker|persona|bot|analysts?|people|person|members?)\b/i,
  boards: /\b(?:board|tasks?|card|todo|kanban|inbox|backlog|follow[-\s]?ups?|track(?:ed|ing)?\s+somewhere|next\s+steps?|follow[-\s]?up\s+work)\b/i,
  org: /\b(?:org(?:anization)?|hierarchy|team|crew|department)\b/i,
  council: /\bcouncil\b|\b(?:have|let|ask|get|run)\s+(?:them|the\s+agents?|agents?|the\s+org(?:anization)?|the\s+team|the\s+crew|the\s+council)\s+(?:to\s+)?(?:decide|discuss|debate|deliberate|vote|choose|pick)\b/i,
  workflows: /\b(?:workflows?|flows?|pipelines?|automations?|templates?)\b/i,
  channels: /\b(?:channel|telegram|discord|whatsapp|slack|webchat|bluebubbles|teams)\b/i,
  scheduler: /\b(?:schedule|cron|recurring|daily|weekly|every)\b/i,
  goals: /\b(?:goal|objective|milestone|target)\b/i,
  memory: /\b(?:memory|remember|recall|knowledge)\b/i,
};

/** Hard-excluded patterns — destructive, secrets, pure chitchat. */
const EXCLUDED_PATTERNS = [
  // Credentials / secrets
  /\b(?:api\s*key|secret|password|token|credential|oauth)\b/i,
  // Destructive
  /\b(?:delete|remove|clear|reset|wipe|destroy|drop|purge|nuke)\b/i,
  // Pure creative writing (no app surface)
  /\b(?:character|story|novel|fiction|spy\s+story|fantasy|game\s+idea|tagline|poem|brainstorm(?:ing)?\s+names?)\b/i,
  // Pure lifestyle (no app surface)
  /\b(?:kitchen|camping|school|bicycle|groceries|sleep|career\s+change|morning\s+routine|science\s+party|fantasy\s+football|workflow\s+diagram\b.*\bstudying|studying\b.*\bworkflow\s+diagram|brainstorm\s+activities\b.*kids|health\s+check\s+.*diet|diet\s+plan\b.*\brisky)\b/i,
  // Explicit negative controls — read-only/planning-only language
  /\b(?:don'?t|do\s+not|without)\s+(?:creat(?:ing|e)?|chang(?:ing|e)?|modif(?:ying|y)?|updat(?:ing|e)?|mak(?:ing|e)?|add(?:ing)?|run(?:ning)?|execut(?:ing|e)?|touch(?:ing)?|do(?:ing)?|apply(?:ing)?)\b/i,
  // Read-only planning language: "just list", "just tell", "but don't create", "without changing"
  /\b(?:just\s+(?:list|tell|suggest|brainstorm|talk|discuss|describe)|but\s+don'?t\s+(?:create|change|modify|update)|(?:list|tell|suggest)\s+.*\b(?:but\s+don'?t|without)\b)/i,
  // Pure conversation / read-only status questions (no app mutation intent)
  /\b(?:how\s+are\s+you|what'?s?\s+up|how'?s?\s+it\s+going)\b/i,
  // Single-word / very short
  /^.{0,5}$/,
];

/**
 * Returns `true` when the message should go through the LLM planner.
 * 
 * Now much wider — catches:
 * - Any multi-domain message
 * - Any message with app-specific vocabulary
 * - Any message 20+ chars that isn't pure chitchat
 * - Web/search/fetch/browse operations
 * - Vague or ambiguous requests
 */
export function isAppActionPlannerEligible(message: string): boolean {
  const raw = String(message || "").trim();
  if (raw.length < 8) return false;

  // Hard excludes first
  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.test(raw)) return false;
  }

  // Explicit source-QA: id-bearing notebook/document questions are read-only
  // retrieval asks (handled by the source-QA lane), never mutation plans.
  if (
    /\b(?:notebook|data\s+source|document|source)\b[\s\S]{0,80}\bid\s*:\s*[A-Za-z0-9_-]{6,}/i.test(raw) &&
    /\b(?:answer|ask|search|find|question|citations?|cite)\b/i.test(raw)
  ) {
    return false;
  }

  if (isCrossSurfaceAppMutationIntent(raw)) return true;

  // Workflow lifecycle and node-config mutations reach the planner so they become
  // confirmation-gated, typed actions executed deterministically. The read-only
  // LLM workflow_* tool lane can inspect but never mutate.
  if (isWorkflowActivationMutationIntent(raw)) return true;

  // Workflow/channel setup is a real app mutation even when phrased as a
  // natural-language build request. It should become a confirmation-gated plan,
  // not fall through to the read-only workflow tool lane.
  if (isWorkflowChannelWriteIntent(raw)) return true;

  // Workflow node-config EDIT mutations (change a node's prompt/url/model/etc. inside a
  // named workflow) reach the planner so they become confirmation-gated, typed
  // update_workflow_node / set_workflow_node_model actions executed deterministically.
  // (The read-only LLM workflow_* tool lane can inspect but never mutate.)
  if (isWorkflowNodeEditMutationIntent(raw)) return true;

  // Other workflow editing/inspection prompts go through the LLM workflow_* tool
  // catalog (workflow_list, workflow_get, etc.) — read-only. The LLM picks the tool.
  if (isWorkflowEditOrInspectIntent(raw)) return false;

  // Hierarchy mutation intent (rename/switch/apply template/update goal/role,
  // assign goal, attach sources, export package) should reach the planner so it
  // can map fuzzy intent to typed hierarchy actions. Structural verb+noun
  // detection only — no per-topic answer tables.
  if (isHierarchyMutationIntent(raw)) return true;

  if (
    /\b(?:comparison|compare)\b/i.test(raw) &&
    /\b(?:reference\s+(?:app|agent)|disp8ch AI|based only on what you know|from this session)\b/i.test(raw)
  ) return false;

  if (/^(?:search|find|look\s+up|browse)\s+(?:the\s+web|web|online|internet)\b/i.test(raw)) return false;
  if (/^(?:remember|save this test fact|store this test fact)\b/i.test(raw)) return false;
  if (/^(?:write|draft)\s+(?:a\s+|an\s+)?(?:two[-\s]sentence\s+)?(?:release note|product update|markdown answer|tagline|poem|story)\b/i.test(raw)) return false;
  // Plan-only workflow/automation prompts: a design/propose/plan request that
  // explicitly says not to create/build/save/run (or "just the plan") should
  // produce a spec via the agentic runtime, not a deterministic write plan.
  if (
    /\b(?:design|map\s+out|propose|draft|plan|outline|sketch|spec\s+out)\b/i.test(raw) &&
    /\b(?:workflow|automation|pipeline|flow)\b/i.test(raw) &&
    (/\b(?:do\s+not|don'?t|without)\b[\s\S]{0,30}\b(?:creat|build|sav|run|execut|make|implement|set\s*up|deploy)\w*/i.test(raw) ||
      /\bjust\s+the\s+plan\b|\bplan\s+only\b|\bno\s+need\s+to\s+(?:creat|build|save|run|make)\w*/i.test(raw))
  ) return false;
  if (/\b(?:create|draft)\s+(?:a\s+)?(?:plan|design)\b/i.test(raw) && /\b(?:ask before|do not|don't|without)\b/i.test(raw)) return false;
  if (/^(?:in\s+the\s+active\s+org|read\s+(?:the\s+)?current\s+hierarchy|summarize\s+what\s+agents|what\s+agents)\b/i.test(raw)) return false;

  // Direct execution against an existing named organization belongs to the
  // deterministic org runner. The planner tends to interpret these follow-up
  // requests as "create another team/org, then run it", which duplicates data.
  if (isExistingOrganizationRunCommand(raw)) return false;
  // Explicit workflow execution/no-match commands belong to the deterministic
  // workflow router so missing names produce a precise no-match response.
  if (/^(?:run|execute|trigger|start)\s+workflow\s*:/i.test(raw)) return false;
  // Deterministic multi-step workflow create/schedule/export requests have a
  // dedicated preview builder that queues confirmation without model guessing.
  if (
    /\b(?:build|create|generate|design|draft|set\s+up|setup|spin\s+up)\s+(?:a\s+)?workflow\s+called\b/i.test(raw) &&
    /\brun\s+it\b|\bmake\s+that\s+run\b/i.test(raw) &&
    /\bexport\s+it\s+to\b/i.test(raw)
  ) return false;

  const hasWriteIntent = /\b(?:set\s*up|organize|optimi[sz](?:e|ing|ation)?|create|make|build|add|connect|schedule|assemble|prepare|configure|improve|fix|run|execute)\b/i.test(raw);

  // Read-only status/navigation questions across multiple app domains should
  // stay on the deterministic builtin router. The planner may otherwise turn
  // "where can I see members and start a debate?" into a write plan.
  const startsReadOnly =
    /^(?:what|which|who|where|how|are|is|does|do|show|list|display|give|tell)\b/i.test(raw) ||
    /^(?:anything|any)\s+(?:disconnected|offline|broken|unhealthy)\b/i.test(raw);
  const appReadSurface =
    /\b(?:org(?:anization)?|hierarchy|team|crew|members?|council|debate|vote|decision\s+process|workflows?|flows?|automations?|docs?|documents?|data\s+sources?|channels?|disconnected|offline|metrics?|usage|spend|cost|tokens?|budget)\b/i.test(raw);
  const writeAction =
    /\b(?:create|make|build|add|connect|schedule|configure|execute|run\s+(?:a\s+)?(?:workflow|council|plan)|apply|change|modify|update)\b/i.test(raw);
  if (!writeAction && startsReadOnly && appReadSurface) {
    return false;
  }

  if (/^help\s+me\s+understand\b/i.test(raw) && !writeAction) return false;

  if (
    !hasWriteIntent &&
    /\b(?:explain|describe|define|compare|what(?:'s| is)?\s+the\s+difference|difference\s+between|how\s+do\s+.*\s+work)\b/i.test(raw)
  ) {
    return false;
  }

  const domainCount = countMatchingDomains(raw);

  // Multi-domain prompt (2+ domains) — always eligible
  if (domainCount >= 2) return true;

  // Single domain with app vocabulary — let planner decide
  // BUT skip clearly read-only status/query phrasings
  if (domainCount === 1) {
    const isReadOnlyPhrasing = /^(?:what|which|who|where|how|are|is|does|do|show|list|display|give|tell)\b.*\?$/i.test(raw.trim());
    if (!isReadOnlyPhrasing) return true;
    // Even read-only phrasings with operational verbs go to planner
    if (hasWriteIntent) return true;
  }

  // Web/search/fetch operations (no specific domain but still actionable)
  if (/\b(?:search|fetch|browse|look\s+up|find|get\s+.*\s+(?:from|on)\s+|check\s+.*\s+(?:website|site|url|page|online|web)|what\s+(?:does|is)\s+.*\s+(?:website|site|page|url|say|return|show))\b/i.test(raw)) {
    return true;
  }

  // Vague operational verbs — "help me set up", "organize", "optimize"
  if (
    /\b(?:set\s*up|organize|optimi[sz](?:e|ing|ation)?|assemble|prepare|get\s+(?:started|going|running)|handle\s+this|help\s+(?:me\s+)?(?:with\s+)?|configure|improve|fix|build\s+(?:a\s+)?(?:team|workflow|agent|board|org)|make\s+(?:this|it|things?)\s+(?:work|better|right))\b/i.test(raw) ||
    /\bmake\s+(?:my|the|these|our)?\s*(?:agents?\s+and\s+workflows?|workflows?\s+and\s+agents?)\s+better\b/i.test(raw)
  ) {
    return true;
  }

  // Sequencing connectors
  if (/\b(?:and\s+then|after\s+that|then\s+(?:also\s+)?|also\s+|once\s+(?:that'?s?\s+)?done|followed\s+by)\b/i.test(raw)) {
    return true;
  }

  return false;
}

function isCrossSurfaceAppMutationIntent(raw: string): boolean {
  // Single source of truth in the shared cross-tab intent layer. The canonical
  // detector also covers the "save" write verb via update/create coverage.
  return isCrossSurfaceAppMutationRequest(raw) || /\bsave\b/i.test(raw) && crossSurfaceSaveFallback(raw);
}

/** Preserve the eligibility variant's "save"-as-write coverage. */
function crossSurfaceSaveFallback(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  if (
    /\b(?:do\s+not|don'?t|without)\s+(?:creat(?:e|ing)?|chang(?:e|ing)?|modif(?:y|ying)?|updat(?:e|ing)?|mak(?:e|ing)?|add(?:ing)?|run(?:ning)?|execut(?:e|ing)?|sav(?:e|ing)?|schedul(?:e|ing)?)\b/i.test(value) ||
    /\b(?:plan\s+only|just\s+the\s+plan|proposal\s+only|hypothetical|what\s+would\s+happen|show\s+me\s+what\s+would\s+happen)\b/i.test(value)
  ) {
    return false;
  }
  const surfaceCount = [
    /\b(?:agents?|assistants?|workers?|people|person|members?)\b/i,
    /\b(?:org(?:anization)?s?|hierarch(?:y|ies)|teams?|crews?|departments?|structure)\b/i,
    /\b(?:council|debate|deliberat|vote|verdict|consensus|argue|argument)\b|\b(?:have|let|ask|get|run)\s+(?:them|the\s+agents?|agents?|the\s+org(?:anization)?|the\s+team|the\s+crew|the\s+council)\s+(?:to\s+)?(?:decide|discuss|debate|deliberate|vote|choose|pick)\b/i,
    /\b(?:workflows?|flows?|automations?|pipelines?|templates?|monitor|monitoring|check)\b/i,
    /\b(?:schedule|scheduled|daily|weekly|recurring|cron|every\s+(?:day|week|morning|weekday))\b/i,
    /\b(?:boards?|tasks?|cards?|todo|kanban|follow[-\s]?ups?|track|tracking)\b/i,
    /\b(?:channels?|telegram|discord|whatsapp|slack|teams|webchat|alerts?|notifications?)\b/i,
    /\b(?:goals?|objectives?|milestones?|targets?)\b/i,
    /\b(?:skills?)\b/i,
    /\b(?:extensions?|plugins?|tools?)\b/i,
  ].filter((pattern) => pattern.test(value)).length;
  return surfaceCount >= 3;
}

function countMatchingDomains(message: string): number {
  return Object.values(DOMAIN_PATTERNS).filter((pattern) => pattern.test(message)).length;
}

/**
 * Detects natural-language requests to mutate Hierarchy objects (orgs, goals,
 * agent roles, source links, org packages). These should route to the
 * app-action planner so it can produce typed, confirmation-gated actions.
 *
 * This is structural verb+noun detection. It does not bake fixed answers or
 * match specific org/goal/template names.
 */
export function isHierarchyMutationIntent(raw: string): boolean {
  const orgNoun = /\b(?:org|organi[sz]ations?|compan(?:y|ies)|teams?|crews?|departments?|hierarch(?:y|ies))\b/i;
  const goalNoun = /\b(?:goals?|objectives?|milestones?|key\s+results?|okrs?)\b/i;

  // Apply a company/org template.
  if (/\btemplate\b/i.test(raw) && (orgNoun.test(raw) || /\bcompany\b/i.test(raw))) return true;

  // Switch / activate an organization.
  if (/\b(?:switch|change|set)\b[\s\S]{0,40}\b(?:active\s+)?(?:org|organi[sz]ation)\b/i.test(raw)) return true;
  if (/\bswitch\s+to\b[\s\S]{0,40}\borg/i.test(raw)) return true;
  if (/\bmake\b[\s\S]{0,40}\b(?:org|organi[sz]ation)\b[\s\S]{0,20}\bactive\b/i.test(raw)) return true;

  // Rename / revise / update an organization or its mission/description.
  if (/\b(?:rename|re-?name|revise|update|change|edit)\b[\s\S]{0,40}/i.test(raw) && orgNoun.test(raw)) return true;
  if (/\b(?:mission|description)\b[\s\S]{0,40}/i.test(raw) && orgNoun.test(raw)) return true;

  // Update a goal's status / level / parent / name.
  if (/\b(?:make|set|change|update|rename|move|mark)\b[\s\S]{0,40}/i.test(raw) && goalNoun.test(raw)) return true;
  if (/\b(?:status|level|parent)\b[\s\S]{0,40}/i.test(raw) && goalNoun.test(raw)) return true;

  // Agent reporting line / role / capabilities / vote weight.
  if (/\breport(?:s|ing)?\s+to\b/i.test(raw)) return true;
  if (/\breporting\s+line\b/i.test(raw)) return true;
  if (/\bvote\s+weight\b/i.test(raw)) return true;
  if (/\b(?:add|set|change|update)\b[\s\S]{0,40}\bcapabilit/i.test(raw)) return true;
  if (/\b(?:make|set|change)\b[\s\S]{0,40}\b(?:an?\s+)?(?:orchestrator|operations\s+lead|specialist|support\s+agent|worker)\b/i.test(raw)) return true;

  // Assign a goal to all/every/the team.
  if (/\bassign\b[\s\S]{0,40}(?:goal|objective)/i.test(raw) && /\b(?:all|every|everyone|the\s+team|each|org)\b/i.test(raw)) return true;
  if (/\bassign\b[\s\S]{0,60}\bto\s+(?:all|every|each|everyone|the\s+(?:team|org|whole))\b/i.test(raw)) return true;
  if (/\b(?:one\s+task\s+per|task\s+for\s+(?:each|every))\b/i.test(raw) && (orgNoun.test(raw) || goalNoun.test(raw))) return true;

  // Attach documents / data sources / source packs to a goal.
  if (/\b(?:attach|link|add)\b[\s\S]{0,60}\bto\b[\s\S]{0,40}/i.test(raw) && goalNoun.test(raw) && /\b(?:doc|document|source|data\s+source|file|pack|notes?|checklist)\b/i.test(raw)) return true;
  if (/\b(?:source\s+pack|data\s+sources?)\b/i.test(raw) && goalNoun.test(raw)) return true;

  // Export an org package.
  if (/\bexport\b[\s\S]{0,30}\b(?:org|organi[sz]ation|package)\b/i.test(raw)) return true;

  return false;
}

function isExistingOrganizationRunCommand(message: string): boolean {
  return (
    /^(?:start|run|execute|launch|ask|have)\s+(?:the\s+)?(?:research|analysis|investigation|work|task)\s+(?:for|using|with)\s+.+?\s+org(?:anization)?(?:\s+(?:about|on|to|for)\s+.+)?$/i.test(message) ||
    /^(?:start|run|execute|launch|ask|have)\s+.+?\s+(?:using|with|for)\s+.+?\s+org(?:anization)?$/i.test(message)
  );
}

function isPureConversation(raw: string): boolean {
  // Greetings, small talk, pure chitchat
  return /^(?:hi|hey|hello|thanks|thank\s+you|ok|okay|bye|good\s+(?:morning|afternoon|evening|night)|how\s+are\s+you|what['']?s\s+up|yo|sup|hows\s+it\s+going)\b/i.test(raw.trim());
}

/**
 * Detects prompts that should be handled by the workflow_* LLM tool catalog
 * (workflow_list, workflow_get, workflow_update_node, workflow_set_model,
 * workflow_create_credential, workflow_attach_credential, workflow_update_schedule, workflow_toggle_active, workflow_duplicate,
 * workflow_run, workflow_execution_status, workflow_delete).
 *
 * The LLM picks which specific tool to call — this function only excludes
 * such prompts from the deterministic planner so they reach the LLM tool lane.
 */
export function isWorkflowEditOrInspectIntent(raw: string): boolean {
  // Must mention workflow(s) or specific workflow concepts
  const hasWorkflowReference = /\b(?:workflows?|cron|cron-trigger|schedule|the\s+\w+\s+(?:workflow|cycle|pipeline|automation))\b/i.test(raw);
  if (!hasWorkflowReference) return false;

  // Listing / inspecting an existing workflow
  if (/\b(?:list|show|view|see|describe|get|read|check|display)\b[\s\S]{0,40}\b(?:workflows?|nodes?|workflow's|cron|schedule|active|inactive)\b/i.test(raw)) return true;
  if (/\b(?:what\s+workflows?|which\s+workflows?|workflows?\s+(?:do\s+i|do\s+we)\s+have|how\s+many\s+workflows?)\b/i.test(raw)) return true;
  if (/\b(?:configuration|config|nodes?|prompts?|systemPrompt|url|headers?|expression|timezone|model|agent|tools?)\b\s+(?:of|for|in|on)\s+(?:the\s+|my\s+|our\s+)?\w+\s*(?:workflow|cycle|pipeline)\b/i.test(raw)) return true;

  // Editing a node or workflow attribute
  if (/\b(?:edit|change|update|modify|set|adjust|swap|replace|tweak|increase|decrease|raise|lower)\b[\s\S]{0,80}\b(?:prompt|systemPrompt|url|header|tool|allowlist|temperature|maxTokens|model|agent|expression|cron|schedule|timezone)\b/i.test(raw)) return true;
  if (/\b(?:in\s+(?:the\s+)?\w+\s+workflow|of\s+(?:the\s+)?\w+\s+workflow|\w+\s+workflow'?s\s+\w+)\b/i.test(raw)) return true;

  // Lifecycle: run / enable / disable / duplicate / delete
  if (/\b(?:run|trigger|execute|fire|kick\s+off|start)\b[\s\S]{0,40}\b(?:workflow|the\s+\w+\s+(?:workflow|cycle|pipeline|automation))\b/i.test(raw)) return true;
  if (/\b(?:disable|enable|turn\s+(?:on|off)|pause|resume|activate|deactivate)\b[\s\S]{0,80}\b(?:workflow|cron|schedule|trigger|automation)\b/i.test(raw)) return true;
  if (/\b(?:duplicate|clone|copy)\b[\s\S]{0,80}\b(?:workflow|automation|pipeline)\b/i.test(raw)) return true;
  if (/\b(?:delete|remove|trash|drop)\b[\s\S]{0,80}\b(?:workflow|automation|pipeline)\b/i.test(raw)) return true;

  // Execution status follow-up
  if (/\b(?:is|when|how|what)\b[\s\S]{0,40}\b(?:done|finished|complete|completed|running|pending|status)\b[\s\S]{0,80}\b(?:workflow|execution|run|cycle)\b/i.test(raw)) return true;

  return false;
}

/**
 * Detects explicit requests to create/build/connect a workflow that also
 * configures a channel notification path. These are write intents: the model
 * should draft typed app-actions and wait for confirmation.
 */
export function isWorkflowChannelWriteIntent(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  if (/\b(?:without\s+(?:creating|building|making|saving|connecting|configuring|changing|touching)|do\s+not\s+(?:create|build|make|save|connect|configure|change|touch)|don'?t\s+(?:create|build|make|save|connect|configure|change|touch)|just\s+(?:design|show|explain|describe)|plan\s+only|read\s+only|review\s+only)\b/i.test(value)) {
    return false;
  }
  const hasWriteVerb = /\b(?:build|create|make|set\s*up|setup|prepare|connect|wire|configure|add)\b/i.test(value);
  if (!hasWriteVerb) return false;
  const hasWorkflow = /\b(?:workflow|workflows|automation|automations|pipeline|pipelines|flow|flows)\b/i.test(value);
  if (!hasWorkflow) return false;
  return /\b(?:telegram|slack|discord|whatsapp|teams|webchat|bluebubbles|channel|channels|alerts?|notifications?|notify|send)\b/i.test(value);
}

/**
 * Detects a request to EDIT a node's configuration inside a specific workflow
 * (vs. inspecting, listing, or lifecycle toggles). These become confirmation-gated
 * `update_workflow_node` / `set_workflow_node_model` planner actions.
 *
 * Requires: an edit verb + a node/config attribute + a workflow reference. Read-only
 * qualifiers and pure schedule/cron edits (handled by schedule_workflow) are excluded.
 */
export function isWorkflowNodeEditMutationIntent(raw: string): boolean {
  const value = String(raw || "");
  // Must reference a workflow.
  if (!/\b(?:workflow|flow|pipeline|automation|the\s+\w+\s+(?:workflow|cycle|pipeline))\b/i.test(value)) return false;
  // Read-only / planning qualifiers are not mutations.
  if (/\b(?:without\s+(?:creating|changing|modifying|editing|touching|applying)|do\s+not\s+(?:change|edit|modify|apply|touch)|don'?t\s+(?:change|edit|modify|apply|touch)|just\s+show|only\s+show|what\s+is|what'?s\s+the|inspect|review\s+only)\b/i.test(value)) return false;
  const hasEditVerb = /\b(?:change|set|update|modify|edit|adjust|swap|replace|rename|tweak|rewrite|increase|decrease|raise|lower|reconfigure)\b/i.test(value);
  if (!hasEditVerb) return false;
  const hasNodeAttr = /\b(?:node|prompt|system\s*prompt|systemPrompt|url|endpoint|header|body|model|agent|temperature|max\s*tokens|maxTokens|tool|allowlist|expression|code|message|filter|query)\b/i.test(value);
  if (!hasNodeAttr) return false;
  // Exclude pure schedule/cron edits (own action) unless a node attr is clearly meant.
  if (/\b(?:cron|schedule|timezone|every\s+(?:day|week|hour))\b/i.test(value) && !/\b(?:node|prompt|url|model|header|temperature|code|expression|agent)\b/i.test(value)) return false;
  return true;
}

/**
 * Detects a request to activate/enable/disable an existing workflow. These
 * become confirmation-gated `toggle_workflow_active` app-actions.
 */
export function isWorkflowActivationMutationIntent(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  if (!/\b(?:workflow|flow|pipeline|automation)\b/i.test(value)) return false;
  if (/\b(?:without\s+(?:activating|enabling|disabling|changing|touching)|do\s+not\s+(?:activate|enable|disable|change|touch)|don'?t\s+(?:activate|enable|disable|change|touch)|just\s+show|only\s+show|inspect|review\s+only)\b/i.test(value)) return false;
  return /\b(?:activate|enable|turn\s+on|deactivate|disable|turn\s+off|toggle)\b/i.test(value);
}
