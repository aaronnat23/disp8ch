import type { RegistryModel } from "../model-registry";

export type LlamaCppCommands = {
  /** Number of layers offloaded to GPU (the rest run on CPU/RAM). */
  gpuLayers: number;
  totalLayers: number;
  /** One-shot CLI. */
  cli: string;
  /** OpenAI-compatible local server (point disp8ch's openai-compatible provider at it). */
  server: string;
  /** Pull/convert hint when a GGUF URL is known. */
  download?: string;
};

function ggufFile(model: RegistryModel): string {
  if (model.ggufUrl) return model.ggufUrl.split("/").pop() || `${model.id}.gguf`;
  return `${model.id}.${model.quant}.gguf`;
}

/**
 * Build llama.cpp commands with an explicit `-ngl` (GPU layer) count. llama.cpp /
 * llama-server expose finer RAM↔VRAM offload control than Ollama's defaults, so
 * we pass the computed layer split directly. `--no-mmap` is omitted so the OS can
 * page weights; tune threads with `-t` for CPU-heavy splits.
 */
export function llamaCppCommands(params: {
  model: RegistryModel;
  contextTokens: number;
  gpuLayers: number;
  totalLayers: number;
  cpuThreads?: number;
}): LlamaCppCommands {
  const { model, contextTokens, gpuLayers, totalLayers } = params;
  const file = ggufFile(model);
  const ngl = `-ngl ${gpuLayers}`;
  const threads = params.cpuThreads && gpuLayers < totalLayers ? ` -t ${params.cpuThreads}` : "";
  return {
    gpuLayers,
    totalLayers,
    cli: `llama-cli -m ${file} -c ${contextTokens} ${ngl}${threads} -p "Hello"`,
    server: `llama-server -m ${file} -c ${contextTokens} ${ngl}${threads} --host 127.0.0.1 --port 8080`,
    download: model.ggufUrl ? `curl -L -o ${file} "${model.ggufUrl}"` : undefined,
  };
}
