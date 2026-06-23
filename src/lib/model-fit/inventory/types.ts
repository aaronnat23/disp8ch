import type { NormalizedModelMetadata } from "../metadata/normalize";

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "unknown";

export type HardwareProfileV2 = {
  platform: string;
  arch: string;
  cpuModel: string;
  logicalCores: number;
  physicalCores: number | null;
  totalRamGB: number;
  freeRamGB: number;
  recommendedHostReserveGB: number;
  gpus: Array<{
    index: number;
    name: string;
    vendor: GpuVendor;
    totalVramGB: number;
    freeVramGB: number | null;
    driverVersion: string | null;
  }>;
  unifiedMemory: boolean;
  detectionNotes: string[];
};

export type LocalModelArtifact = {
  id: string;
  displayName: string;
  path: string;
  sizeBytes: number;
  format: "gguf" | "gguf_split" | "safetensors";
  discoveredFrom: string;
  readable: boolean;
  modifiedAt: string;
  metadata: NormalizedModelMetadata | null;
};

export type LlamaCppCapabilities = {
  ngedAuto: boolean; // -ngl auto
  fit: boolean; // --fit / -fit
  fitTarget: boolean; // --fit-target / -fitt
  cacheTypeK: boolean; // --cache-type-k / -ctk
  cacheTypeV: boolean;
  cpuMoe: boolean; // --cpu-moe
  nCpuMoe: boolean; // --n-cpu-moe
  splitMode: boolean; // --split-mode
  tensorSplit: boolean; // --tensor-split
  specType: boolean; // --spec-type
};

export type RuntimeInventory = {
  llamaCpp: {
    available: boolean;
    binDir: string | null;
    serverPath: string | null;
    cliPath: string | null;
    fitParamsPath: string | null;
    version: string | null;
    capabilities: LlamaCppCapabilities | null;
    endpoint?: string;
    serviceUp?: boolean;
    loadedModels?: string[];
  };
  ollama: {
    available: boolean;
    version: string | null;
    serviceUp: boolean;
    endpoint: string;
  };
  notes: string[];
};

export type OllamaInstalledModel = {
  tag: string;
  sizeBytes: number;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  contextLength: number | null;
  capabilities: string[];
};
