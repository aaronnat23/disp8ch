/**
 * App-design answer shapes.
 *
 * Detects the structural type of an app-design request and returns
 * the required sections and verifier checks for that type. This is
 * used by the universal agentic runtime to guide the planner and
 * the critic toward complete answers for known design shapes.
 *
 * Detection and shapes must never reference benchmark IDs, exact
 * prompt fragments, or competitor names.
 */

export type AppDesignTaskType =
  | "multi_agent_org_chart"
  | "kanban_decomposition"
  | "messaging_chief_of_staff"
  | "recurring_content_workflow"
  | "general_app_design";

export type AppDesignAnswerShape = {
  taskType: AppDesignTaskType;
  requiredSections: string[];
  verifierChecks: string[];
  structureHint: string;
};

/**
 * Detect the structural design task type from a user message.
 * Returns the most specific match or "general_app_design" as fallback.
 */
export function detectAppDesignTaskType(message: string): AppDesignTaskType {
  const text = String(message || "").toLowerCase();

  if (
    /\borg\s+chart\b/.test(text) ||
    /\breporting\s+structure\b/.test(text) ||
    /\bagent\s+hierarchy\b/.test(text)
  ) {
    return "multi_agent_org_chart";
  }

  if (
    /\bkanban\b/.test(text) ||
    /\bboard\s+decomposition\b/.test(text) ||
    /\btask\s+flow\b/.test(text)
  ) {
    return "kanban_decomposition";
  }

  if (
    /\bchief\s+of\s+staff\b/.test(text) ||
    /\bmessaging\s+setup\b/.test(text) ||
    /\bdaily\s+brief\b/.test(text) ||
    /\bintake\b/.test(text)
  ) {
    return "messaging_chief_of_staff";
  }

  if (
    /\brecurring\s+content\b/.test(text) ||
    /\bweekly\s+post\b/.test(text) ||
    /\bnewsletter\b/.test(text)
  ) {
    return "recurring_content_workflow";
  }

  return "general_app_design";
}

/**
 * Return the required sections, verifier checks, and structure hint
 * for a given app-design task type.
 */
export function getAppDesignAnswerShape(taskType: AppDesignTaskType): AppDesignAnswerShape {
  switch (taskType) {
    case "multi_agent_org_chart":
      return {
        taskType,
        requiredSections: [
          "Roles Table",
          "Reporting Tree",
          "Handoff Rules",
          "Model/Runtime Notes",
          "Board/Workflow/Council Links",
        ],
        verifierChecks: [
          "final answer must include roles and reporting/handoff structure",
        ],
        structureHint:
          "List roles in a table with responsibilities and skills, show the reporting tree, define handoff rules between roles, note any model/runtime requirements, and link to board columns, workflow nodes, or council seats where relevant.",
      };

    case "kanban_decomposition":
      return {
        taskType,
        requiredSections: [
          "Status Flow",
          "Task Decomposition Pattern",
          "Agent Assignment Rules",
          "Automation Hooks",
          "Review Gates",
        ],
        verifierChecks: [
          "must include statuses and task movement rules",
        ],
        structureHint:
          "Define the column/status sequence, show how tasks decompose into subtasks, specify which agent or role handles each status, list any automation triggers on status change, and identify any review/approval gates before a task moves forward.",
      };

    case "messaging_chief_of_staff":
      return {
        taskType,
        requiredSections: [
          "Channels",
          "Intake Rules",
          "Daily Brief Schedule",
          "Approval Gates",
          "Escalations",
        ],
        verifierChecks: [
          "must include channel, brief, and approval gates",
        ],
        structureHint:
          "List the communication channels involved, define intake routing rules for inbound messages, show the daily brief schedule and what it covers, specify which actions require approval before execution, and describe escalation paths for blocked or risky actions.",
      };

    case "recurring_content_workflow":
      return {
        taskType,
        requiredSections: [
          "Data Collection",
          "Style Memory",
          "Repetition Check",
          "Draft",
          "Score",
          "Review Before Publish",
        ],
        verifierChecks: [
          "must include data collection, draft step, and a review gate before publish",
        ],
        structureHint:
          "Show how raw source material is collected, how existing style/voice preferences are retrieved, how duplicate/repeated topics are detected, how the draft is generated, how it is scored or evaluated, and confirm that review/approval happens before any external publish action.",
      };

    case "general_app_design":
    default:
      return {
        taskType: "general_app_design",
        requiredSections: [],
        verifierChecks: [],
        structureHint:
          "Use available app primitives (workflows, board tasks, agents, automations, channels, skills, memory) and describe the design in terms of node types, safety boundaries, and required configuration steps.",
      };
  }
}
