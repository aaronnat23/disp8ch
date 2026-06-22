import { isNoMutationRequest } from "./contract";

export function handleSessionRequest(message: string, ctx?: {
  modelId?: string;
  provider?: string;
  workspacePath?: string;
  fastMode?: boolean;
  toolMode?: string;
  readOnly?: boolean;
}): string | null {
  const msg = message.toLowerCase().trim();
  if (
    /\bsession\b[\s\S]{0,80}\b(?:mode|settings?)\b/i.test(msg) ||
    /\b(?:tool|fast)\b[\s\S]{0,40}\b(?:mode|settings?)\b/i.test(msg) ||
    /\b(?:what|which|current|active|explain|report)\b[\s\S]{0,80}\b(?:session|tool|fast)\b[\s\S]{0,40}\b(?:mode|settings?)\b/i.test(msg)
  ) {
    const model = ctx?.provider && ctx?.modelId
      ? `${ctx.provider}:${ctx.modelId}`
      : ctx?.modelId
        ? ctx.modelId
        : "resolved per turn by smart routing (no fixed model pinned to this session)";
    const parts = [
      "Current WebChat session settings:",
      `- Model: ${model}`,
      `- Workspace: ${ctx?.workspacePath || "default agent workspace"}`,
      `- Fast mode: ${ctx?.fastMode ? "ON — simple turns routed to the fastest model" : "OFF"}`,
      `- Tool mode: ${ctx?.toolMode || "default"} (restricted = read-only tools only, default = standard, full = all tools)`,
      `- Read-only lane: ${ctx?.readOnly ? "active — inspect/list/summary requests block mutation tools" : "inactive"}`,
      "",
      "Session mode: standard interactive WebChat — multi-turn, token streaming, same-session memory.",
      "Change any of these at /settings, or ask me to switch the model, fast mode, or tool policy.",
    ];
    return parts.join("\n");
  }
  return null;
}
