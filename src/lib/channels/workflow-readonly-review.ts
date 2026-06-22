type PlanLike = {
  taskSummary?: string;
  finalAnswerCriteria?: string[];
  dimensions?: Array<{
    id?: string;
    question?: string;
    doneCriteria?: string;
    suggestedTools?: string[];
  }>;
};

function planText(plan?: PlanLike): string {
  if (!plan) return "";
  return [
    plan.taskSummary ?? "",
    ...(plan.finalAnswerCriteria ?? []),
    ...(plan.dimensions ?? []).map((dimension) => [
      dimension.id ?? "",
      dimension.question ?? "",
      dimension.doneCriteria ?? "",
      ...(dimension.suggestedTools ?? []),
    ].join(" ")),
  ].join("\n");
}

export function isReadOnlyWorkflowInventoryReview(message: string, plan?: PlanLike): boolean {
  const userText = String(message || "").trim();
  if (!userText) return false;
  const asksForNewWorkflowDesign =
    /\b(?:design|draft|plan|outline|create|build|make)\b[\s\S]{0,80}\b(?:workflow|automation)\b/i.test(userText) &&
    !/\b(?:review|audit|assess|consolidate|merge|deduplicate|de[-\s]?duplicate|cleanup|clean\s+up|overlap|redundant|duplicate|existing|current|inventory|list)\b/i.test(userText);
  if (asksForNewWorkflowDesign) return false;
  const text = `${userText}\n${planText(plan)}`;
  const hasWorkflowInventoryScope =
    /\b(?:workflow|workflows|workflow\s+list|workflow\s+setup|automation\s+workflow|automation\s+workflows)\b/i.test(userText) ||
    /\bworkflow_list\b/i.test(text);
  if (!hasWorkflowInventoryScope) return false;

  const hasReviewIntent =
    /\b(?:review|audit|assess|suggest|recommend|consolidate|merge|deduplicate|de[-\s]?duplicate|simplify|cleanup|clean\s+up|overlap|redundant|duplicate|improve)\b/i.test(text);
  if (!hasReviewIntent) return false;

  const hasReadOnlyBoundary =
    /\b(?:without\s+(?:changing|modifying|touching|running|executing|saving)|do\s+not\s+(?:change|modify|touch|run|execute|save|create|update|delete)|don'?t\s+(?:change|modify|touch|run|execute|save|create|update|delete)|no\s+(?:changes?|mutation|writes?|edits?)|read[-\s]?only|suggest(?:ion)?s?\s+only|proposal\s+only)\b/i.test(userText);
  if (!hasReadOnlyBoundary) return false;

  const mutationIntent =
    /\b(?:create|build|save|update|delete|remove|run|execute|trigger|activate|disable|fix|attach|change|modify)\b/i.test(userText);
  const mutationNegated =
    /\b(?:do\s+not|don'?t|without|no)\s+(?:\w+\s+){0,4}(?:create|build|save|update|delete|remove|run|execute|trigger|activate|disable|fix|attach|change|modify)\b/i.test(userText);
  return !mutationIntent || mutationNegated || /\b(?:suggest(?:ion)?s?\s+only|proposal\s+only|read[-\s]?only)\b/i.test(userText);
}

export function formatWorkflowInventoryReviewGuidance(): string {
  return [
    "Read-only workflow inventory review discipline:",
    "- Use `workflow_list` as the authoritative current workflow inventory before suggesting consolidation, cleanup, or overlap reductions.",
    "- Do not create, update, run, delete, activate, disable, or attach anything; the user asked for review/suggestions only.",
    "- For a fast inventory review, synthesize from the pre-collected `workflow_list` evidence first. Do not perform a deep per-workflow inspection unless the user asks to inspect internals.",
    "- If the list output is insufficient to prove node-level duplication, label that limit and suggest a follow-up deep inspection instead of spending the current turn on every workflow.",
    "- Prefer a compact answer: current inventory, likely consolidation candidates, why each candidate matters, and safe next checks.",
    "- If the workflow inventory is empty or unavailable, say that directly instead of inventing workflow names.",
  ].join("\n");
}

type WorkflowInventoryRow = {
  id: string;
  name: string;
  state: string;
  nodeCount: number;
};

function parseWorkflowListOutput(output: string): WorkflowInventoryRow[] {
  const rows: WorkflowInventoryRow[] = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^\[([^\]]+)\]\s+(.+?)\s+\|\s+(active|disabled)\s+\|\s+(\d+)\s+nodes\b/i);
    if (!match?.[1] || !match[2] || !match[3] || !match[4]) continue;
    rows.push({
      id: match[1].trim(),
      name: match[2].trim(),
      state: match[3].trim().toLowerCase(),
      nodeCount: Number(match[4]),
    });
  }
  return rows;
}

function nodeRange(values: number[]): string {
  if (values.length === 0) return "unknown";
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? `${min}` : `${min}-${max}`;
}

function truncateIds(ids: string[]): string {
  if (ids.length <= 6) return ids.map((id) => `\`${id}\``).join(", ");
  return `${ids.slice(0, 6).map((id) => `\`${id}\``).join(", ")} + ${ids.length - 6} more`;
}

export function formatWorkflowInventoryReviewFromListOutput(output: string): string | null {
  const rows = parseWorkflowListOutput(output);
  if (rows.length === 0) {
    if (/no\s+(?:active\s+)?workflows/i.test(output)) {
      return [
        "I have not created, saved, scheduled, run, or changed anything.",
        "No active workflows were found in the live workflow inventory, so there is nothing to consolidate yet.",
        "Next useful step: create one canonical workflow per recurring job, then use clear names and descriptions so future reviews can detect overlap.",
      ].join("\n\n");
    }
    return null;
  }

  const groups = new Map<string, WorkflowInventoryRow[]>();
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const grouped = Array.from(groups.values()).sort((a, b) => b.length - a.length || a[0]!.name.localeCompare(b[0]!.name));
  const duplicates = grouped.filter((group) => group.length > 1);
  const activeCount = rows.filter((row) => row.state === "active").length;
  const disabledCount = rows.length - activeCount;

  const inventoryLines = grouped.map((group) => {
    const name = group[0]?.name ?? "Unnamed workflow";
    const active = group.filter((row) => row.state === "active").length;
    const disabled = group.length - active;
    const state = disabled > 0 ? `${active} active, ${disabled} disabled` : `${active} active`;
    return `| ${name} | ${group.length} | ${state} | ${nodeRange(group.map((row) => row.nodeCount))} | ${truncateIds(group.map((row) => row.id))} |`;
  });

  const recommendations = duplicates.length > 0
    ? duplicates.slice(0, 5).map((group, index) => {
        const name = group[0]?.name ?? "Unnamed workflow";
        const range = nodeRange(group.map((row) => row.nodeCount));
        return `${index + 1}. **${name}**: ${group.length} copies with ${range} nodes. Pick one canonical workflow, rename or archive duplicates only after a deep inspection confirms they are not intentionally parameterized variants.`;
      })
    : [
        "1. No duplicate workflow names were found in the active inventory. Consolidation should focus on descriptions, ownership, and schedule clarity rather than merging workflows by name.",
      ];

  const riskLines = [
    "- This fast review uses `workflow_list` only, so it proves name/state/node-count overlap, not full node-by-node equivalence.",
    "- Before deleting or disabling anything, run a deep inspection on one candidate group and compare triggers, node types, schedules, credentials, and recent execution status.",
    "- Add descriptions to the workflows you keep; blank descriptions make future duplicate detection weaker.",
  ];

  return [
    "I have not created, saved, scheduled, run, or changed anything.",
    `Read-only workflow inventory review from live app state: ${rows.length} workflows (${activeCount} active${disabledCount ? `, ${disabledCount} disabled` : ""}).`,
    "",
    "| Workflow family | Copies | State | Node count | IDs |",
    "|---|---:|---|---:|---|",
    ...inventoryLines,
    "",
    "## Consolidation Candidates",
    ...recommendations,
    "",
    "## Safe Next Steps",
    "1. Choose one canonical workflow per duplicate family.",
    "2. Deep-inspect the duplicate family before changing anything.",
    "3. Rename intentional variants with their purpose, for example `Daily Monitoring - disk`, `Daily Monitoring - RAM`, or `Research Digest - AI news`.",
    "4. Add descriptions to the canonical workflows so the workflow tab stays searchable and easier to maintain.",
    "",
    "## Evidence Limits",
    ...riskLines,
  ].join("\n");
}
