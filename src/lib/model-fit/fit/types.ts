export type FitConfidence = "measured" | "runtime_estimated" | "metadata_estimated" | "catalog_estimated";

export type FitClass = "full_gpu" | "hybrid_fast" | "hybrid_workable" | "cpu_heavy" | "memory_risky" | "cannot_load";

export type Range = { min: number; max: number };

export type FitPlan = {
  modelId: string;
  runtime: "llama.cpp" | "ollama" | "mlx";
  fitClass: FitClass;
  contextTokens: number;
  parallelSlots: number;
  weightPlacement: {
    gpuLayers: number | "auto";
    totalLayers: number | null;
    cpuMoe: boolean;
  };
  kvPlacement: {
    offloaded: boolean;
    keyType: string;
    valueType: string;
  };
  memory: {
    gpuByDeviceGB: number[];
    hostRamGB: number;
    gpuReserveGB: number;
    hostReserveGB: number;
  };
  expectedPerformance: {
    generationTokensPerSecond: Range | null;
    confidence: FitConfidence;
  };
  command: string | null;
  warnings: string[];
  evidence: {
    fitSource: "live_benchmark" | "llama_fit_params" | "ollama_show" | "internal_estimator";
    rawFitterOutput?: string;
  };
};
