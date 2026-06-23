import { detectHardwareV2 } from "./hardware";
import { detectRuntimes, fetchLlamaCppRuntimeState } from "./runtimes";
import { discoverLocalModels } from "./local-files";
import { fetchOllamaInventory } from "./ollama";
import type { HardwareProfileV2, LocalModelArtifact, OllamaInstalledModel, RuntimeInventory } from "./types";

export type ModelFitInventory = {
  hardware: HardwareProfileV2;
  runtimes: RuntimeInventory;
  localModels: LocalModelArtifact[];
  ollama: { serviceUp: boolean; models: OllamaInstalledModel[] };
};

export async function getModelFitInventory(options?: { env?: NodeJS.ProcessEnv }): Promise<ModelFitInventory> {
  const hardware = detectHardwareV2();
  const runtimes = detectRuntimes({ env: options?.env });
  const llamaCpp = await fetchLlamaCppRuntimeState({ endpoint: runtimes.llamaCpp.endpoint });
  runtimes.llamaCpp = { ...runtimes.llamaCpp, ...llamaCpp };
  const localModels = discoverLocalModels({ env: options?.env });
  const ollama = await fetchOllamaInventory({ endpoint: runtimes.ollama.endpoint });
  runtimes.ollama.serviceUp = ollama.serviceUp;
  return { hardware, runtimes, localModels, ollama };
}
