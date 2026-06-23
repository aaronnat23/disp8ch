"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Activity, Loader2, Plus, Trash2 } from "lucide-react";
import { PROVIDERS } from "@/types/model";
import { checkModelToolSupport } from "@/lib/agents/model-capabilities";
import {
  getProviderDiscoveryMode,
  getProviderWizardMeta,
  isProviderLocallyHosted,
  providerRequiresApiKey,
  providerSupportsBaseUrlInput,
  providerSupportsCredentialInput,
} from "@/lib/agents/provider-plugins";
import { getProviderDefaultBaseUrl } from "@/lib/agents/provider-base-url";
import { getProviderAuthConfig } from "@/lib/agents/provider-auth-registry";

const MODEL_SETTINGS_UI_STATE_KEY = "disp8ch:model-settings-ui-state";

type ModelRow = {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  priority: number;
  isActive: boolean;
  fastMode: boolean;
  baseUrl?: string | null;
};

type HealthCheck = {
  name: string;
  status: "ok" | "warn" | "fail";
  details: string;
};

type ModelFitTask = "coding" | "chat" | "reasoning" | "vision" | "general";

type RankedModel = {
  source: "local_gguf" | "ollama_installed" | "catalog";
  modelId: string;
  displayName: string;
  totalParamsB: number | null;
  activeParamsB: number | null;
  isMoe: boolean;
  quant: string | null;
  fitClass: string;
  confidence: string;
  fitSource: string;
  gpuGB: number;
  hostGB: number;
  path: string | null;
  ollamaTag: string | null;
  commands: { llamaServer?: string; llamaCli?: string; ollama?: { run: string; note?: string } };
  reasons: string[];
  warnings: string[];
  performance: {
    generationTokensPerSecond: number | null;
    timeToFirstTokenMs: number | null;
    measuredAt: string | null;
  };
};

type ModelFitResult = {
  task: ModelFitTask;
  contextTokens: number;
  catalog: { source: string; state: string; generatedAt: string };
  hardware: {
    cpuModel: string;
    totalRamGB: number;
    gpus: Array<{ name: string; totalVramGB: number; freeVramGB: number | null }>;
  };
  runtimes: { llamaCpp: { available: boolean; version: string | null; fitParamsPath: string | null }; ollama: { available: boolean } };
  installed: RankedModel[];
  lanes: { quality: RankedModel | null; balanced: RankedModel | null; fast: RankedModel | null };
};

type ModelAdvisory = {
  id: string;
  modelRowId: string;
  callable: boolean;
  latencyMs: number | null;
  status: "ready" | "dismissed";
  summary: string;
  suggestions: Array<{
    kind: string;
    title: string;
    tradeoff: string;
    confidence: string;
    downloadSizeBytes: number | null;
  }>;
};

type BenchmarkJob = {
  id: string;
  candidateId: string;
  status: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled";
  metrics: {
    loadMs: number | null;
    timeToFirstTokenMs: number | null;
    generationTokensPerSecond: number | null;
    peakVramGB: number | null;
    peakHostRamGB: number | null;
  } | null;
  error: string | null;
};

const LOCAL_MODEL_TASKS: Array<{ value: ModelFitTask; label: string }> = [
  { value: "general", label: "Everyday chat" },
  { value: "coding", label: "Coding" },
  { value: "reasoning", label: "Reasoning" },
  { value: "vision", label: "Vision" },
  { value: "chat", label: "Fast chat" },
];

const LOCAL_MODEL_CONTEXTS = [8192, 16384, 32768, 65536, 131072];

function formatFit(fit: string): string {
  return ({
    full_gpu: "Full GPU",
    hybrid_fast: "Hybrid (fast)",
    hybrid_workable: "Hybrid (workable)",
    cpu_heavy: "CPU-heavy",
    memory_risky: "Memory-risky",
    cannot_load: "Cannot load",
  } as Record<string, string>)[fit] ?? fit;
}

function formatConfidence(c: string): string {
  return ({
    measured: "Measured on this PC",
    runtime_estimated: "Estimated by llama.cpp",
    metadata_estimated: "Estimated from model metadata",
    catalog_estimated: "Catalog-only estimate",
  } as Record<string, string>)[c] ?? c;
}

function bestCommand(m: RankedModel): string | null {
  return m.commands.llamaServer ?? m.commands.ollama?.run ?? null;
}

export function ModelSettings() {
  const [models, setModels] = useState<ModelRow[]>([]);
  const [healthChecks, setHealthChecks] = useState<HealthCheck[]>([]);
  const [newModelProvider, setNewModelProvider] = useState("anthropic");
  const [newModelApiKey, setNewModelApiKey] = useState("");
  const [newModelBaseUrl, setNewModelBaseUrl] = useState("");
  const [newModelId, setNewModelId] = useState("");
  const [newModelFastMode, setNewModelFastMode] = useState(false);
  const [smartRoutingEnabled, setSmartRoutingEnabled] = useState(false);
  const [smartRoutingMaxChars, setSmartRoutingMaxChars] = useState(160);
  const [smartRoutingMaxWords, setSmartRoutingMaxWords] = useState(28);
  const [anthropicPromptCachingEnabled, setAnthropicPromptCachingEnabled] = useState(true);
  const [savingRuntimeConfig, setSavingRuntimeConfig] = useState(false);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);
  const [uiPreferencesLoaded, setUiPreferencesLoaded] = useState(false);
  const [modelFitTask, setModelFitTask] = useState<ModelFitTask>("general");
  const [modelFitContext, setModelFitContext] = useState(8192);
  const [modelFitPreference, setModelFitPreference] = useState<"quality" | "balanced" | "speed">("balanced");
  const [modelFit, setModelFit] = useState<ModelFitResult | null>(null);
  const [modelFitLoading, setModelFitLoading] = useState(false);
  const [modelFitError, setModelFitError] = useState("");
  const [advisories, setAdvisories] = useState<ModelAdvisory[]>([]);
  const [testingModelId, setTestingModelId] = useState("");
  const [benchmarkJob, setBenchmarkJob] = useState<BenchmarkJob | null>(null);

  const selectedProviderInfo = PROVIDERS.find((provider) => provider.id === newModelProvider);
  const selectedAuthConfig = getProviderAuthConfig(newModelProvider);
  const providerWizard = getProviderWizardMeta(newModelProvider);
  const providerNeedsApiKey = providerRequiresApiKey(newModelProvider);
  const providerUsesBaseUrl = providerSupportsBaseUrlInput(newModelProvider);
  const providerUsesCredentialInput = providerSupportsCredentialInput(newModelProvider);
  const providerDiscoveryMode = getProviderDiscoveryMode(newModelProvider);
  const suggestedModels = selectedProviderInfo?.models.filter((model) => model.supportsTools) ?? [];

  const selectNewModelProvider = (provider: string, modelId = "") => {
    setNewModelProvider(provider);
    setNewModelApiKey("");
    setNewModelBaseUrl(getProviderDefaultBaseUrl(provider) ?? "");
    setNewModelId(modelId);
    setNewModelFastMode(false);
  };

  const fetchModels = () => {
    fetch("/api/models")
      .then((response) => response.json())
      .then((data) => {
        if (data.success) setModels(data.data);
      })
      .catch(() => {});
  };

  const fetchHealth = () => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((json) => {
        if (json.success && Array.isArray(json.data?.checks)) setHealthChecks(json.data.checks as HealthCheck[]);
      })
      .catch(() => setHealthChecks([]));
  };

  const fetchRuntimeConfig = () => {
    fetch("/api/config")
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || !data.data) return;
        const config = data.data as Record<string, unknown>;
        if (typeof config.smart_model_routing_enabled === "number") {
          setSmartRoutingEnabled(config.smart_model_routing_enabled === 1);
        }
        if (typeof config.smart_model_routing_max_chars === "number") {
          setSmartRoutingMaxChars(config.smart_model_routing_max_chars);
        }
        if (typeof config.smart_model_routing_max_words === "number") {
          setSmartRoutingMaxWords(config.smart_model_routing_max_words);
        }
        if (typeof config.anthropic_prompt_caching_enabled === "number") {
          setAnthropicPromptCachingEnabled(config.anthropic_prompt_caching_enabled === 1);
        }
      })
      .catch(() => {});
  };

  const fetchAdvisories = () => {
    fetch("/api/model-fit/advisory")
      .then((response) => response.json())
      .then((payload) => {
        if (payload.success && Array.isArray(payload.data)) setAdvisories(payload.data as ModelAdvisory[]);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetchModels();
    fetchHealth();
    fetchRuntimeConfig();
    fetchAdvisories();
    try {
      const raw = window.localStorage.getItem(MODEL_SETTINGS_UI_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
        setHideGettingStarted(Boolean(parsed.hideGettingStarted));
      }
    } catch {
      // Keep first-run guidance visible when preferences cannot be read.
    } finally {
      setUiPreferencesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!uiPreferencesLoaded) return;
    try {
      window.localStorage.setItem(
        MODEL_SETTINGS_UI_STATE_KEY,
        JSON.stringify({ hideGettingStarted }),
      );
    } catch {
      // Preferences are optional; model configuration still works without storage.
    }
  }, [hideGettingStarted, uiPreferencesLoaded]);

  const addModel = async () => {
    const providerAuthType = selectedAuthConfig?.authType ?? "api_key";
    if (providerNeedsApiKey && providerAuthType === "api_key" && !newModelApiKey.trim()) return;
    const modelId = newModelId.trim();
    const payload: Record<string, unknown> = {
      provider: newModelProvider,
      fastMode: newModelFastMode,
    };
    if (providerUsesCredentialInput && newModelApiKey.trim()) {
      payload.apiKey = newModelApiKey.trim();
    }
    if (providerUsesBaseUrl && newModelBaseUrl.trim()) {
      payload.baseUrl = newModelBaseUrl.trim();
    }
    if (modelId) {
      payload.modelId = modelId;
    }
    await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setNewModelApiKey("");
    setNewModelId("");
    setNewModelFastMode(false);
    fetchModels();
  };

  const gridClass = providerUsesBaseUrl
    ? providerUsesCredentialInput
      ? "grid gap-2 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1.1fr)_minmax(0,1fr)_auto]"
      : "grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)_auto]"
    : providerUsesCredentialInput
      ? "grid gap-2 md:grid-cols-4"
      : "grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]";

  const modelHealthCheck = healthChecks.find((check) => check.name === "models");

  const getModelWarnings = (model: ModelRow) => {
    const warnings: Array<{ label: string; detail: string; tone: "warn" | "fail" | "info" }> = [];
    const providerInfo = PROVIDERS.find((provider) => provider.id === model.provider);
    if (!providerInfo) {
      warnings.push({
        label: "provider mismatch",
        detail: "Provider is not in the local provider catalog.",
        tone: "warn",
      });
    } else if (!providerInfo.models.some((entry) => entry.id === model.modelId)) {
      const support = checkModelToolSupport(model.provider, model.modelId);
      warnings.push({
        label: support.status === "unsupported" ? "tools unsupported" : "model mismatch",
        detail: support.reason,
        tone: support.status === "unsupported" ? "fail" : "warn",
      });
    } else {
      const support = checkModelToolSupport(model.provider, model.modelId);
      if (support.status !== "supported") {
        warnings.push({
          label: support.status === "unsupported" ? "tools unsupported" : "tools unknown",
          detail: support.reason,
          tone: support.status === "unsupported" ? "fail" : "warn",
        });
      }
    }
    if (!model.isActive) {
      warnings.push({
        label: "inactive",
        detail: "This row is not active for routing.",
        tone: "info",
      });
    }
    if (modelHealthCheck?.status === "fail") {
      warnings.push({
        label: "health fail",
        detail: "Model health is failing; calls may be unavailable until credentials or provider status recover.",
        tone: "fail",
      });
    } else if (modelHealthCheck?.status === "warn") {
      warnings.push({
        label: "cooldown risk",
        detail: "Model health has warnings; rate limits, cooldowns, or missing fallback credentials may affect this row.",
        tone: "warn",
      });
    }
    return warnings;
  };

  const getModelRemediation = (warning: { label: string; detail: string; tone: "warn" | "fail" | "info" }) => {
    if (warning.label === "provider mismatch") return "Re-add this model with a provider from the current catalog.";
    if (warning.label === "model mismatch") return "Refresh provider discovery or replace the row with a current model ID.";
    if (warning.label === "tools unsupported") return "Use a tool-capable model for agents and workflow tool calls.";
    if (warning.label === "tools unknown") return "Run a probe-tools check before relying on this row for tool use.";
    if (warning.label === "inactive") return "Keep inactive rows only as references or delete them.";
    if (warning.label === "health fail") return "Check credentials, base URL, local runtime availability, and fallback rows.";
    if (warning.label === "cooldown risk") return "Add a fallback model or wait for provider/rate-limit recovery.";
    return warning.detail;
  };

  const saveRuntimeConfig = async () => {
    setSavingRuntimeConfig(true);
    try {
      await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          smart_model_routing_enabled: smartRoutingEnabled ? 1 : 0,
          smart_model_routing_max_chars: smartRoutingMaxChars,
          smart_model_routing_max_words: smartRoutingMaxWords,
          anthropic_prompt_caching_enabled: anthropicPromptCachingEnabled ? 1 : 0,
        }),
      });
      fetchRuntimeConfig();
    } finally {
      setSavingRuntimeConfig(false);
    }
  };

  const findLocalModels = async () => {
    setModelFitLoading(true);
    setModelFitError("");
    try {
      const response = await fetch(`/api/model-fit/recommendations?task=${encodeURIComponent(modelFitTask)}&context=${modelFitContext}&preference=${modelFitPreference}`);
      const payload = await response.json() as { success?: boolean; data?: ModelFitResult; error?: string };
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.error || "Could not inspect this machine.");
      }
      setModelFit(payload.data);
    } catch (error) {
      setModelFit(null);
      setModelFitError(error instanceof Error ? error.message : "Could not inspect this machine.");
    } finally {
      setModelFitLoading(false);
    }
  };

  const fillProviderForm = (m: RankedModel) => {
    if (m.ollamaTag) {
      selectNewModelProvider("ollama", m.ollamaTag);
    } else if (m.path) {
      // Local GGUF: point the openai-compatible provider at a llama-server endpoint.
      selectNewModelProvider("openai-compatible", m.displayName);
      setNewModelBaseUrl("http://127.0.0.1:8080/v1");
    }
  };

  const testConfiguredModel = async (model: ModelRow) => {
    setTestingModelId(model.id);
    try {
      const response = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelRowId: model.id }),
      });
      if (response.ok) {
        window.setTimeout(fetchAdvisories, 750);
      }
    } finally {
      setTestingModelId("");
    }
  };

  const startModelBenchmark = async (model: RankedModel) => {
    if (!window.confirm("This benchmark may temporarily use substantial RAM and VRAM. Continue?")) return;
    const response = await fetch("/api/model-fit/benchmark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidateId: model.modelId,
        contextTokens: modelFitContext,
        confirmed: true,
      }),
    });
    const payload = await response.json() as { success?: boolean; data?: BenchmarkJob; error?: string };
    if (!response.ok || !payload.success || !payload.data) {
      setModelFitError(payload.error || "Could not start benchmark.");
      return;
    }
    setBenchmarkJob(payload.data);
  };

  useEffect(() => {
    if (!benchmarkJob || ["completed", "failed", "cancelled"].includes(benchmarkJob.status)) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/model-fit/benchmark?id=${encodeURIComponent(benchmarkJob.id)}`);
      const payload = await response.json() as { success?: boolean; data?: BenchmarkJob };
      if (payload.success && payload.data) {
        setBenchmarkJob(payload.data);
        if (payload.data.status === "completed") void findLocalModels();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [benchmarkJob?.id, benchmarkJob?.status]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model Configuration</CardTitle>
        <CardDescription>Configure AI model providers and API keys</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hideGettingStarted ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2">
            <p className="text-sm text-muted-foreground">Add an online provider or a local model endpoint.</p>
            <Button type="button" size="sm" variant="ghost" onClick={() => setHideGettingStarted(false)}>
              Show Tips
            </Button>
          </div>
        ) : (
          <div className="rounded-md border bg-muted/20 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Getting Started
                </div>
                <p className="mt-2 text-sm font-medium">Connect the model you want your agents to use.</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Choose a provider, enter its API key or local server URL, and select Add. Model ID is optional;
                  leaving it blank uses the provider default.
                </p>
              </div>
              <Button type="button" size="sm" variant="ghost" onClick={() => setHideGettingStarted(true)}>
                Hide Tips
              </Button>
            </div>
          </div>
        )}

        <div className="rounded-md border bg-muted/10 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-sm font-medium">Find a local model for this PC</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Checks RAM and GPU memory, then suggests models and setup commands. This does not install or activate anything.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Local model task"
                value={modelFitTask}
                onChange={(event) => setModelFitTask(event.target.value as ModelFitTask)}
                className="rounded-md border bg-background px-2 py-1.5 text-xs"
              >
                {LOCAL_MODEL_TASKS.map((task) => (
                  <option key={task.value} value={task.value}>{task.label}</option>
                ))}
              </select>
              <select
                aria-label="Context length"
                value={modelFitContext}
                onChange={(event) => setModelFitContext(Number(event.target.value))}
                className="rounded-md border bg-background px-2 py-1.5 text-xs"
              >
                {LOCAL_MODEL_CONTEXTS.map((ctx) => (
                  <option key={ctx} value={ctx}>{ctx / 1024}K ctx</option>
                ))}
              </select>
              <select
                aria-label="Preference"
                value={modelFitPreference}
                onChange={(event) => setModelFitPreference(event.target.value as "quality" | "balanced" | "speed")}
                className="rounded-md border bg-background px-2 py-1.5 text-xs"
              >
                <option value="quality">Quality</option>
                <option value="balanced">Balanced</option>
                <option value="speed">Speed</option>
              </select>
              <Button type="button" size="sm" variant="outline" onClick={findLocalModels} disabled={modelFitLoading}>
                {modelFitLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                Check this PC
              </Button>
            </div>
          </div>

          {modelFitError ? <p className="mt-3 text-xs text-destructive">{modelFitError}</p> : null}

          {modelFit ? (
            <div className="mt-4 space-y-4">
              <p className="text-xs text-muted-foreground">
                {modelFit.hardware.cpuModel} with {modelFit.hardware.totalRamGB} GB RAM
                {modelFit.hardware.gpus.length > 0 ? `, ${modelFit.hardware.gpus.map((gpu) => `${gpu.name} ${gpu.totalVramGB} GB`).join(", ")}` : ""}.{" "}
                {modelFit.runtimes.llamaCpp.available ? `llama.cpp ${modelFit.runtimes.llamaCpp.fitParamsPath ? "(native fit)" : ""} detected. ` : ""}
                Catalog bundled with this app ({modelFit.catalog.state}).
              </p>

              {modelFit.installed.length > 0 ? (
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Models already on this PC</div>
                  <div className="space-y-1">
                    {modelFit.installed.slice(0, 4).map((m) => (
                      <div key={m.modelId} className="flex items-center justify-between gap-2 rounded border bg-background px-2 py-1.5 text-[11px]">
                        <span className="truncate font-mono">{m.displayName}</span>
                        <span className="flex shrink-0 items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">{formatFit(m.fitClass)}</Badge>
                          <span className="text-muted-foreground">{m.source === "local_gguf" ? "local file" : "Ollama"}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="grid gap-2 lg:grid-cols-3">
                {([
                  { key: "quality", label: "Best quality", m: modelFit.lanes.quality },
                  { key: "balanced", label: "Balanced", m: modelFit.lanes.balanced },
                  { key: "fast", label: "Fastest useful", m: modelFit.lanes.fast },
                ] as const)
                  .slice()
                  .sort((a, b) => {
                    const preferred = modelFitPreference === "speed" ? "fast" : modelFitPreference;
                    if (a.key === preferred) return -1;
                    if (b.key === preferred) return 1;
                    return 0;
                  })
                  .map(({ key, label, m }) => (
                  <div key={key} data-model-fit-lane={key} className="rounded border bg-background p-3 text-xs">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
                    {m ? (
                      <>
                        <div className="mt-1 flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-medium text-sm">{m.displayName}</div>
                            <div className="text-muted-foreground">
                              {m.totalParamsB ? `${m.totalParamsB}B${m.isMoe && m.activeParamsB ? ` (A${m.activeParamsB}B MoE)` : ""}` : ""} {m.quant ?? ""}
                            </div>
                          </div>
                          <Badge variant={m.fitClass === "full_gpu" ? "default" : "secondary"}>{formatFit(m.fitClass)}</Badge>
                        </div>
                        <p className="mt-1 text-[10px] text-muted-foreground">{formatConfidence(m.confidence)}{m.hostGB > 0 ? ` · ${m.gpuGB} GB VRAM + ${m.hostGB} GB RAM` : ""}</p>
                        {m.performance.generationTokensPerSecond !== null ? (
                          <p className="mt-1 text-[10px] text-muted-foreground">
                            Measured {m.performance.generationTokensPerSecond} tok/s
                            {m.performance.timeToFirstTokenMs !== null ? ` · ${m.performance.timeToFirstTokenMs} ms first token` : ""}
                          </p>
                        ) : null}
                        {m.warnings[0] ? <p className="mt-1 text-amber-600 dark:text-amber-400">{m.warnings[0]}</p> : null}
                        {bestCommand(m) ? (
                          <div className="mt-2 max-h-24 overflow-auto rounded bg-muted px-2 py-1.5 font-mono text-[10px] text-muted-foreground">{bestCommand(m)}</div>
                        ) : null}
                        <Button type="button" size="sm" variant="outline" className="mt-2 w-full" onClick={() => fillProviderForm(m)}>
                          Fill provider form
                        </Button>
                        {m.source !== "catalog" ? (
                          <Button type="button" size="sm" variant="ghost" className="mt-1 w-full" onClick={() => startModelBenchmark(m)}>
                            <Activity className="mr-1 h-3.5 w-3.5" />
                            Benchmark on this PC
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <p className="mt-2 text-muted-foreground">No model fits this lane.</p>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Estimates: {formatConfidence("runtime_estimated")} / {formatConfidence("metadata_estimated")} / {formatConfidence("catalog_estimated")}.
                Choosing a result only fills the provider form below — disp8ch never downloads, starts, or activates a model. Run the launch command yourself first.
              </p>
              {benchmarkJob ? (
                <div className="rounded border bg-background px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">Calibration benchmark</span>
                    <Badge variant={benchmarkJob.status === "failed" ? "destructive" : "outline"}>{benchmarkJob.status}</Badge>
                  </div>
                  {benchmarkJob.metrics ? (
                    <p className="mt-1 text-muted-foreground">
                      {benchmarkJob.metrics.generationTokensPerSecond ?? "unknown"} tok/s
                      {benchmarkJob.metrics.timeToFirstTokenMs !== null ? ` · ${benchmarkJob.metrics.timeToFirstTokenMs} ms first token` : ""}
                      {benchmarkJob.metrics.loadMs !== null ? ` · ${benchmarkJob.metrics.loadMs} ms load` : ""}
                    </p>
                  ) : null}
                  {benchmarkJob.error ? <p className="mt-1 text-destructive">{benchmarkJob.error}</p> : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className={gridClass}>
          <select
            value={newModelProvider}
            onChange={(event) => selectNewModelProvider(event.target.value)}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            {PROVIDERS.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>

          {providerUsesBaseUrl ? (
            <Input
              type={providerWizard?.onboarding?.baseUrl?.type ?? "text"}
              placeholder={providerWizard?.onboarding?.baseUrl?.placeholder ?? "Base URL"}
              value={newModelBaseUrl}
              onChange={(event) => setNewModelBaseUrl(event.target.value)}
            />
          ) : null}

          {providerUsesCredentialInput ? (
            <Input
              type={providerWizard?.onboarding?.credential?.type ?? "password"}
              placeholder={
                providerWizard?.onboarding?.credential?.placeholder ??
                `API key or secret:${selectedProviderInfo?.envKey ?? "NAME"}`
              }
              value={newModelApiKey}
              onChange={(event) => setNewModelApiKey(event.target.value)}
            />
          ) : null}

          <Input
            list="provider-model-suggestions"
            placeholder={
              providerWizard?.onboarding?.modelId?.placeholder ??
              (selectedProviderInfo
                ? `Model ID (default: ${selectedProviderInfo.defaultModel})`
                : "Model ID (optional)")
            }
            value={newModelId}
            onChange={(event) => setNewModelId(event.target.value)}
          />
          <datalist id="provider-model-suggestions">
            {selectedProviderInfo?.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </datalist>

          <Button onClick={addModel}>
            <Plus className="mr-1 h-4 w-4" />
            Add
          </Button>
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={newModelFastMode}
            onChange={(event) => setNewModelFastMode(event.target.checked)}
          />
          Default fast mode for this model
        </label>

        <details className="rounded-md border bg-muted/10 px-3 py-2 text-xs">
          <summary className="cursor-pointer font-medium text-muted-foreground">Provider details</summary>
          <div className="mt-2 space-y-1.5 text-muted-foreground">
            {providerWizard?.onboarding?.baseUrl?.help && providerUsesBaseUrl ? (
              <p>{providerWizard.onboarding.baseUrl.help}</p>
            ) : null}
            {providerWizard?.onboarding?.credential?.help && providerUsesCredentialInput ? (
              <p>{providerWizard.onboarding.credential.help}</p>
            ) : null}
            {isProviderLocallyHosted(newModelProvider) && !providerWizard?.onboarding?.baseUrl?.help ? (
              <p>This provider runs locally or on a self-hosted endpoint.</p>
            ) : null}
            {selectedProviderInfo ? (
              <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]">
                <dt>Default model</dt>
                <dd className="font-mono text-foreground">{selectedProviderInfo.defaultModel}</dd>
                {selectedAuthConfig ? (
                  <>
                    <dt>Authentication</dt>
                    <dd className="text-foreground">{selectedAuthConfig.authType.replace(/_/g, " ")}</dd>
                  </>
                ) : null}
                {suggestedModels.length > 0 ? (
                  <>
                    <dt>Suggested models</dt>
                    <dd className="text-foreground">{suggestedModels.slice(0, 4).map((model) => model.id).join(", ")}</dd>
                  </>
                ) : null}
                {providerDiscoveryMode ? (
                  <>
                    <dt>Model discovery</dt>
                    <dd className="text-foreground">{providerDiscoveryMode}</dd>
                  </>
                ) : null}
                {providerUsesCredentialInput ? (
                  <>
                    <dt>Secret reference</dt>
                    <dd className="font-mono text-foreground">secret:{selectedProviderInfo.envKey}</dd>
                  </>
                ) : null}
              </dl>
            ) : null}
          </div>
        </details>

        {selectedAuthConfig?.authType === "oauth_external" || selectedAuthConfig?.authType === "oauth_device_code" ? (
          <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            <div className="mb-1 flex items-center gap-2">
              <Badge variant="outline">OAuth provider</Badge>
              <span className="font-medium text-foreground">{selectedAuthConfig.label}</span>
            </div>
            <p>{selectedAuthConfig.notes ?? "Use an imported OAuth token or external CLI login for this provider."}</p>
          </div>
        ) : null}

        <Separator />

        <div className="rounded-md border bg-muted/20 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Provider Health</div>
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => { fetchModels(); fetchHealth(); }}>
              Refresh
            </Button>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {healthChecks.filter((check) => check.name === "models" || check.name === "google-oauth" || check.name === "channels").map((check) => (
              <div key={check.name} className="rounded border bg-background px-3 py-2 text-xs">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-medium">{check.name}</span>
                  <Badge variant={check.status === "fail" ? "destructive" : check.status === "ok" ? "default" : "secondary"}>
                    {check.status}
                  </Badge>
                </div>
                <div className="text-muted-foreground">{check.details}</div>
              </div>
            ))}
          </div>
        </div>

        {models.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No models configured. Using environment variables as fallback.
            <br />
            <span className="font-mono text-xs">
              CLI: dpc models add &lt;provider&gt; [&lt;api-key&gt;] [&lt;base-url&gt;] [--fast]
            </span>
          </p>
        ) : (
          <div className="space-y-2">
            {models.map((model) => {
              const warnings = getModelWarnings(model);
              return (
                <div
                  key={model.id}
                  className="rounded-lg border p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-sm">{model.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {model.provider} / {model.modelId}
                      </div>
                      {model.baseUrl ? (
                        <div className="truncate text-[11px] text-muted-foreground">{model.baseUrl}</div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={testingModelId === model.id}
                        onClick={() => testConfiguredModel(model)}
                      >
                        {testingModelId === model.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                        Test and review
                      </Button>
                      {model.fastMode ? <Badge variant="outline">FAST</Badge> : null}
                      <Badge variant={model.isActive ? "default" : "secondary"}>
                        P{model.priority}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        onClick={async () => {
                          await fetch(`/api/models?id=${model.id}`, { method: "DELETE" });
                          fetchModels();
                          fetchHealth();
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  {warnings.length > 0 ? (
                    <>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {warnings.map((warning) => (
                          <Badge
                            key={`${warning.label}-${warning.detail}`}
                            variant={warning.tone === "fail" ? "destructive" : warning.tone === "warn" ? "secondary" : "outline"}
                            className="text-[10px]"
                            title={warning.detail}
                          >
                            {warning.label}
                          </Badge>
                        ))}
                      </div>
                      <div className="mt-2 space-y-1 rounded border bg-muted/20 px-2 py-1.5 text-[11px] text-muted-foreground">
                        {warnings.slice(0, 3).map((warning) => (
                          <div key={`${warning.label}-remediation`}>
                            <span className="font-medium text-foreground">{warning.label}: </span>
                            {getModelRemediation(warning)}
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                  {advisories.find((advisory) => advisory.modelRowId === model.id && advisory.status === "ready") ? (() => {
                    const advisory = advisories.find((item) => item.modelRowId === model.id && item.status === "ready")!;
                    return (
                      <div className="mt-2 rounded border bg-muted/20 px-3 py-2 text-xs">
                        <p className="font-medium">{advisory.summary}</p>
                        {advisory.suggestions.slice(0, 3).map((suggestion) => (
                          <p key={`${suggestion.kind}-${suggestion.title}`} className="mt-1 text-muted-foreground">
                            <span className="font-medium text-foreground">{suggestion.kind}</span> {suggestion.title}. {suggestion.tradeoff}
                          </p>
                        ))}
                        <div className="mt-2 flex gap-2">
                          <Button type="button" size="sm" variant="ghost" onClick={async () => {
                            await fetch("/api/model-fit/advisory", {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ advisoryId: advisory.id, action: "dismiss" }),
                            });
                            fetchAdvisories();
                          }}>Keep current model</Button>
                          <Button type="button" size="sm" variant="ghost" onClick={async () => {
                            await fetch("/api/model-fit/advisory", {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ action: "remind" }),
                            });
                            fetchAdvisories();
                          }}>Remind me later</Button>
                        </div>
                      </div>
                    );
                  })() : null}
                </div>
              );
            })}
          </div>
        )}

        <details className="rounded-md border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            Runtime Routing
            <span className="ml-2 font-normal text-muted-foreground">Advanced</span>
          </summary>
          <div className="space-y-4 border-t p-4">
            <p className="text-xs text-muted-foreground">
              Optionally route short requests to models marked FAST and tune provider-specific prompt caching.
            </p>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={smartRoutingEnabled}
                onChange={(event) => setSmartRoutingEnabled(event.target.checked)}
              />
              Enable smart routing to FAST models for simple user turns
            </label>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Max simple chars</div>
                <Input
                  type="number"
                  min={40}
                  max={2000}
                  value={smartRoutingMaxChars}
                  onChange={(event) => setSmartRoutingMaxChars(Number(event.target.value || 160))}
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Max simple words</div>
                <Input
                  type="number"
                  min={4}
                  max={300}
                  value={smartRoutingMaxWords}
                  onChange={(event) => setSmartRoutingMaxWords(Number(event.target.value || 28))}
                />
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={anthropicPromptCachingEnabled}
                    onChange={(event) => setAnthropicPromptCachingEnabled(event.target.checked)}
                  />
                  Enable Anthropic prompt caching
                </label>
              </div>
            </div>

            <Button variant="outline" onClick={saveRuntimeConfig} disabled={savingRuntimeConfig}>
              {savingRuntimeConfig ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Save Runtime Routing
            </Button>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
