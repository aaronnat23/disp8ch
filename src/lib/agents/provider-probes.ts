export type CapabilityProbeResult = {
  provider: string;
  modelId: string;
  probe: string;
  supported: boolean;
  detail: string;
  durationMs: number;
};

export function probeCapability(
  provider: string,
  modelId: string,
  probe: string,
  mockResponses?: Record<string, boolean>,
): CapabilityProbeResult {
  const t0 = Date.now();

  if (mockResponses?.[probe] !== undefined) {
    return {
      provider, modelId, probe,
      supported: mockResponses[probe],
      detail: mockResponses[probe] ? "mock: supported" : "mock: unsupported",
      durationMs: Date.now() - t0,
    };
  }

  const isLocal = /ollama|vllm|sglang|lm.?studio/i.test(provider) ||
    /qwen|llama|mistral|mixtral|gemma|phi/i.test(modelId);

  const isGemini = provider === "google" || /gemini/i.test(modelId);
  const isOpenAI = provider === "openai" || /gpt/i.test(modelId);
  const isAnthropic = provider === "anthropic" || /claude/i.test(modelId);

  const basic: CapabilityProbeResult = {
    provider, modelId, probe,
    supported: true,
    detail: "Heuristic: provider supports basic text completion",
    durationMs: Date.now() - t0,
  };

  switch (probe) {
    case "basic_text":
      return basic;

    case "streaming":
      return { ...basic, supported: true, detail: "Heuristic: provider supports streaming" };

    case "native_tool_calls":
      if (isLocal) return { ...basic, supported: false, detail: "Local models may not support native tool calls reliably" };
      if (isGemini) return { ...basic, supported: true, detail: "Heuristic: Gemini supports native functionCall" };
      if (isOpenAI) return { ...basic, supported: true, detail: "Heuristic: OpenAI supports native tool_calls" };
      if (isAnthropic) return { ...basic, supported: true, detail: "Heuristic: Anthropic supports native tool_use" };
      return { ...basic, supported: false, detail: "Unknown provider — tool call support uncertain" };

    case "tool_result_continuation":
      return { ...basic, supported: !isLocal, detail: isLocal ? "Local models may not interpolate tool results reliably" : "Heuristic: cloud providers support tool result continuation" };

    case "vision_input":
      if (isGemini) return { ...basic, supported: true, detail: "Heuristic: Gemini supports vision input" };
      if (isOpenAI) return { ...basic, supported: true, detail: "Heuristic: OpenAI supports vision input" };
      if (isAnthropic) return { ...basic, supported: true, detail: "Heuristic: Anthropic supports vision input" };
      return { ...basic, supported: false, detail: "Heuristic: provider likely does not support vision" };

    case "reasoning":
      if (/r1|reasoning|think|reason/i.test(modelId)) return { ...basic, supported: true, detail: "Heuristic: model is a reasoning model" };
      return { ...basic, supported: false, detail: "Heuristic: model does not support reasoning mode" };

    case "required_headers":
      if (/qwen.*oauth|dashscope/i.test(provider + modelId)) return { ...basic, supported: true, detail: "Heuristic: Qwen OAuth requires X-DashScope-AuthType header" };
      return { ...basic, supported: false, detail: "Heuristic: provider does not require special headers" };

    case "long_timeout":
      return { ...basic, supported: isLocal, detail: isLocal ? "Heuristic: local model needs longer timeout" : "Heuristic: cloud model uses standard timeout" };

    default:
      return { ...basic, supported: false, detail: "Unknown probe type" };
  }
}
