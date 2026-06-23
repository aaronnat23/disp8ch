/**
 * MCP approval guardian (the `model` approval mode).
 *
 * An auxiliary LLM assesses an in-scope MCP tool call and returns one of
 * approve / deny / escalate, with conservative safety rules:
 *
 *   - READ-ONLY FLOOR: a non-read-only (write/unknown) MCP tool is NEVER
 *     auto-approved. The guardian can only escalate it to a human.
 *   - The guardian can only choose among approve/deny/escalate. It cannot
 *     expand the agent's scope (scope is re-checked again before execution),
 *     and every auto-decision is recorded with its reasoning for audit.
 *   - Any uncertainty, error, or missing model escalates to the durable human
 *     approval flow — it never silently approves.
 */

export type GuardianVerdict = "approve" | "deny" | "escalate";

export type GuardianDecision = {
  verdict: GuardianVerdict;
  reasoning: string;
  via: "readonly-floor" | "llm" | "fallback";
};

export type GuardianInput = {
  serverName: string;
  toolName: string;
  argsRedacted: Record<string, unknown>;
  readonly: boolean | null;
  trustTier?: string;
};

/** Injected for tests; returns the raw verdict text. */
export type GuardianLLM = (prompt: { system: string; user: string }) => Promise<string>;

const GUARDIAN_SYSTEM =
  "You are a security reviewer for an AI agent that wants to call an external MCP tool. " +
  "The tool has already passed the agent's scope allowlist. Assess the ACTUAL risk of THIS call. " +
  "Rules: APPROVE only if the call is clearly safe and read-only (lookups, reads, status). " +
  "DENY if it could exfiltrate data, leak secrets, or cause external side effects. " +
  "ESCALATE if you are uncertain or it may modify state. " +
  "Respond with exactly one word: APPROVE, DENY, or ESCALATE.";

export function buildGuardianUserPrompt(input: GuardianInput): string {
  return [
    `Server: ${input.serverName}`,
    `Tool: ${input.toolName}`,
    `Declared read-only: ${input.readonly === true ? "yes" : input.readonly === false ? "no" : "unknown"}`,
    `Trust tier: ${input.trustTier ?? "unknown"}`,
    `Arguments (secrets redacted): ${JSON.stringify(input.argsRedacted)}`,
    "Respond with exactly one word: APPROVE, DENY, or ESCALATE.",
  ].join("\n");
}

export function parseGuardianVerdict(text: string): GuardianVerdict {
  const t = (text || "").trim().toUpperCase();
  if (/^APPROVE\b/.test(t)) return "approve";
  if (/^DENY\b/.test(t)) return "deny";
  // Anything else — including uncertainty, prose, or unexpected output — escalates.
  return "escalate";
}

async function defaultGuardianLLM(prompt: { system: string; user: string }): Promise<string> {
  const { getModelConfig } = await import("@/lib/agents/model-router");
  const { callModel } = await import("@/lib/agents/multi-provider");
  const model = getModelConfig();
  if (!model) throw new Error("No model configured for the MCP guardian.");
  const result = await callModel({
    provider: model.provider,
    modelId: model.modelId,
    apiKey: model.apiKey,
    baseUrl: model.baseUrl || undefined,
    systemPrompt: prompt.system,
    userMessage: prompt.user,
    // Generous budget so "thinking" models (e.g. Gemini 3 Flash) have room to
    // reason before emitting the single-word verdict; small models ignore it.
    maxTokens: 512,
    temperature: 0,
  });
  return result.response ?? "";
}

export async function assessMcpCall(input: GuardianInput, llm?: GuardianLLM): Promise<GuardianDecision> {
  // Read-only floor: only declared read-only tools are eligible for auto-approval.
  if (input.readonly !== true) {
    return {
      verdict: "escalate",
      reasoning: "Tool is not declared read-only; auto-approval is not permitted. Escalating to human approval.",
      via: "readonly-floor",
    };
  }
  const judge = llm ?? defaultGuardianLLM;
  try {
    const raw = await judge({ system: GUARDIAN_SYSTEM, user: buildGuardianUserPrompt(input) });
    return { verdict: parseGuardianVerdict(raw), reasoning: (raw || "").trim().slice(0, 300) || "(no reasoning)", via: "llm" };
  } catch (error) {
    return {
      verdict: "escalate",
      reasoning: `Guardian model unavailable (${String(error instanceof Error ? error.message : error)}); escalating to human approval.`,
      via: "fallback",
    };
  }
}
