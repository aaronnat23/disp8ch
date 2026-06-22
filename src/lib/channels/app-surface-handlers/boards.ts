import { isNoMutationRequest } from "./contract";

function extractTaskTitle(msg: string): string {
  const cleaned = msg
    .replace(/\bproposal\s+for\b/gi, "")
    .replace(/\bpropos(e|al)\s+/gi, "")
    .replace(/\b(create|add|make)\s+(a|an|the)\s+/gi, "")
    .replace(/\bcreate\s+task\b/gi, "")
    .replace(/\badd\s+task\b/gi, "")
    .replace(/["\u201C\u201D]/g, "")
    .trim();

  const match = cleaned.match(/(?:called|named|titled|for|task|about)\s+(.+?)(?:\s*$|\s+(?:with|on|in|to))/i);
  if (match?.[1]) {
    return match[1].trim().replace(/\s+/g, " ").slice(0, 80);
  }

  const afterTask = cleaned.match(/(?:task\s+)(.+)/i);
  if (afterTask?.[1]) {
    return afterTask[1].trim().replace(/\s+/g, " ").slice(0, 80);
  }

  return cleaned.slice(0, 80) || "New task";
}

function generateAcceptanceCriteria(msg: string, title: string): string {
  // Honor an explicit count ("with 5 acceptance criteria").
  const requested = msg.match(/\b(\d+)\s+acceptance\s+criteria\b/i) || msg.match(/\bwith\s+(\d+)\s+criteria\b/i);
  const want = requested ? Math.min(8, Math.max(1, parseInt(requested[1], 10))) : 0;

  const pool: string[] = [];
  if (/\bverif|\bvalidate|\btest/i.test(msg)) pool.push(`${title} is verified by a manual or automated check`);
  if (/\bmeasure|\bmetric|\bbenchmark|\bcount/i.test(msg)) pool.push(`The result is measurable and the key numbers are recorded`);
  if (/\bdeploy|\brelease|\bship/i.test(msg)) pool.push(`The change is released and confirmed working in the target environment`);
  if (/\bdocument|\breport|\bsummar/i.test(msg)) pool.push(`Findings are documented where the team can review them`);
  // Generic-but-real defaults so the proposal is never a placeholder.
  pool.push(`The work described by "${title}" is fully completed`);
  pool.push(`The outcome is reviewed and accepted by the requester`);
  pool.push(`No regressions or new errors are introduced`);
  pool.push(`Relevant docs or notes are updated to reflect the change`);
  pool.push(`Edge cases and failure modes are handled or explicitly noted`);

  const dedup = Array.from(new Set(pool));
  const count = want > 0 ? want : Math.max(3, Math.min(dedup.length, 4));
  return dedup.slice(0, count).map((c) => `- ${c}`).join("\n");
}

export function handleBoardRequest(message: string): string | null {
  const msg = message.toLowerCase().trim();

  if (/show.*board|open.*board|view.*board/i.test(msg) && !/create|add|make|propos/i.test(msg)) {
    return "Opening the boards view at /boards. Your tasks are organized by status columns.";
  }

  if (/propos|suggest|add.*task|create.*task|board.task/i.test(msg)) {
    const title = extractTaskTitle(msg);
    const priority = /urgent|critical/i.test(msg) ? "urgent"
      : /high|important/i.test(msg) ? "high"
      : /low|minor/i.test(msg) ? "low"
      : "medium";
    const noMutation = isNoMutationRequest(msg);

    return `Board Task Proposal:
- Title: ${title}
- Priority: ${priority}
- Status: inbox
- Acceptance criteria:
${generateAcceptanceCriteria(msg, title)}${noMutation ? "\n\nRead-only mode: I have NOT saved this task. Reply \"confirm\" to create it, or tell me what to change." : "\n\nI have NOT saved this task. Reply \"confirm\" to create it, or tell me what to change."}`;
  }

  return null;
}
