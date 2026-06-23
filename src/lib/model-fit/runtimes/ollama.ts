import type { RegistryModel } from "../model-registry";

export function ollamaCommands(model: RegistryModel): { pull: string; run: string } | null {
  if (!model.ollama) return null;
  return { pull: `ollama pull ${model.ollama}`, run: `ollama run ${model.ollama}` };
}
