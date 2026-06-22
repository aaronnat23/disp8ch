import type {
  DynamicWorkflowPlan,
  DynamicWorkflowPhase,
  DynamicWorkflowWorkerSpec,
  PlanResult,
  DynamicWorkflowPlanningContext,
  DynamicWorkflowPhaseStrategy,
  DynamicWorkflowAgentKind,
} from "./types";

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_WORKERS = 25;
const DEFAULT_MAX_RUNTIME_SECONDS = 900;
const MAX_TOTAL_WORKERS = 100;

// -- heuristics for isSimpleRequest --

const SIMPLE_PATTERNS: RegExp[] = [
  /^\s*$/,
  /^(hi|hey|hello|yo|sup|greetings)[\s!.]*$/i,
  /^(thanks|thank you|thx|ty|ok|okay|got it|acknowledged)[\s!.]*$/i,
  /^(yes|no|maybe|sure|yep|nope|nah|yeah)[\s!.]*$/i,
  /^what\s+is\s+\d+\s*[\+\-\*\/]\s*\d+\s*\??$/i,
  /^\d+\s*[\+\-\*\/]\s*\d+\s*=\s*\??$/,
  /^convert\s+\d+(\.\d+)?\s*(celsius|fahrenheit|km|miles|kg|lbs)\s+to\s+/i,
  /^what\s+(?:time|day|date|year)\s+(?:is\s+)?it\??$/i,
  /^what('s|s| is)\s+the\s+(?:capital|population|area)\s+of\s+/i,
  /^who\s+(?:is|was|wrote|created|founded)\s+/i,
  /^(what|how)\s+(?:is|are|do|does|did)\s+\w+\s+(?:defined|called)\??$/i,
  /^define\s+\w+\s*[?:]?\s*$/i,
  /^tell\s+me\s+a\s+joke$/i,
  /^flip\s+a\s+coin$/i,
  /^roll\s+(?:a\s+)?(?:dice|a\s+die|d\d+)/i,
  /^what('s|s)\s+the\s+weather/i,
  /^translate\s+"[^"]{0,50}"\s+to\s+\w+$/i,
  /^how\s+(?:many|much)\s+(?:is|are|does|do)\s+/i,
  /^(what|how)\s+(?:is|are)\s+(?:you|your)\s+(?:name|doing|status)\??$/i,
  /^what\s+can\s+you\s+do\??$/i,
];

const MULTI_STEP_INDICATORS: RegExp[] = [
  /(?:then|after\s+that|next|finally|subsequently)\s*[,.]?\s+/i,
  /step\s+\d+/i,
  /\bfirst\b.+\b(?:then|second|next|after)\b/i,
  /\b(?:multiple|several|various|different)\s+(?:steps?|stages?|phases?|tasks?)\b/i,
  /\b(?:and\s+then|and\s+also|as\s+well\s+as)\b/i,
  /\bdo\s+(?:all|each|every|both)\s+of/i,
  /\b(?:sequentially|one\s+after\s+another|in\s+order)\b/i,
];

const SHORT_MESSAGE_MAX_CHARS = 60;

const PARALLEL_INDICATORS: RegExp[] = [
  /\bin\s+parallel\b/i,
  /\bat\s+the\s+same\s+time\b/i,
  /\bsimultaneously\b/i,
  /\bconcurrently\b/i,
  /\b(?:both|all)\s+at\s+once\b/i,
  /\bfor\s+each\b/i,
  /\bacross\s+(?:multiple|several|all|many)\b/i,
  /\bper\s+(?:file|module|directory|project|service|endpoint|source)\b/i,
];

const REVIEW_INDICATORS: RegExp[] = [
  /\breview\b/i,
  /\b(?:code\s+review|pr\s+review|merge\s+request)\b/i,
  /\b(?:audit|inspect|examine|assess)\b/i,
  /\bcheck\s+for\b/i,
  /\b(?:find|identify|spot|detect)\s+(?:bugs?|issues?|problems?|errors?|vulnerabilit)/i,
];

const VERIFY_INDICATORS: RegExp[] = [
  /\bverify\b/i,
  /\bvalidate\b/i,
  /\btest\b/i,
  /\bdouble.?check\b/i,
  /\bconfirm\s+that\b/i,
  /\bensure\b/i,
  /\bproof.?read\b/i,
  /\bsanity\s+check\b/i,
];

const SYNTHESIZE_INDICATORS: RegExp[] = [
  /\bsummarize\b/i,
  /\bsynthesize\b/i,
  /\bconsolidate\b/i,
  /\bcombine\s+(?:results?|findings?|reports?|data|information)\b/i,
  /\bcompile\b/i,
  /\b(?:final|ultimate)\s+(?:report|summary|output|document|plan)\b/i,
  /\bcreate\s+a\s+(?:report|summary|overview|comparison|analysis)\b/i,
];

function createId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`;
}

export function isSimpleRequest(prompt: string): boolean {
  const text = String(prompt || "").trim();

  if (text.length === 0) return true;
  if (text.length < SHORT_MESSAGE_MAX_CHARS) {
    for (const pattern of SIMPLE_PATTERNS) {
      if (pattern.test(text)) return true;
    }
    const hasComplexityWord =
      /\b(build|create|design|implement|develop|refactor|migrate|deploy|configure|orchestrate|workflow|pipeline|automate|generate|scaffold|restructure)\b/i;
    if (!hasComplexityWord.test(text)) return true;
  }

  for (const pattern of MULTI_STEP_INDICATORS) {
    if (pattern.test(text)) return false;
  }

  return false;
}

export function suggestPhaseStrategy(
  taskDescription: string
): DynamicWorkflowPhaseStrategy {
  const text = String(taskDescription || "");

  const parallelScore = PARALLEL_INDICATORS.filter((p) => p.test(text)).length;
  const reviewScore = REVIEW_INDICATORS.filter((p) => p.test(text)).length;
  const verifyScore = VERIFY_INDICATORS.filter((p) => p.test(text)).length;
  const synthesizeScore = SYNTHESIZE_INDICATORS.filter(
    (p) => p.test(text)
  ).length;
  const multiStepScore = MULTI_STEP_INDICATORS.filter(
    (p) => p.test(text)
  ).length;

  if (parallelScore > 0 || multiStepScore > 0) return "fanout";
  if (reviewScore > 0) return "review";
  if (verifyScore > 0) return "verify";
  if (synthesizeScore > 0) return "synthesize";

  return "single";
}

function inferAgentKind(prompt: string): DynamicWorkflowAgentKind {
  const text = String(prompt || "");

  if (
    /code|program|script|function|class|module|refactor|debug|fix|bug|patch|implement|compile|algorithm|api|endpoint/i.test(
      text
    )
  ) {
    return "internal";
  }
  if (
    /research|search|find|look\s+up|investigate|explore|study|survey|compare|analyze/i.test(
      text
    )
  ) {
    return "internal";
  }
  if (/review|audit|inspect|assess|examine|critique/i.test(text)) {
    return "internal";
  }
  if (
    /summarize|synthesize|consolidate|compile|combine|merge|report|overview/i.test(
      text
    )
  ) {
    return "internal";
  }
  return "internal";
}

export function createDefaultPlan(
  prompt: string,
  context?: Partial<DynamicWorkflowPlanningContext>
): DynamicWorkflowPlan {
  const strategy = suggestPhaseStrategy(prompt);

  const worker: DynamicWorkflowWorkerSpec = {
    id: createId("dww"),
    role: "executor",
    prompt: String(prompt || ""),
    agentKind: inferAgentKind(prompt),
  };

  const phase: DynamicWorkflowPhase = {
    id: createId("dwph"),
    name: "Main Phase",
    instructions: "Execute the primary requested task.",
    strategy,
    workers: [worker],
  };

  return {
    objective: String(prompt || ""),
    acceptanceCriteria: [],
    phases: [phase],
    limits: {
      maxConcurrency: context?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      maxWorkers: context?.maxWorkers ?? DEFAULT_MAX_WORKERS,
      maxRuntimeSeconds:
        context?.maxRuntimeSeconds ?? DEFAULT_MAX_RUNTIME_SECONDS,
    },
  };
}

export function validatePlan(
  plan: unknown
): { success: true; plan: DynamicWorkflowPlan } | { success: false; error: string } {
  if (!plan || typeof plan !== "object") {
    return { success: false, error: "Plan must be a non-null object." };
  }

  const p = plan as Record<string, unknown>;

  if (typeof p.objective !== "string" || p.objective.trim().length === 0) {
    return {
      success: false,
      error: "Plan must have a non-empty objective string.",
    };
  }

  if (!Array.isArray(p.phases)) {
    return { success: false, error: "Plan.phases must be an array." };
  }

  if (p.phases.length === 0) {
    return { success: false, error: "Plan must have at least 1 phase." };
  }

  const phaseIds = new Set<string>();
  let totalWorkers = 0;

  for (let i = 0; i < p.phases.length; i++) {
    const phase = p.phases[i] as Record<string, unknown>;

    if (typeof phase.id !== "string" || phase.id.length === 0) {
      return {
        success: false,
        error: `Phase at index ${i} must have a non-empty string id.`,
      };
    }

    if (phaseIds.has(phase.id)) {
      return {
        success: false,
        error: `Duplicate phase id: "${phase.id}". Phase IDs must be unique.`,
      };
    }
    phaseIds.add(phase.id);

    if (!Array.isArray(phase.workers)) {
      return {
        success: false,
        error: `Phase "${phase.id}" must have a workers array.`,
      };
    }

    if (phase.workers.length === 0) {
      return {
        success: false,
        error: `Phase "${phase.id}" must have at least 1 worker.`,
      };
    }

    for (let j = 0; j < phase.workers.length; j++) {
      const worker = phase.workers[j] as Record<string, unknown>;

      if (
        typeof worker.prompt !== "string" ||
        worker.prompt.trim().length === 0
      ) {
        return {
          success: false,
          error: `Worker at index ${j} in phase "${phase.id}" must have a non-empty prompt.`,
        };
      }

      totalWorkers++;
    }
  }

  if (totalWorkers > MAX_TOTAL_WORKERS) {
    return {
      success: false,
      error: `Total workers (${totalWorkers}) exceeds maximum allowed (${MAX_TOTAL_WORKERS}).`,
    };
  }

  for (let i = 0; i < p.phases.length; i++) {
    const phase = p.phases[i] as Record<string, unknown>;

    if (Array.isArray(phase.dependsOn)) {
      for (let j = 0; j < (phase.dependsOn as string[]).length; j++) {
        const depId = (phase.dependsOn as string[])[j];

        if (!phaseIds.has(depId)) {
          return {
            success: false,
            error: `Phase "${phase.id}" depends on unknown phase id "${depId}".`,
          };
        }

        if (depId === phase.id) {
          return {
            success: false,
            error: `Phase "${phase.id}" cannot depend on itself.`,
          };
        }
      }
    }
  }

  const limits = p.limits as Record<string, unknown> | undefined;
  const maxConcurrency = Number(limits?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  if (!Number.isFinite(maxConcurrency) || maxConcurrency < 1) {
    return {
      success: false,
      error: `limits.maxConcurrency must be >= 1 (got ${limits?.maxConcurrency}).`,
    };
  }

  const maxRuntimeSeconds = Number(
    limits?.maxRuntimeSeconds ?? DEFAULT_MAX_RUNTIME_SECONDS
  );
  if (
    !Number.isFinite(maxRuntimeSeconds) ||
    maxRuntimeSeconds < 1 ||
    maxRuntimeSeconds > 86400
  ) {
    return {
      success: false,
      error: `limits.maxRuntimeSeconds must be between 1 and 86400 (got ${limits?.maxRuntimeSeconds}).`,
    };
  }

  return { success: true, plan: p as unknown as DynamicWorkflowPlan };
}

const CHARS_PER_TOKEN = 4;
const COST_PER_1K_TOKENS_INPUT = 0.001;
const COST_PER_1K_TOKENS_OUTPUT = 0.003;
const ESTIMATED_OUTPUT_RATIO = 0.5;

export function estimatePlanCost(plan: DynamicWorkflowPlan): number {
  let totalInputTokens = 0;

  totalInputTokens += Math.ceil(
    (plan.objective?.length ?? 0) / CHARS_PER_TOKEN
  );

  for (const criterion of plan.acceptanceCriteria ?? []) {
    totalInputTokens += Math.ceil((criterion?.length ?? 0) / CHARS_PER_TOKEN);
  }

  for (const phase of plan.phases) {
    totalInputTokens += Math.ceil((phase.name?.length ?? 0) / CHARS_PER_TOKEN);
    totalInputTokens += Math.ceil(
      (phase.instructions?.length ?? 0) / CHARS_PER_TOKEN
    );

    for (const worker of phase.workers) {
      totalInputTokens += Math.ceil(
        (worker.prompt?.length ?? 0) / CHARS_PER_TOKEN
      );
      totalInputTokens += 500;
    }
  }

  const estimatedOutputTokens = Math.ceil(
    totalInputTokens * ESTIMATED_OUTPUT_RATIO
  );

  const inputCost =
    (totalInputTokens / 1000) * COST_PER_1K_TOKENS_INPUT;
  const outputCost =
    (estimatedOutputTokens / 1000) * COST_PER_1K_TOKENS_OUTPUT;

  return Math.round((inputCost + outputCost) * 10000) / 10000;
}

export function generatePlanOutline(
  prompt: string,
  context?: Partial<DynamicWorkflowPlanningContext>
): PlanResult {
  const warnings: string[] = [];
  const strategy = suggestPhaseStrategy(prompt);

  const worker: DynamicWorkflowWorkerSpec = {
    id: createId("dww"),
    role: "executor",
    prompt: String(prompt || ""),
    agentKind: inferAgentKind(prompt),
  };

  const phase: DynamicWorkflowPhase = {
    id: createId("dwph"),
    name: "Research & Execute",
    instructions:
      "Investigate and execute the requested task. The LLM layer should expand this into targeted phases and workers.",
    strategy,
    workers: [worker],
  };

  if (isSimpleRequest(prompt)) {
    warnings.push(
      "Request appears to be simple. The LLM layer may reduce this to a single direct response without creating a full workflow."
    );
  }

  const plan: DynamicWorkflowPlan = {
    objective: String(prompt || ""),
    acceptanceCriteria: [],
    phases: [phase],
    limits: {
      maxConcurrency: context?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      maxWorkers: context?.maxWorkers ?? DEFAULT_MAX_WORKERS,
      maxRuntimeSeconds:
        context?.maxRuntimeSeconds ?? DEFAULT_MAX_RUNTIME_SECONDS,
    },
  };

  return { plan, outlineGenerated: true, warnings };
}
