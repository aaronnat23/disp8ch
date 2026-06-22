import type { BoardTaskRecord } from "@/lib/boards/manager";
import type { HierarchyGoalRecord } from "@/lib/hierarchy/goals";
import type { GoalJudgeResult } from "@/lib/goals/goal-judge";

export type GoalContinuationPlan = {
  shouldQueueContinuation: boolean;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
  sourceType: "standing-continuation";
};

function compactList(values: string[] | undefined, fallback: string): string {
  const clean = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (clean.length === 0) return fallback;
  return clean.slice(0, 6).map((value) => `- ${value}`).join("\n");
}

export function buildGoalContinuationPlan(input: {
  goal: HierarchyGoalRecord;
  task: BoardTaskRecord;
  judge: GoalJudgeResult;
  workerSummary: string;
}): GoalContinuationPlan {
  if (input.judge.verdict !== "continue") {
    return {
      shouldQueueContinuation: false,
      title: "",
      description: "",
      priority: "medium",
      sourceType: "standing-continuation",
    };
  }

  const missing = compactList(input.judge.missingCriteria, "- Continue from the judge's missing criteria.");
  const titleBase = input.judge.missingCriteria[0] || input.task.title || "Continue standing goal work";
  return {
    shouldQueueContinuation: true,
    title: `Continue: ${titleBase}`.slice(0, 120),
    priority: input.task.priority === "urgent" || input.task.priority === "high" ? input.task.priority : "medium",
    sourceType: "standing-continuation",
    description: [
      `Continuation for standing goal: ${input.goal.name}`,
      `Previous task: ${input.task.title}`,
      `Judge reason: ${input.judge.reason}`,
      "",
      "Missing criteria:",
      missing,
      "",
      "Use the prior worker output as context, but verify with live tools when evidence could have changed or when repo/app state matters.",
      "",
      `Previous worker summary:\n${input.workerSummary.slice(0, 4000)}`,
    ].join("\n"),
  };
}
