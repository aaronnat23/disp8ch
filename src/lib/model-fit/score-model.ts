import type { FitClass, SpeedClass } from "./estimate-memory";
import type { ModelTask, RegistryModel } from "./model-registry";

/**
 * Rank a candidate model for a given machine + task. Fit dominates (a model you
 * cannot run is useless), then task match, quality, speed, and context. Pure.
 */

const FIT_SCORE: Record<FitClass, number> = {
  full_gpu: 100,
  partial_offload: 70,
  cpu_only: 45,
  not_recommended: 0,
};

const SPEED_BONUS: Record<SpeedClass, number> = {
  fast: 20,
  medium: 12,
  slow: 5,
  very_slow: 0,
};

export function scoreModel(params: {
  model: RegistryModel;
  fit: FitClass;
  speed: SpeedClass;
  task: ModelTask;
  contextTokens: number;
}): number {
  const { model, fit, speed, task, contextTokens } = params;
  if (fit === "not_recommended") return 0;

  let score = FIT_SCORE[fit]; // 0-100, dominant
  // Task match: strong boost when the model is built for the requested task.
  if (task === "general") {
    score += 10;
  } else if (model.tasks.includes(task)) {
    score += 30;
  } else {
    score -= 15;
  }
  score += (model.quality / 100) * 25; // quality, 0-25
  score += SPEED_BONUS[speed];
  // Context adequacy: small reward if the model comfortably covers the request.
  if (model.contextDefault >= contextTokens) score += 8;
  else score -= 10;

  return Math.round(score);
}
