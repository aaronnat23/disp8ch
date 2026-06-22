import type { ModelProvider } from "@/types/model";
import { callModel } from "@/lib/agents/multi-provider";
import type { BoardTaskRecord } from "@/lib/boards/manager";
import type { HierarchyGoalRecord } from "@/lib/hierarchy/goals";

export type GoalJudgeVerdict = "done" | "continue" | "blocked" | "parse_failure";

export type GoalJudgeResult = {
  verdict: GoalJudgeVerdict;
  reason: string;
  satisfiedCriteria: string[];
  missingCriteria: string[];
  blocker: string | null;
  rawResponse?: string | null;
};

const GOAL_JUDGE_SYSTEM_PROMPT = `You judge a bounded autonomous goal worker result.
Return compact JSON only.
Do not reward intent, verbosity, or promises. Judge concrete evidence and deliverables.
Use "done" only when the selected task and relevant subgoal criteria are actually satisfied.
Use "continue" when more safe work should be queued or another worker pass is needed.
Use "blocked" when progress needs missing credentials, confirmation, permissions, unavailable external systems, or user input.
Do not use benchmark IDs, known test cases, or reference-app behavior.`;

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter((item) => item.trim().length > 0).slice(0, 12);
}

function normalizeVerdict(value: unknown): GoalJudgeVerdict {
  if (value === "done" || value === "continue" || value === "blocked") return value;
  return "parse_failure";
}

export async function judgeStandingGoalProgress(input: {
  goal: HierarchyGoalRecord;
  task: BoardTaskRecord;
  siblingTasks: BoardTaskRecord[];
  workerSummary: string;
  deliverables?: string[];
  toolsUsed?: string[];
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
}): Promise<GoalJudgeResult> {
  const criteria = [
    `Goal: ${input.goal.name}`,
    input.goal.description ? `Goal description: ${input.goal.description}` : "",
    `Selected task: ${input.task.title}`,
    input.task.description ? `Task description: ${input.task.description}` : "",
    input.siblingTasks.length
      ? `Other task states:\n${input.siblingTasks.slice(0, 12).map((task) => `- [${task.status}] ${task.title}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n");

  const raw = await callModel({
    provider: input.provider as ModelProvider,
    modelId: input.modelId,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    systemPrompt: GOAL_JUDGE_SYSTEM_PROMPT,
    userMessage: [
      criteria,
      `Tools used: ${(input.toolsUsed ?? []).join(", ") || "none"}`,
      `Deliverables:\n${(input.deliverables ?? []).slice(0, 6).join("\n\n---\n\n") || "(none)"}`,
      `Worker summary:\n${input.workerSummary.slice(0, 10_000)}`,
      "Return JSON: {\"verdict\":\"done|continue|blocked\",\"reason\":\"...\",\"satisfiedCriteria\":[\"...\"],\"missingCriteria\":[\"...\"],\"blocker\":null|\"...\"}",
    ].join("\n\n"),
    temperature: 0,
    maxTokens: 900,
  });

  const rawResponse = raw.response || "";
  try {
    const parsed = JSON.parse(stripJsonFence(rawResponse)) as Record<string, unknown>;
    const verdict = normalizeVerdict(parsed.verdict);
    if (verdict === "parse_failure") {
      return {
        verdict,
        reason: "Judge returned an unsupported verdict.",
        satisfiedCriteria: [],
        missingCriteria: ["judge_json_verdict"],
        blocker: null,
        rawResponse,
      };
    }
    return {
      verdict,
      reason: typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 1200)
        : "No reason supplied by judge.",
      satisfiedCriteria: asStringArray(parsed.satisfiedCriteria),
      missingCriteria: asStringArray(parsed.missingCriteria),
      blocker: typeof parsed.blocker === "string" && parsed.blocker.trim()
        ? parsed.blocker.trim().slice(0, 600)
        : null,
      rawResponse,
    };
  } catch (err) {
    return {
      verdict: "parse_failure",
      reason: `Judge JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      satisfiedCriteria: [],
      missingCriteria: ["judge_json_parse"],
      blocker: null,
      rawResponse,
    };
  }
}
