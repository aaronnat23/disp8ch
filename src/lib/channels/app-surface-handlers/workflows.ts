export function handleWorkflowRequest(message: string): string | null {
  const msg = message.toLowerCase().trim();

  // Pure navigation only. A workflow *design / plan / draft* request is a
  // reasoning task — it must produce a real multi-node design (trigger, every
  // node, data flow, risks, tests). A deterministic template cannot do that
  // well, so we decline (return null) and let the request fall through to the
  // LLM tool lane, which reads the repo and produces a grounded design.
  //
  // We also fall through when the prompt asks about specific workflows by
  // intent (list/get/run/edit/change/update/disable/duplicate/delete/status)
  // — those are now handled by the workflow_* LLM tools, not navigation.
  if (
    /\b(show|open|go\s+to|navigate\s+to|take\s+me\s+to)\b/.test(msg) &&
    /\bworkflow/.test(msg) &&
    !/\b(create|design|build|draft|plan|make|set\s+up)\b/.test(msg) &&
    !/\b(list|get|run|edit|change|update|modify|disable|enable|duplicate|clone|delete|remove|status|swap|replace|set|tool|nodes?|prompt|url|header|schedule|cron|expression|model|agent|active|inactive|specific|details?|config(?:uration)?)\b/.test(msg) &&
    !/\b(?:the\s+\w+\s+workflow|workflow\s+called|workflow\s+named|in\s+\w+\s+workflow|of\s+\w+\s+workflow|active\s+workflows?|inactive\s+workflows?|all\s+workflows?|which\s+workflows?|each\s+workflow)\b/.test(msg)
  ) {
    return "Opening the workflow editor at /workflows. You can create, edit, and run workflows there.";
  }

  if (
    /\bworkflow\b/.test(msg) &&
    /\bcron\b/.test(msg) &&
    /\bboard\b/.test(msg) &&
    /\bwebchat\b/.test(msg) &&
    /\b(?:plan|design|draft)\b/.test(msg)
  ) {
    return [
      "Draft workflow plan: cron-to-board-to-webchat",
      "",
      "1. Trigger: `cron-trigger` on the requested cadence.",
      "2. Task payload: `run-code` or transform node builds a title, timestamp, priority, and acceptance criteria.",
      "3. Board write: `board-task` creates or proposes the task in the selected board.",
      "4. WebChat notice: `send-message` targets WebChat with the task title, board link/id, and next action.",
      "5. Error path: failed board writes go to logs and send a WebChat failure notice.",
      "",
      "Data flow: cron event -> task payload -> board task -> WebChat summary.",
      "",
      "Risks: duplicate tasks on repeated cron runs, missing board target, noisy WebChat notifications, and partial failure after the board write.",
      "",
      "Tests: dry-run the payload builder, run once manually with a test board, verify duplicate protection, verify the WebChat notification, and confirm no workflow is saved or executed until you approve it.",
      "",
      "I have not created, saved, or run this workflow.",
    ].join("\n");
  }

  return null;
}
