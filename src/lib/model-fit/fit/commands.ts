import type { LlamaCppCapabilities } from "../inventory/types";

/**
 * Command generation. ASCII-only output (no smart quotes / mojibake). Paths are
 * double-quoted and stripped of quotes/control characters to prevent shell
 * breakage or injection from filenames/metadata. Flags are emitted only when the
 * detected runtime supports them.
 */

function safeQuotePath(p: string): string {
  // Commands are copied into Windows cmd/PowerShell or POSIX shells. Reject
  // shell metacharacters rather than silently changing a filesystem path.
  if (!p || /[\u0000-\u001f\u007f"`$%&|<>!]/.test(p)) {
    throw new Error("Unsafe path for generated shell command");
  }
  return `"${p}"`;
}

export type LlamaCommandPlan = {
  modelPath: string;
  contextTokens: number;
  parallelSlots: number;
  gpuLayers: number | "auto";
  cpuMoe: boolean;
  keyType: string;
  valueType: string;
  capabilities: LlamaCppCapabilities | null;
  port?: number;
  serverPath?: string;
  cliPath?: string;
};

function commonArgs(plan: LlamaCommandPlan): string[] {
  const caps = plan.capabilities;
  const args = ["-m", safeQuotePath(plan.modelPath), "-c", String(plan.contextTokens), "-np", String(plan.parallelSlots)];
  args.push("-ngl", plan.gpuLayers === "auto" ? "auto" : String(plan.gpuLayers));
  if (!caps || caps.fit) args.push("--fit", "on");
  if (!caps || caps.fitTarget) args.push("--fit-target", "1024");
  if (plan.cpuMoe && (!caps || caps.cpuMoe)) args.push("--cpu-moe");
  if (caps?.cacheTypeK && plan.keyType !== "f16") args.push("--cache-type-k", plan.keyType);
  if (caps?.cacheTypeV && plan.valueType !== "f16") args.push("--cache-type-v", plan.valueType);
  return args;
}

export function buildLlamaServerCommand(plan: LlamaCommandPlan): string {
  const bin = plan.serverPath ? safeQuotePath(plan.serverPath) : "llama-server";
  const args = commonArgs(plan);
  args.push("--host", "127.0.0.1", "--port", String(plan.port ?? 8080));
  return `${bin} ${args.join(" ")}`;
}

export function buildLlamaCliCommand(plan: LlamaCommandPlan): string {
  const bin = plan.cliPath ? safeQuotePath(plan.cliPath) : "llama-cli";
  return `${bin} ${commonArgs(plan).join(" ")} -p "Hello"`;
}

/** Only emit an Ollama command for an exact, validated tag. */
export function buildOllamaCommand(exactTag: string | null, contextTokens: number): { run: string; note?: string } | null {
  if (!exactTag) return null;
  const tag = exactTag.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(tag)) return null;
  const base = { run: `ollama run ${tag}` };
  if (contextTokens > 8192) {
    return { ...base, note: `For ${contextTokens} context, set OLLAMA_CONTEXT_LENGTH=${contextTokens} or use a Modelfile with PARAMETER num_ctx ${contextTokens}; 'ollama run' alone does not guarantee the context.` };
  }
  return base;
}
