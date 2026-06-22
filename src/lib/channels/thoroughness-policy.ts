import type { ModelLedLane } from "@/lib/channels/model-led-context";
import type { AccuracyMode } from "@/lib/agents/tool-trace";

export type ThoroughnessPolicy = {
  accuracyMode: AccuracyMode;
  reason: string;
  initialToolBudget: number;
  maxExpandedToolBudget: number;
  synthReserveMs: number;
  perToolTimeoutMs: number;
  turnDeadlineMs: number;
  suppressAuxTasks: boolean;
};

const LOCAL_MODEL_INDICATORS = /\b(ollama|lm.?studio|vllm|sglang|local|qwen|mistral|llama|deepseek(?!-api)|gemma|phi)\b/i;

const THOROUGH_MESSAGE_PATTERNS = [
  /\b(compare|comparison|vs\.?|versus)\b/i,
  /\b(research|survey|audit|review|analyze|analyse|investigate)\b/i,
  /\b(why|how can we improve|what is causing|root cause|bottleneck)\b/i,
  /\b(repo|codebase|implementation|latency|bug|inspect|grounded)\b/i,
  /\b(broad|deep|thorough|carefully|comprehensive|in detail)\b/i,
  /\b(multi.?step|plan|design|draft|blueprint|strategy)\b/i,
  /\b(safety|security|compliance|risk)\b/i,
];

const FAST_MESSAGE_PATTERNS = [
  /^(hi|hello|hey|thanks|ok|yes|no|sure|got it)[.!?]?\s*$/i,
  /^(what time|what day|what year)\b/i,
];

function isLocalModel(provider: string, modelId: string): boolean {
  return LOCAL_MODEL_INDICATORS.test(`${provider} ${modelId}`);
}

function isThoroughPrompt(message: string): boolean {
  return THOROUGH_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function isFastPrompt(message: string): boolean {
  return FAST_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function isLaneThorough(lane: ModelLedLane): boolean {
  return lane === "broad_research" || lane === "repo_inspection";
}

const ACCURACY_BUDGETS = {
  fast: {
    initialToolBudget: 6,
    maxExpandedToolBudget: 8,
  },
  balanced: {
    initialToolBudget: 18,
    maxExpandedToolBudget: 32,
  },
  thorough: {
    initialToolBudget: 64,
    maxExpandedToolBudget: 128,
  },
} satisfies Record<AccuracyMode, {
  initialToolBudget: number;
  maxExpandedToolBudget: number;
}>;

export function determineThoroughnessPolicy(input: {
  message: string;
  lane: ModelLedLane;
  provider: string;
  modelId: string;
  conversationDepth?: number;
  userModeOverride?: AccuracyMode | "auto" | null;
}): ThoroughnessPolicy {
  const { message, lane, provider, modelId } = input;
  const local = isLocalModel(provider, modelId);
  const depth = input.conversationDepth ?? 0;
  const override = input.userModeOverride;

  let mode: AccuracyMode;
  let reason: string;

  if (override && override !== "auto") {
    mode = override;
    reason = `user override: ${mode}`;
  } else if (lane === "direct" || isFastPrompt(message)) {
    mode = "fast";
    reason = "simple/direct message";
  } else if (local) {
    mode = "thorough";
    reason = `local model detected (${provider}:${modelId}) — using thorough budget`;
  } else if (isThoroughPrompt(message) || isLaneThorough(lane)) {
    mode = "thorough";
    reason = `thorough lane (${lane}) or thorough message pattern`;
  } else if (depth >= 3) {
    mode = "balanced";
    reason = "deep conversation context";
  } else {
    mode = "balanced";
    reason = "default balanced mode";
  }

  const synthReserveMs = local
    ? mode === "thorough" ? 120_000 : 60_000
    : mode === "thorough" ? 30_000 : mode === "balanced" ? 20_000 : 10_000;

  const perToolTimeoutMs = local
    ? mode === "thorough" ? 120_000 : 60_000
    : 25_000;

  const turnDeadlineMs = local
    ? mode === "thorough" ? 900_000 : mode === "balanced" ? 600_000 : 180_000
    : mode === "thorough" ? 420_000 : mode === "balanced" ? 180_000 : 60_000;

  const budget = local
    ? ACCURACY_BUDGETS.thorough
    : ACCURACY_BUDGETS[mode];

  return {
    accuracyMode: mode,
    reason,
    initialToolBudget: budget.initialToolBudget,
    maxExpandedToolBudget: budget.maxExpandedToolBudget,
    synthReserveMs,
    perToolTimeoutMs,
    turnDeadlineMs,
    suppressAuxTasks: local && mode !== "fast",
  };
}

export function buildThoroughnessInstruction(policy: ThoroughnessPolicy): string {
  const { accuracyMode, initialToolBudget, maxExpandedToolBudget } = policy;
  if (accuracyMode === "fast") {
    return "Answer quickly from available context. Avoid unnecessary tool calls.";
  }
  if (accuracyMode === "thorough") {
    return [
      `Thoroughness mode: thorough. Use up to ${initialToolBudget} tool calls (expandable to ${maxExpandedToolBudget} if required evidence is still missing).`,
      "Expand tool budget only when a required evidence need remains open and the last tool returned new, relevant information.",
      "Stop when evidence needs are satisfied, when two consecutive tools add nothing new, or when the same path fails twice.",
      "Reserve the last part of your time for final synthesis — never spend all time on tools.",
      "Final answer must address the user's actual request, cite observed evidence, and state what could not be verified.",
    ].join("\n");
  }
  return [
    `Accuracy mode: balanced. Use up to ${initialToolBudget} tool calls (expandable to ${maxExpandedToolBudget} when evidence is incomplete).`,
    "Use the minimum sufficient evidence. Stop using tools when further calls are unlikely to change the answer.",
    "Synthesize from collected evidence and note any gaps.",
  ].join("\n");
}
