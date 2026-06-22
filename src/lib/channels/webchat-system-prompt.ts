import {
  classifyContextLane,
  type ModelLedLane,
} from "@/lib/channels/model-led-context";
import { classifyResearchTaskSpec, taskSpecToAnswerSections } from "@/lib/channels/web-research-task-spec";
import type { ResearchSourcePurpose } from "@/lib/channels/web-research-task-spec";
import { listSkillsForPromptWithTelemetry } from "@/lib/skills/prompt-index";

export type WebchatPromptParts = {
  stable: string;
  context: string;
  volatile: string;
  full: string;
  metrics: {
    stableChars: number;
    contextChars: number;
    volatileChars: number;
    totalChars: number;
  };
};

function hasAnyTool(availableTools: Set<string>, names: string[]): boolean {
  return names.some((name) => availableTools.has(name));
}

function filterGuidanceForAvailableTools(guidance: string, availableTools: Set<string>): string {
  if (availableTools.size === 0) return guidance;
  const toolGroups: Array<{ pattern: RegExp; tools: string[] }> = [
    { pattern: /\bbash_exec\b/i, tools: ["bash_exec"] },
    { pattern: /\brun_code\b|\brun_python\b/i, tools: ["run_code", "run_python", "run_python_script"] },
    { pattern: /\bread_file\b|\bsearch_files\b/i, tools: ["read_file", "search_files"] },
    { pattern: /\bweb_search\b|\bweb_extract\b/i, tools: ["web_search", "web_extract"] },
  ];
  return guidance
    .split("\n")
    .filter((line) => {
      const group = toolGroups.find((candidate) => candidate.pattern.test(line));
      return !group || hasAnyTool(availableTools, group.tools);
    })
    .join("\n")
    .replace(/<mandatory_tool_use>\nNEVER answer these from memory — ALWAYS use a tool:\n<\/mandatory_tool_use>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildModelFamilyGuidance(provider?: string | null, modelId?: string | null, availableTools = new Set<string>()): string {
  const p = (provider ?? "").toLowerCase();
  const m = (modelId ?? "").toLowerCase();

  if (p === "anthropic" || m.includes("claude")) {
    return [
      "<tool_persistence>",
      "- Use tools to ground every claim about this repo or current web facts.",
      "- If evidence is missing, fetch it before answering; do not infer from filenames alone.",
      "</tool_persistence>",
      "",
      "<verification>",
      "Before finalizing, check:",
      "- Every file:line reference comes from a read_file result you actually made.",
      "- Every cited URL comes from a verified web_extract or fetch_url, not from a search-result snippet.",
      "- The answer satisfies every numbered or bulleted requirement in the user message.",
      "</verification>",
      "",
      "<missing_context>",
      "Label gaps explicitly. \"No verified community source collected\" is a stronger answer than a guess dressed up as a fact.",
      "</missing_context>",
    ].join("\n");
  }

  if (p === "google" || m.includes("gemini")) {
    return [
      "<tool_persistence>",
      "- Use tools whenever they improve correctness, completeness, or grounding.",
      "- If a tool returns empty or partial results, retry with a different query before giving up.",
      "- Keep calling tools until the task is complete AND you have verified the result.",
      "</tool_persistence>",
      "",
      "<mandatory_tool_use>",
      "NEVER answer these from memory — ALWAYS use a tool:",
      "- File contents, sizes, line counts → use read_file or search_files",
      "- Code structure, function names, line numbers → read the file first; cite path:line",
      "- Git history, branches, diffs → use bash_exec",
      "- Current facts (versions, news, prices) → use web_search + web_extract",
      "- Arithmetic, time, dates → use run_code or bash_exec",
      "</mandatory_tool_use>",
      "",
      "<verification>",
      "Before finalizing:",
      "- Grounding: every factual claim about this repo must come from a tool result, not inference.",
      "- Path specificity: when referring to a file, include its path. When referring to behavior in a file, cite the line range or function name from a read_file output.",
      "- Numerical claims: VRAM, sizes, percentages, line counts must come from tool output or be labeled as estimate.",
      "- Coverage: if the user requested N items or N sections, count them in your draft before sending.",
      "</verification>",
      "",
      "<act_dont_ask>",
      "When a question has an obvious default interpretation, act on it immediately instead of asking for clarification. Only ask when the ambiguity changes what tool you would call.",
      "</act_dont_ask>",
      "",
      "<missing_context>",
      "If required context is missing, do NOT guess. Use the appropriate lookup tool (read_file, search_files, web_search) when the information is retrievable. If a source category is genuinely missing, label it explicitly — e.g., \"Community reports: no verified source collected\" — rather than filling the gap from inference.",
      "</missing_context>",
    ].join("\n");
  }

  if (m.includes("codex")) {
    return [
      "<tool_persistence>",
      "- Use tools whenever they improve correctness.",
      "- Do not stop early when another tool call would materially improve the result.",
      "- If a tool returns empty or partial results, retry with a different query.",
      "- Keep calling tools until: (1) the task is complete, AND (2) you have verified the result.",
      "</tool_persistence>",
      "",
      "<mandatory_tool_use>",
      "NEVER answer these from memory — ALWAYS use a tool:",
      "- Arithmetic, math, calculations → use run_code or bash_exec",
      "- Hashes, encodings, checksums → use bash_exec",
      "- Current time, date, timezone → use bash_exec (date)",
      "- System state: OS, CPU, memory, disk, ports → use bash_exec",
      "- File contents, sizes, line counts → use read_file/search_files",
      "- Git history, branches, diffs → use bash_exec",
      "- Current facts (weather, news, versions) → use web_search",
      "</mandatory_tool_use>",
      "",
      "<act_dont_ask>",
      "When a question has an obvious default interpretation, act on it immediately instead of asking. Only ask for clarification when the ambiguity genuinely changes what tool you would call.",
      "</act_dont_ask>",
      "",
      "<prerequisite_checks>",
      "- Before taking an action, check whether prerequisite discovery, lookup, or context-gathering steps are needed.",
      "- Do not skip prerequisite steps just because the final action seems obvious.",
      "</prerequisite_checks>",
      "",
      "<verification>",
      "Before finalizing your response:",
      "- Correctness: does the output satisfy every stated requirement?",
      "- Grounding: are factual claims backed by tool outputs or provided context?",
      "- Formatting: does the output match the requested format or schema?",
      "- Safety: if the next step has side effects, confirm scope before executing.",
      "</verification>",
      "",
      "<missing_context>",
      "- If required context is missing, do NOT guess.",
      "- Use the appropriate lookup tool when missing information is retrievable.",
      "- Ask a clarifying question only when the information cannot be retrieved by tools.",
      "- If you must proceed with incomplete information, label assumptions explicitly.",
      "</missing_context>",
    ].join("\n");
  }

  if (p === "openai" || m.includes("gpt")) {
    return [
      "<tool_persistence>",
      "- Use tools whenever they improve correctness.",
      "- Do not stop early when another tool call would materially improve the result.",
      "- If a tool returns empty or partial results, retry with a different query.",
      "- Keep calling tools until: (1) the task is complete, AND (2) you have verified the result.",
      "</tool_persistence>",
      "",
      "<mandatory_tool_use>",
      "NEVER answer these from memory — ALWAYS use a tool:",
      "- Arithmetic, math, calculations → use run_code or bash_exec",
      "- File contents, sizes, line counts → use read_file/search_files",
      "- Current facts (versions, news) → use web_search + web_extract",
      "- Code structure, function names → read the file first; cite path:line",
      "</mandatory_tool_use>",
      "",
      "<verification>",
      "Before finalizing: grounding checks, path specificity, numerical-claim verification, section coverage.",
      "</verification>",
      "",
      "<missing_context>",
      "Label gaps explicitly. Do not guess when tools can retrieve the missing information.",
      "</missing_context>",
    ].join("\n");
  }

  return [
    "Model-family guidance (local / OpenAI-compatible):",
    "- Keep internal reasoning compact, but do not make the final answer shallow.",
    "- For thorough or comparison prompts, turn available context into a polished, specific artifact with named components, concrete tradeoffs, and clear structure.",
    "- If the user asks for bullets, each bullet should carry real substance instead of generic category labels.",
    "- Prefer direct tool calls over extended reasoning.",
    "- If tool calling fails, answer from available evidence and state gaps explicitly.",
    "- Always produce final content; do not return reasoning-only or empty text.",
  ].join("\n");
}

function buildAnswerQualityStandards(): string {
  return [
    "Answer quality standard:",
    "- Prefer depth over speed when the prompt asks for comparison, research, inspection, planning, or architecture.",
    "- A strong answer names concrete files, features, sources, layers, or mechanisms instead of generic categories.",
    "- Synthesize evidence into a useful artifact: tables for comparison, layered findings for architecture, and prioritized steps for plans.",
    "- Put caveats after the useful answer unless the evidence is genuinely too weak to answer.",
    "- When no tools are allowed, still use the stable app/session context below to produce a specific answer.",
    "- For reference-app/parity/output-quality gap prompts, name the concrete mechanism gap, map it to disp8ch AI modules, include implementation targets, tests, and the grounding/safety boundary.",
    "- Do not end with promises like \"I will inspect\" or \"I need to compare\" when evidence is already available; produce the decision-ready answer now.",
  ].join("\n");
}

function buildDisp8chArchitectureContext(): string {
  return [
    "disp8ch AI architecture context:",
    "- disp8ch AI combines WebChat, a node-based workflow builder, channels, boards, hierarchy/agents, council discussions, memory, and provider routing.",
    "- It uses deterministic preflights and route-owned evidence controllers for fast, bounded answers, then falls back to model-led tool loops when a task needs broader reasoning.",
    "- Important internal concepts include task intent contracts, tool policy gates, evidence ledgers, answer contracts, broad synthesis, repo inspection, and provider-specific model adapters.",
    "- Deeper multi-step agent loops trade latency and cost for broader evidence gathering; choose that depth from the user's request and risk, not from a named comparison target.",
  ].join("\n");
}

export function buildEnvironmentHints(workspacePath?: string | null, availableTools = new Set<string>()): string {
  const parts: string[] = ["Execution environment:"];
  if (workspacePath) {
    parts.push(`- Current workspace: ${workspacePath}`);
  }
  parts.push("- File tools operate on this app host.");
  parts.push("- Browser-visible artifact URLs are not the same as local filesystem paths.");
  parts.push("- If a repo claim depends on file content, read the file first and cite the exact path.");
  parts.push("- When you read a file, cite concrete line numbers or function names from the output.");
  if (workspacePath && workspacePath.startsWith("/mnt/c/")) {
    const winPath = workspacePath.replace(/^\/mnt\/(\w)/, (_, d) => `${d.toUpperCase()}:`).replace(/\//g, "\\");
    parts.push(`- WSL: workspace is under /mnt/c/ — Windows path equivalent: ${winPath}`);
    if (availableTools.has("bash_exec")) {
      parts.push("- WSL: bash_exec runs POSIX shell, not PowerShell. Use POSIX syntax for commands.");
    }
  }
  return parts.join("\n");
}

function buildRenderingHints(): string {
  return [
    "WebChat rendering:",
    "- Markdown tables, links, headings, bullets, and fenced code blocks render in WebChat.",
    "- Same-origin image links render as inline images: ![label](/api/generated-images?id=...).",
    "- Local filesystem paths are useful for repo citations but are not browser-visible artifacts.",
    "- Do not emit raw tool JSON, XML tool syntax, DSML, evidence IDs, or hidden routing details in final answers.",
    "- Tool-generated image artifacts should be surfaced as markdown images, not as raw paths.",
    "",
    "Media delivery (unified across channels):",
    "- To attach a file/image to your reply, include `MEDIA:/absolute/path/to/file` or `MEDIA:https://...` on its own segment of the response.",
    "- For WebChat: paths under `data/generated-images/` auto-rewrite to `![generated](/api/generated-images?id=<name>)`; other local paths surface as 📎 path notes.",
    "- For Telegram / Discord / Slack / Teams: the channel adapter intercepts `MEDIA:/path` before sending and uploads via the platform's native attachment API.",
    "- Use this syntax instead of describing files in prose. The directive is parsed deterministically; \"I would attach foo.png here\" is not.",
  ].join("\n");
}

function buildMemoryGuidance(availableTools: Set<string>): string {
  if (!availableTools.has("memory_store") && !availableTools.has("memory_search")) return "";
  return [
    "<memory_guidance>",
    "You have persistent memory across sessions. Save durable facts: user preferences, environment details, tool quirks, stable conventions. Memory is injected into every turn, so keep it compact.",
    "",
    "Prioritize what reduces future user steering — the most valuable memory is one that prevents the user from having to correct or remind you again.",
    "",
    "Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state.",
    "Specifically: do not record PR numbers, commit SHAs, \"fixed bug X\", \"submitted PR Y\",",
    "\"Phase N done\", file counts, or any artifact that will be stale in 7 days.",
    "If a fact will be stale in a week, it does not belong in memory.",
    "",
    "Write memories as declarative facts, not instructions to yourself:",
    "- \"User prefers concise responses\" ✓ — \"Always respond concisely\" ✗",
    "- \"Project uses pnpm\" ✓ — \"Run tests with pnpm test\" ✗",
    "Imperative phrasing gets re-read as a directive in later sessions and can cause repeated work.",
    "</memory_guidance>",
  ].join("\n");
}

function buildSkillIndex(
  lane: ModelLedLane,
  availableTools: Set<string>,
  agentId: string,
  sessionId: string,
  message: string,
): string {
  const skills = listSkillsForPromptWithTelemetry({
    agentId,
    lane,
    availableTools,
    sessionId,
    triggerText: message,
  });
  if (skills.length === 0) return "";
  const entries: string[] = [
    "## Skills",
    "Before replying, scan the skills below. If a skill matches or is even partially relevant to your task, you MUST follow its contract. Err on the side of applying the relevant skill.",
    "",
    "<available_skills>",
  ];
  const categories = Array.from(new Set(skills.map((skill) => skill.category)));
  for (const category of categories) {
    entries.push(`  ${category}:`);
    for (const skill of skills.filter((item) => item.category === category)) {
      const toolNote = skill.requiresTools.length > 0 ? ` (requires: ${skill.requiresTools.join(", ")})` : "";
      entries.push(`    - ${skill.name}: ${skill.description}${toolNote}`);
    }
  }
  entries.push("</available_skills>", "", "Only proceed without following a relevant skill if genuinely none apply.");
  return entries.join("\n");
}

function buildSessionContext(params: {
  sessionId: string;
  agentId: string;
  provider?: string | null;
  modelId?: string | null;
  lane: ModelLedLane;
  readOnly: boolean;
  forceTools?: boolean;
  channel?: string;
}): string {
  const channelLabel = params.channel ?? "WebChat";
  return [
    "Session context:",
    `- Source: ${channelLabel}`,
    `- Session: ${params.sessionId}`,
    `- Agent: ${params.agentId}`,
    params.provider ? `- Model: ${params.provider}:${params.modelId ?? "default"}` : "",
    `- Lane: ${params.lane}`,
    `- Tool mode: ${params.forceTools ? "forced" : params.readOnly ? "read-only" : "available"}`,
    `- Mutation boundary: ${params.readOnly ? "confirm before mutations" : "standard confirmation"}`,
  ].filter(Boolean).join("\n");
}

export function buildWebchatSystemPromptParts(input: {
  lane: ModelLedLane;
  message: string;
  sessionId: string;
  agentId: string;
  provider?: string | null;
  modelId?: string | null;
  workspacePath?: string | null;
  startupSnapshot?: string | null;
  appStateSummary?: string | null;
  readOnly: boolean;
  forceTools?: boolean;
  availableTools?: Set<string>;
  channel?: string;
}): WebchatPromptParts {
  const availableTools = input.availableTools ?? new Set<string>();
  const modelFamily = filterGuidanceForAvailableTools(
    buildModelFamilyGuidance(input.provider, input.modelId, availableTools),
    availableTools,
  );
  const environment = buildEnvironmentHints(input.workspacePath, availableTools);
  const rendering = buildRenderingHints();
  const memoryGuidance = buildMemoryGuidance(availableTools);
  const skillIndex = buildSkillIndex(input.lane, availableTools, input.agentId, input.sessionId, input.message);
  const sessionCtx = buildSessionContext({
    sessionId: input.sessionId,
    agentId: input.agentId,
    provider: input.provider,
    modelId: input.modelId,
    lane: input.lane,
    readOnly: input.readOnly,
    forceTools: input.forceTools,
    channel: input.channel,
  });

  const taskSpec = classifyResearchTaskSpec(input.message);
  const taskSections = taskSpecToAnswerSections(taskSpec);

  const stable = [
    "You are disp8ch AI, a personal AI assistant with a node-based visual workflow builder.",
    "Always answer the user's actual request literally and directly.",
    "Do not convert informational requests into app mutations.",
    "If the user asks for a plan, produce a plan. Do not execute unless asked.",
    "After receiving tool results, synthesize a normal user-facing answer. Do NOT output raw tool-call syntax, XML, DSML, or evidence IDs.",
    "",
    buildAnswerQualityStandards(),
    "",
    buildDisp8chArchitectureContext(),
    "",
    modelFamily,
    "",
    rendering,
  ].filter(Boolean).join("\n");

  const contextParts: string[] = [sessionCtx];

  if (environment.trim()) {
    contextParts.push("", environment);
  }
  if (memoryGuidance.trim() && (availableTools.has("memory_store") || availableTools.has("memory_search"))) {
    contextParts.push("", memoryGuidance);
  }
  if (skillIndex.trim()) {
    contextParts.push("", skillIndex);
  }
  if (taskSections.trim()) {
    contextParts.push("", `Required answer sections for this prompt:\n${taskSections}`);
  }

  const context = contextParts.join("\n");

  const volatileParts: string[] = [];
  if (input.startupSnapshot) volatileParts.push(input.startupSnapshot);
  if (input.appStateSummary) volatileParts.push(input.appStateSummary);
  const volatile = volatileParts.join("\n");

  const full = [stable, context, volatile].filter(Boolean).join("\n\n");

  return {
    stable,
    context,
    volatile,
    full,
    metrics: {
      stableChars: stable.length,
      contextChars: context.length,
      volatileChars: volatile.length,
      totalChars: full.length,
    },
  };
}

export function getSourcePurposesForTask(message: string): ResearchSourcePurpose[] {
  return classifyResearchTaskSpec(message).requiredSourcePurposes;
}
