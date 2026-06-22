export type SideEffectPolicy = {
  mode: "plan_only" | "mutation_allowed";
  reason: string;
  planOnlySignals: string[];
  mutationSignals: string[];
  sideEffectPolicyConflict: boolean;
  sideEffectPolicySignals: string[];
};

const PLAN_ONLY_PATTERNS: Array<[RegExp, string]> = [
  [/\bdo\s+not\s+(?:create|save|start|run|execute|schedule|send|publish|post|deploy|modify|change|edit|update|write)\b/i, "explicit-do-not-mutate"],
  [/\bwithout\s+(?:creating|saving|starting|running|executing|scheduling|sending|publishing|posting|deploying|modifying|changing|editing|updating|writing)\b/i, "explicit-without-mutation"],
  [/\bhold\s+for\s+review\b/i, "hold-for-review"],
  [/\b(?:review|approve|approval)\s+(?:first|gate|before)\b/i, "review-before-action"],
  [/\b(?:plan|proposal|propose|outline|blueprint|draft\s+the\s+setup|design\s+the\s+workflow|design\s+a\s+(?:workflow|setup|process|routine|pipeline))\b/i, "planning-language"],
  [/\bdesign\b.{0,100}\b(?:workflow|setup|process|routine|pipeline)\b/i, "design-as-planning"],
  [/\binstead\s+of\s+(?:publishing|posting|sending|saving|creating|running|scheduling)\b/i, "instead-of-side-effect"],
  [/\bmap\s+out\b/i, "map-out-planning"],
  [/\bsketch\b/i, "sketch-planning"],
  [/\bspec\s+out\b|\bspec\s+/i, "spec-planning"],
  [/\bimplementation\s+plan\b/i, "implementation-plan-language"],
  [/\bhow\s+would\s+we\b/i, "hypothetical-design"],
  [/\bwhat\s+should\s+we\s+build\b/i, "hypothetical-design"],
  [/\bdo\s+not\s+actually\b/i, "explicit-do-not-actually"],
  [/\bjust\s+tell\s+me\b/i, "just-tell-me"],
  [/\bhold\s+off\b/i, "hold-off"],
  [/\breview\s+manually\b/i, "review-manually"],
  [/\bapproval\s+before\b/i, "approval-before"],
  [/\bbefore\s+I\s+publish\b/i, "before-publish"],
  [/\bdraft\s+only\b/i, "draft-only"],
];

const MUTATION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:create|save|build|generate|make)\s+(?:a\s+)?(?:design\s+studio\s+)?(?:project|artifact|html\s+artifact|dashboard\s+ui|landing\s+page|prototype|mockup|web\s+page)\b/i, "explicit-design-artifact-create"],
  [/\b(?:use|open)\s+design\s+studio\b/i, "explicit-design-studio"],
  [/\b(?:give|send)\s+me\s+(?:the\s+)?(?:preview\s+link|artifact\s+id|project\s+id)\b/i, "expects-persisted-artifact"],
  [/\b(?:create|save|build|run|start|schedule|enable|publish|post|send|deploy)\s+(?:it|this|the\s+(?:workflow|automation|task|post|thread|dashboard|page))\s+(?:now|for\s+me)?\b/i, "explicit-action-now"],
  [/\badd\s+(?:it|this|the\s+task|the\s+workflow)\s+to\s+(?:the\s+)?(?:board|schedule|scheduler|workflow|automation)\b/i, "explicit-add-to-app"],
  [/\bcreate\s+and\s+save\b/i, "create-and-save"],
  [/\bbuild\s+and\s+deploy\b/i, "build-and-deploy"],
  [/\bmake\s+the\s+artifact\b/i, "make-artifact"],
  [/\bcreate\s+the\s+workflow\s+in\s+the\s+app\b/i, "create-workflow-in-app"],
  [/\badd\s+this\s+task\s+to\s+(?:the\s+)?board\b/i, "add-task-to-board"],
  [/\bschedule\s+it\s+now\b/i, "schedule-now"],
  [/\bsend\s+it\s+now\b/i, "send-now"],
];

// Phrase patterns that resolve conflicts in favor of mutation even when plan-only signals are present.
const STRONG_MUTATION_PHRASE = /\b(now|in\s+the\s+app|save\s+it|run\s+it|schedule\s+it|send\s+it)\b/i;

function collectSignals(message: string, patterns: Array<[RegExp, string]>): string[] {
  const out: string[] = [];
  for (const [pattern, label] of patterns) {
    if (pattern.test(message)) out.push(label);
  }
  return out;
}

export function classifySideEffectPolicy(message: string): SideEffectPolicy {
  const text = String(message || "");
  const planOnlySignals = collectSignals(text, PLAN_ONLY_PATTERNS);
  const mutationSignals = collectSignals(text, MUTATION_PATTERNS);
  const allSignals = [...planOnlySignals, ...mutationSignals];
  const conflict = planOnlySignals.length > 0 && mutationSignals.length > 0;

  // Conflict resolution: if both kinds of signals fire, mutation wins only if
  // a strong mutation phrase (now/in the app/save it/run it/schedule it/send it) is present.
  if (conflict) {
    const strongMutation = STRONG_MUTATION_PHRASE.test(text);
    if (strongMutation) {
      return {
        mode: "mutation_allowed",
        reason: `Conflict resolved to mutation_allowed: strong mutation phrase in "${mutationSignals.join(", ")}" overrides plan-only signals "${planOnlySignals.join(", ")}"`,
        planOnlySignals,
        mutationSignals,
        sideEffectPolicyConflict: true,
        sideEffectPolicySignals: allSignals,
      };
    }
    // No strong mutation phrase — plan-only wins in conflict.
    return {
      mode: "plan_only",
      reason: `Conflict resolved to plan_only: no strong mutation phrase to override plan-only signals "${planOnlySignals.join(", ")}"`,
      planOnlySignals,
      mutationSignals,
      sideEffectPolicyConflict: true,
      sideEffectPolicySignals: allSignals,
    };
  }

  if (planOnlySignals.length > 0) {
    return {
      mode: "plan_only",
      reason: `Plan-only side-effect boundary from ${planOnlySignals.join(", ")}`,
      planOnlySignals,
      mutationSignals,
      sideEffectPolicyConflict: false,
      sideEffectPolicySignals: allSignals,
    };
  }

  return {
    mode: "mutation_allowed",
    reason: mutationSignals.length > 0
      ? `Explicit mutation/artifact intent from ${mutationSignals.join(", ")}`
      : "No explicit plan-only side-effect boundary detected.",
    planOnlySignals,
    mutationSignals,
    sideEffectPolicyConflict: false,
    sideEffectPolicySignals: allSignals,
  };
}

export function isPlanOnlyRequest(message: string): boolean {
  return classifySideEffectPolicy(message).mode === "plan_only";
}

export const MUTATION_TOOL_NAMES = new Set([
  "workflow_create",
  "workflow_run",
  "workflow_toggle_active",
  "workflow_duplicate",
  "workflow_update_node",
  "workflow_set_model",
  "workflow_create_credential",
  "workflow_attach_credential",
  "workflow_update_schedule",
  "workflow_delete",
  "webhooks_create",
  "webhooks_rotate_secret",
  "webhooks_toggle",
  "webhooks_delete",
  "board_tasks",
  "design_project_create",
  "design_artifact_create",
  "design_artifact_update",
  "design_artifact_patch",
  "design_artifact_preview_check",
  "design_artifact_rollback",
  "write_file",
  "bash_exec",
]);
