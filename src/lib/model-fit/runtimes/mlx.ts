import type { RegistryModel } from "../model-registry";

/** MLX is Apple Silicon only. Returns null elsewhere or when no MLX repo is known. */
export function mlxCommand(model: RegistryModel, platform: string, arch: string): string | null {
  if (platform !== "darwin" || arch !== "arm64") return null;
  if (!model.mlx) return null;
  return `mlx_lm.generate --model ${model.mlx} --max-tokens 512 --prompt "Hello"`;
}
