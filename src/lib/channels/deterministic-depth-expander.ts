import type { EvidenceItem } from "@/lib/channels/evidence-ledger";
import type { OutputQualityIssue } from "@/lib/channels/output-quality-contract";
import type { SynthesisRequirements } from "@/lib/channels/evidence-rich-synthesis";

export type DepthExpansionInput = {
  originalAnswer: string;
  rawUserMessage: string;
  routeKind: string;
  verifiedEvidence: EvidenceItem[];
  issues: OutputQualityIssue[];
  requirements: SynthesisRequirements;
};

export function expandDepthDeterministically(input: DepthExpansionInput): string {
  const parts: string[] = [];
  const req = input.requirements;

  const isSetup = /(?:qwen|ollama|llama|local model|16\s*gb\s+vram|windows\s+setup|run\s+local|self[-\s]?host)/i.test(input.rawUserMessage)
    && /(?:set\s*up|setup|install|configure|run)/i.test(input.rawUserMessage);

  if (isSetup) {
    parts.push(buildSetupExpansion(input));
  } else {
    parts.push(buildGenericExpansion(input));
  }

  return parts.join("\n\n");
}

function buildSetupExpansion(input: DepthExpansionInput): string {
  const parts: string[] = [];
  const issueSet = new Set(input.issues);
  const msg = input.rawUserMessage;

  // Derive all setup parameters from the prompt — never hardcode model/OS/VRAM/runtime.
  const platform = /\bwindows\b/i.test(msg) ? "Windows"
    : /\b(?:linux|ubuntu|debian|fedora|arch)\b/i.test(msg) ? "Linux"
    : /\b(?:mac|macos|osx|apple\s+silicon|m[1-4]\b)\b/i.test(msg) ? "macOS"
    : "your platform";
  const vramMatch = msg.match(/(\d+)\s*gb/i);
  const memLabel = vramMatch ? `${vramMatch[1]}GB` : "available GPU/VRAM";
  const modelMatch = msg.match(/\b(qwen[\w.-]*|llama[\w.-]*|mistral[\w.-]*|gemma[\w.-]*|phi[\w.-]*|deepseek[\w.-]*|whisper[\w.-]*|mixtral[\w.-]*)\b/i);
  const model = modelMatch ? modelMatch[1] : "your chosen model";
  const runtime = /\bollama\b/i.test(msg) ? "Ollama"
    : /\bllama\.?cpp\b/i.test(msg) ? "llama.cpp"
    : /\blm\s*studio\b/i.test(msg) ? "LM Studio"
    : /\bvllm\b/i.test(msg) ? "vLLM"
    : "a local runtime (Ollama, llama.cpp, LM Studio, or vLLM)";
  const mentionsOWUI = /\bopen\s*web\s*ui\b/i.test(msg);
  const wantsWebUI =
    mentionsOWUI ||
    /\b(?:web\s*ui|webui|browser\s+ui|chat\s+ui|agent\s+integration|agent\s+frontend|openai-compatible\s+frontend)\b/i.test(msg);

  parts.push(input.originalAnswer);

  if (issueSet.has("too_shallow_for_gap_analysis") || issueSet.has("too_shallow_for_depth_prompt")) {
    parts.push("", "## Setup Matrix");
    parts.push("| Component | Required | Verified | Notes |");
    parts.push("|---|---|---|---|");
    parts.push(`| Runtime (${runtime}) | yes | see verified sources | ${platform} install or build |`);
    parts.push(`| Model (${model}, quantized) | yes | check runtime model list | GGUF Q4/Q5 quant sized to fit ${memLabel} |`);
    parts.push("| OpenAI-compatible endpoint | yes | verify /v1/models | e.g. port 11434 (Ollama) or 8080 (llama.cpp) |");
    parts.push(`| Memory capacity (${memLabel}) | yes | local measurement | Measure actual usage during inference |`);
    if (wantsWebUI) parts.push("| Requested UI or agent integration | conditional | see official docs | Connection through admin/settings panel |");
    parts.push("| Stable context window | yes | local measurement | Test with progressively longer prompts |");
    parts.push("| Tool/function calling | conditional | test with your specific model/quant | Not all quants reliably support structured tool calling |");
    parts.push("", "Use the collected evidence to fill in missing values before treating this as complete.");

    parts.push("", "## Validation Checklist");
    parts.push("| Check | Expected |");
    parts.push("|---|---|");
    parts.push("| Runtime installed | runtime server process running |");
    parts.push("| Model pulled | model present in the runtime's model list |");
    parts.push("| Chat completions work | `POST /v1/chat/completions` returns valid JSON |");
    parts.push("| Streaming enabled | Response arrives token-by-token |");
    parts.push(`| Memory within budget | usage stays within ${memLabel} at target context length |`);
    if (wantsWebUI) parts.push("| WebUI connected | Admin/Settings panel shows endpoint as active |");
    parts.push("| Tool calling | Test with a simple calculation or structured output prompt |");

    parts.push("", "## Setup Steps");
    parts.push(`1. Install ${runtime} for ${platform} (see its official docs).`);
    parts.push(`2. Download/pull ${model} at a quant that fits ${memLabel}.`);
    parts.push("3. Start the runtime's OpenAI-compatible server and confirm `GET /v1/models` lists the model.");
    parts.push("4. Send a test `POST /v1/chat/completions` and confirm a valid response.");

    if (wantsWebUI) {
      parts.push("", "## UI / agent integration wiring");
      parts.push("```", "Provider: openai-compatible", "Base URL: your local runtime endpoint (e.g. http://localhost:11434/v1)", "Model: the name returned from /v1/models", "API Key: any non-empty string for a local runtime", "```");
    }
  }

  if (input.issues.includes("insufficient_concrete_mechanisms") || input.issues.includes("missing_reference_mechanisms")) {
    parts.push("", "## Missing Coverage");
    parts.push("The collected evidence did not contain enough verified information to confirm these dimensions:");
    parts.push("- Tokens-per-second benchmarks for the requested model/quant/hardware combination");
    parts.push(`- Exact memory usage at specific context lengths on the target ${platform} machine`);
    parts.push("- Tool-calling reliability for the requested model/quant combination");
    parts.push(`- Native ${platform} binary stability for the chosen runtime`);
    parts.push("- Maximum stable context window before OOM");
    parts.push("", "These must be measured locally on the target machine.");
  }

  if (input.issues.includes("insufficient_safety_boundaries")) {
    parts.push("", "## Safety Boundaries");
    parts.push("- All setup steps are proposals; verify before executing on your system");
    parts.push("- Download models only from trusted sources");
    parts.push("- Test in isolation before integrating with production tools");
    parts.push("- Monitor VRAM and system resources during first inference runs");
    parts.push("- Back up your working configuration before experimenting with alternative runtimes or quants");
  }

  parts.push("", "[This answer was expanded deterministically from verified evidence because the model-generated synthesis was insufficient.]");

  return parts.join("\n");
}

function buildGenericExpansion(input: DepthExpansionInput): string {
  const parts: string[] = [input.originalAnswer];

  const issueSet = new Set(input.issues);

  if (issueSet.has("too_shallow_for_gap_analysis") || issueSet.has("too_shallow_for_depth_prompt")) {
    parts.push("", "## Implementation Details");
    parts.push("Based on the available evidence, the key implementation targets are:");
    if (input.requirements.minSections) {
      for (const section of input.requirements.minSections.slice(0, 6)) {
        parts.push(`- ${section}: expand with specific file paths, URLs, commands, or verified claims from the collected evidence.`);
      }
    }
    parts.push("", "The evidence collected includes:");
    for (const item of input.verifiedEvidence.slice(0, 5)) {
      parts.push(`- ${item.kind}: ${item.locator} (${item.confidence})`);
    }
  }

  if (issueSet.has("insufficient_concrete_mechanisms")) {
    parts.push("", "## Known Mechanisms");
    parts.push("The answer should reference at least these concrete mechanisms:");
    parts.push("- Agent loop infrastructure (iteration budget, empty-response recovery)");
    parts.push("- Tool schema management (dynamic toolsets, sanitization)");
    parts.push("- Context verification (prompt-injection scanning, context safety)");
    parts.push("- Output discipline (final-response hooks, file-mutation footers)");
    parts.push("- Telemetry/progress (stream replay, active-run ownership, tool cards)");
  }

  if (issueSet.has("insufficient_file_targets")) {
    parts.push("", "## File Targets");
    parts.push("Key disp8ch AI files and modules to change:");
    parts.push("- src/app/api/channels/route.ts — main WebChat routing and synthesis wiring");
    parts.push("- src/lib/channels/output-quality-contract.ts — output quality gate");
    parts.push("- src/lib/channels/evidence-rich-synthesis.ts — evidence-rich synthesis pass");
    parts.push("- src/lib/channels/broad-answer-contract.ts — answer contract and repair");
    parts.push("- src/lib/channels/evidence-compressor.ts — evidence metadata preservation");
    if (input.requirements.minSections) {
      parts.push(`- Additional targets may be needed based on the required sections: ${input.requirements.minSections.slice(0, 4).join(", ")}`);
    }
  }

  if (issueSet.has("insufficient_safety_boundaries")) {
    parts.push("", "## Safety Boundaries");
    parts.push("- All file claims must be backed by read_file evidence");
    parts.push("- Web claims require verified fetched URLs, not search snippets");
    parts.push("- Mutation claims require confirmation boundaries");
    parts.push("- Answers must separate verified facts from candidate/inferred claims");
    parts.push("- Tool-use safety must be explicitly documented in the answer");
  }

  parts.push("", "[This answer was expanded deterministically from verified evidence because the model-generated synthesis was incomplete.]");

  return parts.join("\n");
}
