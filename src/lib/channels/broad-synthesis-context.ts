import { buildDisp8chSystemMap } from "@/lib/channels/disp8ch-system-map";

export function shouldUseBroadSynthesisContext(message: string): boolean {
  return /\b(?:design|draft|plan|blueprint|architecture|strategy|proposal|implementation\s+plan|upgrade\s+plan)\b[\s\S]{0,160}\b(?:workflow|app|disp8ch|tools?|nodes?|data\s+flow|trigger|routing|memory|agent|webchat|board|cron|scheduler)\b/i.test(message);
}

export function buildBroadSynthesisContext(message: string): string {
  return [
    "You are answering a broad disp8ch AI app/workflow synthesis request.",
    "Use this context before choosing tools or writing the final answer.",
    "",
    "Core expectations:",
    "- Prefer grounded inspection over generic product advice when the request names this app, workflow behavior, routing, memory, tools, or implementation.",
    "- Explain trigger, nodes/tools, data flow, state/memory usage, confirmation boundaries, error handling, tests, and acceptance criteria when relevant.",
    "- Use real disp8ch AI terms and distinguish workflow node types from app-control tools.",
    "- If evidence is incomplete, state the uncertainty and name the next tool/read needed.",
    "",
    "User request:",
    message,
    "",
    buildDisp8chSystemMap(),
  ].join("\n");
}
