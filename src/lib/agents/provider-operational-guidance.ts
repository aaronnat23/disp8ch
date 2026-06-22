export type ProviderFamily =
  | "gemini"
  | "openai"
  | "anthropic"
  | "local_openai_compatible"
  | "local_llama_cpp"
  | "generic";

export function classifyProviderFamily(provider: string, modelId: string): ProviderFamily {
  const p = provider.toLowerCase();
  const m = modelId.toLowerCase();

  if (p === "google" || m.includes("gemini")) return "gemini";
  if (p === "openai" || m.includes("gpt")) return "openai";
  if (p === "anthropic" || m.includes("claude")) return "anthropic";
  if (p === "ollama" || p === "vllm" || p === "sglang" || p === "lm-studio" || p === "lmstudio") {
    return "local_llama_cpp";
  }
  if (p === "openai-compatible") return "local_openai_compatible";
  return "generic";
}

export function buildProviderOperationalGuidance(
  provider: string,
  modelId: string,
): string {
  const family = classifyProviderFamily(provider, modelId);

  switch (family) {
    case "gemini":
      return [
        "Provider guidance (Gemini):",
        "- Use absolute or workspace-rooted paths for file operations.",
        "- Verify file contents before claiming behavior — do not infer from filenames.",
        "- Use parallel independent tool calls where possible.",
        "- Avoid vague limitation-heavy answers when tools can resolve the gap.",
        "- If a tool returns empty/partial, retry once with a different query before concluding.",
        "- Keep final answers concise but complete — do not pad.",
      ].join("\n");

    case "openai":
      return [
        "Provider guidance (OpenAI):",
        "- Persist with tools until the task is complete or a real blocker is found.",
        "- Use tools for live system facts, file facts, current facts.",
        "- Verify formatting and stated requirements before final answer.",
        "- If evidence is incomplete, state the exact missing reads/sources.",
        "- Do not output hidden reasoning or long preambles.",
      ].join("\n");

    case "anthropic":
      return [
        "Provider guidance (Claude/Anthropic):",
        "- Follow explicit tool and side-effect boundaries.",
        "- Keep final answers user-facing and grounded in tool evidence.",
        "- Cite file paths and source URLs when reporting evidence.",
        "- Do not over-ask when enough context exists.",
        "- If evidence is missing, label it explicitly rather than filling from inference.",
      ].join("\n");

    case "local_openai_compatible":
    case "local_llama_cpp":
      return [
        "Provider guidance (local model):",
        "- Keep instructions compact — avoid long self-dialogue.",
        "- Use tool outputs as the source of truth.",
        "- Prefer shorter tool batches, but keep deep answer structure after evidence is collected.",
        "- Recover from empty/partial tool outputs — state what was tried.",
        "- Do not claim unsupported file behavior from search results alone.",
        "- If the context is large, summarize collected evidence before final synthesis.",
      ].join("\n");

    default:
      return "";
  }
}
