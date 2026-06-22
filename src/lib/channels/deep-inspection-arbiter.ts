export type DeepInspectionIntent =
  | "repo_inspection"
  | "broad_app_synthesis"
  | "none";

export type DeepInspectionDecision = {
  intent: DeepInspectionIntent;
  confidence: "low" | "medium" | "high";
  reason: string;
  shouldBypassAppSurface: boolean;
  shouldBypassCodeTask: boolean;
};

const APP_STATE_ONLY = /\b(?:what|which|show|list|current|active|selected|status|is|are)\b[\s\S]{0,80}\b(?:model|provider|session|tool\s+mode|fast\s+mode|workspace|board|workflow|cron|setting|config|connection)\b/i;
const REPO_SCOPE = /\b(?:repo|repository|workspace|codebase|source|implementation|runtime|router|routing|lane|handler|module|component|file|files|src\/|app\/|lib\/|tool\s+call|tool\s+calls|markup|ground(?:ed|ing)|latency|timeout|no-progress|loop)\b/i;
const INSPECT_VERB = /\b(?:inspect|review|audit|analy[sz]e|trace|diagnose|find|identify|compare|explain\s+how|why\s+does|where\s+(?:is|are|does)|what\s+files?|which\s+files?)\b/i;
const BROAD_SYNTHESIS = /\b(?:design|draft|plan|blueprint|architecture|workflow|integration|strategy|proposal|implementation\s+plan|upgrade\s+plan|migration\s+plan)\b[\s\S]{0,140}\b(?:workflow|app|disp8ch|tool|tools|nodes?|data\s+flow|trigger|routing|memory|agent|webchat|board|cron|scheduler)\b/i;
const DETERMINISTIC_APP_QUERY = /\b(?:open|navigate|go\s+to|show\s+me|list|create|delete|update|rename|enable|disable|run|send|schedule)\b[\s\S]{0,80}\b(?:board|task|workflow|cron|setting|model|provider|session)\b/i;

export function classifyDeepInspectionRequest(message: string): DeepInspectionDecision {
  const text = String(message || "").trim();
  if (!text) {
    return {
      intent: "none",
      confidence: "low",
      reason: "empty",
      shouldBypassAppSurface: false,
      shouldBypassCodeTask: false,
    };
  }

  if (APP_STATE_ONLY.test(text) && !/\b(?:why|how|inspect|review|audit|analy[sz]e|implementation|latency|bug|gap|depth|accuracy)\b/i.test(text)) {
    return {
      intent: "none",
      confidence: "low",
      reason: "deterministic app-state request",
      shouldBypassAppSurface: false,
      shouldBypassCodeTask: false,
    };
  }

  if (INSPECT_VERB.test(text) && REPO_SCOPE.test(text)) {
    return {
      intent: "repo_inspection",
      confidence: "high",
      reason: "inspection verb plus repo/workspace/runtime scope",
      shouldBypassAppSurface: true,
      shouldBypassCodeTask: true,
    };
  }

  if (BROAD_SYNTHESIS.test(text) && !DETERMINISTIC_APP_QUERY.test(text)) {
    return {
      intent: "broad_app_synthesis",
      confidence: "medium",
      reason: "broad app/workflow synthesis request",
      shouldBypassAppSurface: false,
      shouldBypassCodeTask: true,
    };
  }

  return {
    intent: "none",
    confidence: "low",
    reason: "no deep-inspection trigger",
    shouldBypassAppSurface: false,
    shouldBypassCodeTask: false,
  };
}
