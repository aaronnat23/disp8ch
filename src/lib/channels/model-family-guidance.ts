import type { ModelProvider } from "@/types/model";

export const TOOL_USE_ENFORCEMENT_GUIDANCE = `
# Tool-use enforcement
You MUST use your tools to take action — do not describe what you would do or
plan to do without actually doing it. Examine the evidence and then act. Never
end your turn with a promise of future action — execute it now. Keep working
until the task is actually complete. Before every one of your responses, ask:
"Do I have enough tool-gathered evidence for a conclusive answer?" If the
answer is no, call more tools. Every response should either (a) contain tool
calls that make progress, or (b) deliver a final result to the user. Responses
that only describe intentions without acting are not acceptable.
`.trim();

export const GOOGLE_MODEL_OPERATIONAL_GUIDANCE = `
# Google model operational directives
- Verify first: Use read_file/search_files before making changes.
- Dependency checks: Never assume a library is available.
- Conciseness: Keep explanatory text brief.
- Parallel tool calls: Make multiple independent calls in a single response.
- Keep going: Work autonomously until the task is fully resolved.
`.trim();

export const OPENAI_MODEL_EXECUTION_GUIDANCE = `
# Execution discipline
<tool_persistence>
- Use tools whenever they improve correctness, completeness, or grounding.
- Do not stop early when another tool call would materially improve the result.
- Keep calling tools until: (1) the task is complete, AND (2) you have verified
  the result.
</tool_persistence>

<mandatory_tool_use>
NEVER answer these from memory or mental computation — ALWAYS use a tool:
- Arithmetic, math, calculations → use terminal or execute_code
- Hashes, encodings, checksums → use terminal
- Current time, date, timezone → use terminal
- File contents, directory listings → use read_file or list_files
- Search queries, lookups, research → use web_search or search_files
</mandatory_tool_use>

<verification>
Before finalizing your response:
- Correctness: does the output satisfy every stated requirement?
- Grounding: are factual claims backed by tool outputs or provided context?
- Formatting: does the output match the requested format or schema?
- Safety: confirm scope before executing actions with side effects.
</verification>
`.trim();

export const DEEPSEEK_MODEL_EXECUTION_GUIDANCE = `
# DeepSeek execution directives
- Be thorough: DeepSeek models prefer complete, detailed answers.
- Lead with the answer: put the most important conclusion first.
- Use quantitative tables: prefer tables over prose for comparisons and budgets.
- Name specifics: cite exact model names, version tags, file sizes, and commands.
- Propose workarounds: when the primary path fails, offer concrete alternatives.
- Separate facts from inferences: clearly distinguish verified evidence from
  trained knowledge when both are present.
`.trim();

const PROVIDER_GUIDANCE: Record<string, { blocks: string[] }> = {
  google: {
    blocks: [TOOL_USE_ENFORCEMENT_GUIDANCE, GOOGLE_MODEL_OPERATIONAL_GUIDANCE],
  },
  gemini: {
    blocks: [TOOL_USE_ENFORCEMENT_GUIDANCE, GOOGLE_MODEL_OPERATIONAL_GUIDANCE],
  },
  gemma: {
    blocks: [TOOL_USE_ENFORCEMENT_GUIDANCE, GOOGLE_MODEL_OPERATIONAL_GUIDANCE],
  },
  openai: {
    blocks: [OPENAI_MODEL_EXECUTION_GUIDANCE],
  },
  gpt: {
    blocks: [OPENAI_MODEL_EXECUTION_GUIDANCE],
  },
  codex: {
    blocks: [OPENAI_MODEL_EXECUTION_GUIDANCE],
  },
  deepseek: {
    blocks: [TOOL_USE_ENFORCEMENT_GUIDANCE, DEEPSEEK_MODEL_EXECUTION_GUIDANCE],
  },
  groq: {
    blocks: [TOOL_USE_ENFORCEMENT_GUIDANCE],
  },
  together: {
    blocks: [TOOL_USE_ENFORCEMENT_GUIDANCE],
  },
  mistral: {
    blocks: [TOOL_USE_ENFORCEMENT_GUIDANCE],
  },
  zhipu: {
    blocks: [TOOL_USE_ENFORCEMENT_GUIDANCE],
  },
  qwen: {
    blocks: [TOOL_USE_ENFORCEMENT_GUIDANCE],
  },
  xai: {
    blocks: [TOOL_USE_ENFORCEMENT_GUIDANCE],
  },
  moonshot: {
    blocks: [TOOL_USE_ENFORCEMENT_GUIDANCE],
  },
};

const MODEL_GUIDANCE: Array<{ pattern: RegExp; blocks: string[] }> = [
  { pattern: /deepseek/i, blocks: [TOOL_USE_ENFORCEMENT_GUIDANCE, DEEPSEEK_MODEL_EXECUTION_GUIDANCE] },
  { pattern: /gemini|gemma/i, blocks: [TOOL_USE_ENFORCEMENT_GUIDANCE, GOOGLE_MODEL_OPERATIONAL_GUIDANCE] },
  { pattern: /gpt-|codex|o1|o3|gpt\./i, blocks: [OPENAI_MODEL_EXECUTION_GUIDANCE] },
  { pattern: /claude|sonnet|haiku|opus/i, blocks: [] },
];

export function getModelFamilyGuidance(
  provider: ModelProvider,
  modelId: string,
): string[] {
  const combined = `${provider} ${modelId}`.toLowerCase();

  for (const entry of MODEL_GUIDANCE) {
    if (entry.pattern.test(combined)) {
      return entry.blocks;
    }
  }

  const providerKey = provider.toLowerCase();
  const config = PROVIDER_GUIDANCE[providerKey];
  if (config) return config.blocks;

  return [];
}

export function injectModelFamilyGuidance(
  systemPrompt: string,
  provider: ModelProvider,
  modelId: string,
): string {
  const blocks = getModelFamilyGuidance(provider, modelId);
  if (blocks.length === 0) return systemPrompt;

  const guidanceBlock = blocks.join("\n\n");
  const parts = systemPrompt.split("\n\n");
  const insertionIdx = Math.min(3, parts.length);

  parts.splice(insertionIdx, 0, guidanceBlock);
  return parts.join("\n\n");
}
