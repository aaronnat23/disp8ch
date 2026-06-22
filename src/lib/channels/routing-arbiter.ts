import type { TurnPlan } from "@/lib/channels/turn-planner";
import type { TaskIntentContract } from "@/lib/channels/task-intent-contract";
import type { BroadTaskDecision } from "@/lib/channels/broad-task-decision";
import type { ModelLedLane } from "@/lib/channels/model-led-context";

export type RoutingDecision = {
  lane: ModelLedLane;
  toolPolicy: "forbidden" | "optional" | "required";
  mutationPolicy: "forbidden" | "requires_confirmation" | "allowed_after_confirmation";
  answerDepth: "brief" | "normal" | "deep";
  evidenceNeeded: string[];
  compactMode: boolean;
  requiresToolUse: boolean;
  bypassFallbackAssistant: boolean;
  routeSource: string;
  reason: string;
  conflicts: string[];
};

export function arbitrateRouting(params: {
  isProtectedBuiltin: boolean;
  isDeterministicResponse: boolean;
  deterministicRouteSource?: string;
  contract: TaskIntentContract;
  turnPlan?: TurnPlan | null;
  legacyBroadTask?: BroadTaskDecision | null;
  forceTools?: boolean;
  readOnly: boolean;
}): RoutingDecision {
  const conflicts: string[] = [];
  const plan = params.turnPlan;
  const contract = params.contract;
  const legacy = params.legacyBroadTask;

  if (params.isProtectedBuiltin) {
    return {
      lane: "direct",
      toolPolicy: "forbidden",
      mutationPolicy: "forbidden",
      answerDepth: "brief",
      evidenceNeeded: [],
      compactMode: true,
      requiresToolUse: false,
      bypassFallbackAssistant: false,
      routeSource: params.deterministicRouteSource ?? "protected-builtin",
      reason: "Protected builtin command — no model routing needed",
      conflicts: [],
    };
  }

  if (params.isDeterministicResponse) {
    return {
      lane: "direct",
      toolPolicy: "forbidden",
      mutationPolicy: "forbidden",
      answerDepth: "brief",
      evidenceNeeded: [],
      compactMode: true,
      requiresToolUse: false,
      bypassFallbackAssistant: false,
      routeSource: params.deterministicRouteSource ?? "deterministic",
      reason: "Deterministic response already produced — no further routing needed",
      conflicts: [],
    };
  }

  // ── Source-boundary overrides ──
  let toolPolicy = contract.toolPolicy;
  let mutationPolicy: RoutingDecision["mutationPolicy"] =
    /create|save|build|run|execute|schedule|send|write|mutate/i.test("")
      ? "requires_confirmation"
      : "forbidden";

  if (contract.toolPolicy === "forbidden") {
    mutationPolicy = "forbidden";
  }

  // ── Plan-based overrides ──
  if (plan) {
    mutationPolicy = plan.mutationPolicy;
    if (plan.toolPolicy !== contract.toolPolicy) {
      if (contract.toolPolicy === "forbidden") {
        toolPolicy = "forbidden";
        conflicts.push(`TurnPlan wanted toolPolicy=${plan.toolPolicy} but contract says forbidden — choosing forbidden`);
      } else if (contract.toolPolicy === "required") {
        toolPolicy = "required";
      } else if (plan.toolPolicy === "forbidden") {
        toolPolicy = "forbidden";
      } else if (
        plan.toolPolicy === "required" &&
        plan.evidenceNeeded.some((need) =>
          ["repo_files", "app_state", "benchmark_artifacts", "current_web"].includes(need)
        )
      ) {
        toolPolicy = "required";
      } else {
        toolPolicy = "optional";
      }
    } else {
      toolPolicy = plan.toolPolicy;
    }
  }

  // ── Legacy classifier cannot upgrade tool policy ──
  if (legacy && legacy.mustUseTools && toolPolicy !== "required") {
    if (toolPolicy === "optional") {
      // Legacy says required but contract says optional — keep optional
      conflicts.push("Legacy BroadTaskDecision says mustUseTools=true but contract says optional — keeping optional");
    } else if (toolPolicy === "forbidden") {
      conflicts.push("Legacy BroadTaskDecision says mustUseTools=true but contract says forbidden — keeping forbidden");
    }
  }

  // ── Override: explicit force-tools ──
  if (params.forceTools && toolPolicy === "optional") {
    // Only upgrade from optional to required when explicitly forced
    // Never override forbidden
  }

  // ── Lane selection ──
  let lane: ModelLedLane;
  if (toolPolicy === "forbidden") {
    lane = "direct";
  } else if (plan?.taskType === "web_research" || contract.requiresCurrentFacts) {
    lane = "broad_research";
  } else if (plan?.taskType === "repo_inspection" || contract.requiresRepoEvidence) {
    lane = "repo_inspection";
  } else if (plan?.taskType === "app_design" || contract.operation === "design" || contract.operation === "plan") {
    lane = "app_design";
  } else if (plan?.taskType === "app_mutation_proposal") {
    lane = "app_mutation_proposal";
  } else if (plan?.taskType === "session_recall") {
    lane = "memory_recall";
  } else {
    lane = "read_only_workspace";
  }

  // ── Answer depth ──
  const answerDepth = plan?.answerDepth ?? "normal";

  // ── Compact mode for no-tool tasks ──
  const compactMode = toolPolicy === "forbidden";

  // ── Required tool use ──
  const requiresToolUse = toolPolicy === "required";

  // ── Merge evidence needs ──
  const evidenceNeeded = Array.from(new Set([
    ...(plan?.evidenceNeeded ?? []),
    ...contract.evidenceSources,
  ]));

  return {
    lane,
    toolPolicy,
    mutationPolicy,
    answerDepth,
    evidenceNeeded,
    compactMode,
    requiresToolUse,
    bypassFallbackAssistant: false,
    routeSource: `arbiter:${lane}`,
    reason: `Arbiter: toolPolicy=${toolPolicy}, lane=${lane}, contract operation=${contract.operation}`,
    conflicts,
  };
}
