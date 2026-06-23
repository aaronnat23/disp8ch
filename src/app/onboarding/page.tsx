"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Brain,
  Check,
  Cloud,
  Cpu,
  Gauge,
  KeyRound,
  Loader2,
  MemoryStick,
  Server,
  Settings2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { BrandLogo } from "@/components/layout/brand-logo";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";
import {
  providerRequiresApiKey,
  providerSupportsBaseUrlInput,
} from "@/lib/agents/provider-plugins";
import { PROVIDERS } from "@/types/model";
import type { ModelProvider } from "@/types/model";

type SetupMode = "online" | "local";
type LearningMode = "review" | "auto" | "off";

type ProbeResult = {
  provider: string;
  modelId: string;
  name: string;
  baseUrl: string | null;
  latencyMs: number;
  response: string;
  tokensUsed: number;
};

type LocalRecommendation = {
  source: "local_gguf" | "ollama_installed" | "catalog";
  modelId: string;
  displayName: string;
  fitClass: string;
  confidence: string;
  fitSource: string;
  path: string | null;
  ollamaTag: string | null;
  commands: { llamaServer?: string; ollama?: { run: string; note?: string } };
  reasons: string[];
  warnings: string[];
};

type LocalFitResult = {
  hardware: {
    cpuModel: string;
    logicalCores: number;
    totalRamGB: number;
    freeRamGB: number;
    gpus: Array<{ name: string; totalVramGB: number; freeVramGB: number | null }>;
  };
  lanes: { quality: LocalRecommendation | null; balanced: LocalRecommendation | null; fast: LocalRecommendation | null };
};

type ProviderChoice = {
  provider: ModelProvider;
  label: string;
  hint: string;
  badge?: string;
  modelId?: string;
  baseUrl?: string;
  fastMode: boolean;
  featured?: boolean;
};

const DEFAULT_PROVIDER = "deepseek";
const DEFAULT_LEARNING_MODE = "review" as const;
const LOCAL_RECOMMENDATION_LANES = [
  { key: "quality", title: "Best quality", hint: "For deeper reasoning and larger tasks." },
  { key: "balanced", title: "Best all-rounder", hint: "The best tradeoff for daily use." },
  { key: "fast", title: "Best speed", hint: "For quick chats and short tasks." },
] as const;

const ONLINE_PROVIDER_CHOICES: ProviderChoice[] = [
  {
    provider: DEFAULT_PROVIDER,
    label: "DeepSeek Direct",
    hint: "Fast, capable, and low-cost direct API access.",
    badge: "Easiest hosted",
    modelId: "deepseek-v4-flash",
    fastMode: true,
    featured: true,
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    hint: "One API key for models from many providers.",
    badge: "Gateway",
    fastMode: true,
    featured: true,
  },
  {
    provider: "google",
    label: "Google Gemini",
    hint: "Strong multimodal models and large context windows.",
    fastMode: true,
    featured: true,
  },
  {
    provider: "openai",
    label: "OpenAI",
    hint: "Broad model ecosystem with reliable tool calling.",
    fastMode: true,
    featured: true,
  },
  {
    provider: "anthropic",
    label: "Anthropic Claude",
    hint: "Strong reasoning and long-context agent work.",
    fastMode: false,
    featured: true,
  },
  { provider: "groq", label: "Groq", hint: "Low-latency hosted inference.", fastMode: true },
  { provider: "mistral", label: "Mistral AI", hint: "Multilingual hosted models.", fastMode: true },
  { provider: "qwen", label: "Qwen (DashScope)", hint: "Direct Qwen API access.", fastMode: true },
  { provider: "moonshot", label: "Moonshot (Kimi)", hint: "Direct Kimi model access.", fastMode: true },
  { provider: "zhipu", label: "ZhipuAI (GLM)", hint: "Direct GLM model access.", fastMode: true },
  { provider: "xai", label: "xAI (Grok)", hint: "Grok models with tool support.", fastMode: true },
  { provider: "together", label: "Together AI", hint: "Hosted open-model catalog.", fastMode: true },
];

const LOCAL_PROVIDER_CHOICES: ProviderChoice[] = [
  {
    provider: "ollama",
    label: "Ollama",
    hint: "The easiest local setup. Start Ollama and auto-detect a loaded model.",
    badge: "Recommended",
    modelId: "",
    baseUrl: "http://localhost:11434",
    fastMode: false,
    featured: true,
  },
  {
    provider: "lmstudio",
    label: "LM Studio",
    hint: "Use the local server built into the LM Studio desktop app.",
    badge: "Desktop",
    modelId: "",
    baseUrl: "http://127.0.0.1:1234/v1",
    fastMode: false,
    featured: true,
  },
  {
    provider: "openai-compatible",
    label: "llama.cpp / OpenAI-compatible",
    hint: "Use llama-server or another custom OpenAI-compatible endpoint.",
    badge: "Advanced",
    modelId: "",
    baseUrl: "http://127.0.0.1:8080/v1",
    fastMode: false,
    featured: true,
  },
  {
    provider: "vllm",
    label: "vLLM",
    hint: "High-throughput local or self-hosted serving.",
    badge: "Advanced",
    modelId: "",
    baseUrl: "http://127.0.0.1:8000/v1",
    fastMode: false,
    featured: true,
  },
  {
    provider: "sglang",
    label: "SGLang",
    hint: "Fast local or self-hosted OpenAI-compatible serving.",
    badge: "Advanced",
    modelId: "",
    baseUrl: "http://127.0.0.1:30000/v1",
    fastMode: false,
    featured: true,
  },
];

const LEARNING_CHOICES: Array<{
  mode: LearningMode;
  label: string;
  hint: string;
  badge?: string;
}> = [
  {
    mode: DEFAULT_LEARNING_MODE,
    label: "Review first",
    hint: "disp8ch proposes useful preferences and playbooks. You approve them before they become active.",
    badge: "Recommended",
  },
  {
    mode: "auto",
    label: "Learn automatically",
    hint: "Repeated useful learnings can be promoted automatically. Best for experienced users.",
  },
  {
    mode: "off",
    label: "Turn learning off",
    hint: "Use the app without capturing preferences or reusable playbooks.",
  },
];

function providerLabel(provider: string) {
  return PROVIDERS.find((entry) => entry.id === provider)?.name ?? provider;
}

function providerDefaultModel(provider: string) {
  return PROVIDERS.find((entry) => entry.id === provider)?.defaultModel ?? "";
}

function providerDefaultBaseUrl(provider: string) {
  const info = PROVIDERS.find((entry) => entry.id === provider);
  return normalizeProviderBaseUrl(provider, info?.baseUrl) ?? info?.baseUrl ?? "";
}

function choiceForProvider(mode: SetupMode, provider: ModelProvider): ProviderChoice | undefined {
  const choices = mode === "online" ? ONLINE_PROVIDER_CHOICES : LOCAL_PROVIDER_CHOICES;
  return choices.find((choice) => choice.provider === provider);
}

function formatGB(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(value >= 10 ? 0 : 1)} GB` : "unknown";
}

function runtimeLabel(recommendation: LocalRecommendation) {
  return recommendation.source === "local_gguf" ? "llama.cpp" : "Ollama";
}

function localServerModelId(recommendation: LocalRecommendation) {
  if (!recommendation.path) return recommendation.displayName;
  return recommendation.path.split(/[\\/]/).pop() || recommendation.displayName;
}

export default function OnboardingPage() {
  const router = useRouter();
  const [mode, setMode] = useState<SetupMode>("online");
  const [provider, setProvider] = useState<ModelProvider>(DEFAULT_PROVIDER);
  const [modelId, setModelId] = useState("deepseek-v4-flash");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [fastMode, setFastMode] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [learningMode, setLearningMode] = useState<LearningMode>(DEFAULT_LEARNING_MODE);
  const [capturePreferences, setCapturePreferences] = useState(true);
  const [capturePlaybooks, setCapturePlaybooks] = useState(true);
  const [busy, setBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [localFit, setLocalFit] = useState<LocalFitResult | null>(null);
  const [checkingLocalFit, setCheckingLocalFit] = useState(false);

  const providerInfo = useMemo(
    () => PROVIDERS.find((entry) => entry.id === provider) ?? PROVIDERS[0],
    [provider],
  );
  const providerChoices = mode === "online" ? ONLINE_PROVIDER_CHOICES : LOCAL_PROVIDER_CHOICES;
  const featuredChoices = providerChoices.filter((choice) => choice.featured);
  const selectedChoice = choiceForProvider(mode, provider);
  const requiresApiKey = providerRequiresApiKey(provider);
  const supportsBaseUrl = providerSupportsBaseUrlInput(provider);
  const availableModels = providerInfo.models.filter((entry) => entry.status !== "legacy" && entry.supportsTools);
  const canStart =
    mode === "local"
      ? baseUrl.trim().length >= 4
      : !requiresApiKey || apiKey.trim().length >= 4;

  function clearResultState() {
    setProbeResult(null);
    setWarnings([]);
    setError(null);
  }

  function applyChoice(choice: ProviderChoice, nextMode = mode) {
    setMode(nextMode);
    setProvider(choice.provider);
    setModelId(choice.modelId ?? providerDefaultModel(choice.provider));
    setBaseUrl(
      choice.baseUrl ??
        (providerSupportsBaseUrlInput(choice.provider) ? providerDefaultBaseUrl(choice.provider) : ""),
    );
    setFastMode(choice.fastMode);
    setApiKey("");
    setShowAdvanced(false);
    clearResultState();
  }

  function applyDefaults(nextMode: SetupMode) {
    const firstChoice = nextMode === "online" ? ONLINE_PROVIDER_CHOICES[0] : LOCAL_PROVIDER_CHOICES[0];
    applyChoice(firstChoice, nextMode);
  }

  function applyProvider(nextProvider: ModelProvider) {
    const nextChoice = choiceForProvider(mode, nextProvider);
    if (nextChoice) applyChoice(nextChoice);
  }

  function applyLearningMode(nextMode: LearningMode) {
    setLearningMode(nextMode);
    if (nextMode === "off") {
      setCapturePreferences(false);
      setCapturePlaybooks(false);
      return;
    }
    setCapturePreferences(true);
    setCapturePlaybooks(true);
  }

  async function checkThisPc() {
    setCheckingLocalFit(true);
    clearResultState();
    try {
      const response = await fetch("/api/model-fit/recommendations?task=general&context=8192&preference=balanced");
      const json = await response.json() as { success?: boolean; data?: LocalFitResult; error?: string };
      if (!response.ok || !json.success || !json.data) {
        throw new Error(json.error || "Could not inspect this PC.");
      }
      setLocalFit(json.data);
    } catch (localError) {
      setLocalFit(null);
      setError(localError instanceof Error ? localError.message : "Could not inspect this PC.");
    } finally {
      setCheckingLocalFit(false);
    }
  }

  function applyRecommendedLocalSetup(recommendation: LocalRecommendation) {
    if (recommendation.ollamaTag) {
      applyChoice(LOCAL_PROVIDER_CHOICES[0], "local");
      setModelId(recommendation.ollamaTag);
      return;
    }
    applyChoice(LOCAL_PROVIDER_CHOICES.find((choice) => choice.provider === "openai-compatible")!, "local");
    setModelId(localServerModelId(recommendation));
  }

  function recommendedCommand(recommendation: LocalRecommendation): string | null {
    return recommendation.commands.llamaServer ?? recommendation.commands.ollama?.run ?? null;
  }

  async function validateConnection(): Promise<boolean> {
    const response = await fetch("/api/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        apiKey,
        baseUrl: supportsBaseUrl || mode === "local" ? baseUrl : undefined,
        modelId: modelId.trim() || undefined,
      }),
    });
    const json = await response.json();
    setWarnings((json.warnings ?? []) as string[]);
    if (!json.success) {
      setProbeResult(null);
      setError(String(json.error || "Could not connect to this model."));
      return false;
    }
    setProbeResult((json.data ?? null) as ProbeResult | null);
    return true;
  }

  async function saveModelIfNeeded(): Promise<boolean> {
    const response = await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        apiKey,
        baseUrl: supportsBaseUrl || mode === "local" ? baseUrl : undefined,
        modelId: modelId.trim() || undefined,
        fastMode,
      }),
    });
    const json = await response.json();
    setWarnings((json.warnings ?? []) as string[]);
    if (!json.success) {
      setError(String(json.error || "Could not save this model."));
      return false;
    }
    return true;
  }

  async function createStarterWorkflows() {
    await fetch("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Channel Workspace Assistant",
        description: "General-purpose assistant for WebChat and connected channels.",
        template: "channel-workspace-assistant",
      }),
    }).catch(() => {});
  }

  async function finishOnboarding() {
    const learningEnabled = learningMode !== "off";
    const response = await fetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        learning_enabled: learningEnabled ? 1 : 0,
        learning_mode: learningMode,
        learning_capture_preferences: learningEnabled && capturePreferences ? 1 : 0,
        learning_capture_playbooks: learningEnabled && capturePlaybooks ? 1 : 0,
        learning_auto_promote_threshold: learningMode === "auto" ? 3 : 2,
      }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || json?.success === false) {
      throw new Error(String(json?.error || "Could not finish onboarding."));
    }
  }

  async function handleStart() {
    if (!canStart) {
      setError(mode === "local" ? "Enter the local server URL first." : "Paste your API key first.");
      return;
    }
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const validated = await validateConnection();
      if (!validated) return;
      const saved = await saveModelIfNeeded();
      if (!saved) return;
      await createStarterWorkflows();
      await finishOnboarding();
      router.push("/");
    } catch (startError) {
      setError(String(startError instanceof Error ? startError.message : startError));
    } finally {
      setBusy(false);
    }
  }

  async function handleSkip() {
    setBusy(true);
    setError(null);
    try {
      await finishOnboarding();
      router.push("/");
    } catch (skipError) {
      setError(String(skipError instanceof Error ? skipError.message : skipError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-background p-4 py-8">
      <Card className="w-full max-w-3xl">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
            <BrandLogo className="h-9 w-12" priority />
          </div>
          <CardTitle className="text-2xl">Set up disp8ch</CardTitle>
          <CardDescription>
            Choose where AI runs, connect one model, and decide how self-learning should work. Everything else uses safe defaults and can be changed later.
            <span className="sr-only">PowerShell installer support is documented in the README.</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {error ? (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          {warnings.length > 0 ? (
            <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-100">
              {warnings.map((warning) => <div key={warning}>{warning}</div>)}
            </div>
          ) : null}

          <section className="space-y-3">
            <div>
              <div className="text-sm font-semibold">1. Where should AI run?</div>
              <p className="text-xs text-muted-foreground">Online is easiest. Local keeps model traffic on your own server.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => applyDefaults("online")}
                className={`rounded-xl border p-4 text-left transition-colors ${
                  mode === "online" ? "border-red-400 bg-red-500/10" : "border-border hover:border-red-400/60"
                }`}
              >
                <div className="mb-2 flex items-center gap-2 font-semibold">
                  <Cloud className="h-5 w-5 text-red-400" />
                  Online AI
                </div>
                <p className="text-sm text-muted-foreground">Use a hosted provider with an API key.</p>
                <Badge variant="outline" className="mt-3 text-[10px]">Easiest hosted</Badge>
              </button>

              <button
                type="button"
                onClick={() => applyDefaults("local")}
                className={`rounded-xl border p-4 text-left transition-colors ${
                  mode === "local" ? "border-red-400 bg-red-500/10" : "border-border hover:border-red-400/60"
                }`}
              >
                <div className="mb-2 flex items-center gap-2 font-semibold">
                  <Server className="h-5 w-5 text-red-400" />
                  Local AI
                </div>
                <p className="text-sm text-muted-foreground">Use Ollama, LM Studio, llama.cpp, vLLM, SGLang, or a compatible server.</p>
                <Badge variant="outline" className="mt-3 text-[10px]">Local/private</Badge>
              </button>
            </div>
          </section>

          <section className="space-y-3">
            <div>
              <div className="text-sm font-semibold">2. Choose a {mode === "online" ? "provider" : "local runtime"}</div>
              <p className="text-xs text-muted-foreground">Pick a common preset or use the full list.</p>
            </div>

            {mode === "local" ? (
              <div className="rounded-xl border bg-card/40 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-medium">Not sure which local model to use?</div>
                    <p className="mt-1 text-xs text-muted-foreground">Check your RAM, GPU, installed models, and local runtimes. Nothing is downloaded or started.</p>
                  </div>
                  <Button type="button" variant="outline" onClick={checkThisPc} disabled={checkingLocalFit}>
                    {checkingLocalFit ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                    Check this PC
                  </Button>
                </div>
                {localFit ? (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-lg border border-dashed bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-foreground">
                        <Cpu className="h-3.5 w-3.5" /> This PC
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        <span>{localFit.hardware.cpuModel} ({localFit.hardware.logicalCores} threads)</span>
                        <span className="inline-flex items-center gap-1"><MemoryStick className="h-3 w-3" /> {formatGB(localFit.hardware.freeRamGB)} free of {formatGB(localFit.hardware.totalRamGB)} RAM</span>
                        {localFit.hardware.gpus.map((gpu) => (
                          <span key={gpu.name} className="inline-flex items-center gap-1"><Gauge className="h-3 w-3" /> {gpu.name}: {formatGB(gpu.freeVramGB)} free of {formatGB(gpu.totalVramGB)} VRAM</span>
                        ))}
                      </div>
                    </div>
                    <div className="grid gap-2 lg:grid-cols-3">
                      {LOCAL_RECOMMENDATION_LANES.map((lane) => {
                        const recommendation = localFit.lanes[lane.key];
                        if (!recommendation) {
                          return (
                            <div key={lane.key} className="rounded-lg border border-dashed bg-background/40 p-3 text-xs text-muted-foreground">
                              <div className="font-medium text-foreground">{lane.title}</div>
                              <p className="mt-1">No suitable model was found for this lane.</p>
                            </div>
                          );
                        }
                        const command = recommendedCommand(recommendation);
                        const alreadyRunning = recommendation.fitSource === "llama_server_live";
                        return (
                          <div key={lane.key} className="rounded-lg border bg-background p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{lane.title}</div>
                                <div className="mt-0.5 text-sm font-medium">{recommendation.displayName}</div>
                              </div>
                              <Badge variant="outline" className="text-[10px]">{runtimeLabel(recommendation)}</Badge>
                            </div>
                            <p className="mt-1 text-[11px] text-muted-foreground">{lane.hint}</p>
                            {recommendation.reasons[0] ? <p className="mt-2 text-xs text-muted-foreground">{recommendation.reasons[0]}</p> : null}
                            {recommendation.warnings[0] ? <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{recommendation.warnings[0]}</p> : null}
                            {command && !alreadyRunning ? <div className="mt-2 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-[10px] text-muted-foreground">{command}</div> : null}
                            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => applyRecommendedLocalSetup(recommendation)}>
                              Use this setup
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {Object.values(localFit.lanes).some((recommendation) => recommendation?.fitSource === "llama_server_live")
                        ? "A detected llama-server model is already responding. Select Use this setup, then test and save the connection."
                        : "Run the displayed command first. disp8ch only fills the selected local setup and never starts or downloads a model automatically."}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className={`grid gap-2 ${mode === "online" ? "sm:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-3"}`}>
              {featuredChoices.map((choice) => (
                <button
                  key={choice.provider}
                  type="button"
                  onClick={() => applyChoice(choice)}
                  className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                    provider === choice.provider
                      ? "border-red-400 bg-red-500/10"
                      : "border-border bg-card/30 hover:border-red-400/60"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold">{choice.label}</span>
                    {choice.badge ? <Badge variant="outline" className="shrink-0 text-[9px]">{choice.badge}</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{choice.hint}</p>
                </button>
              ))}
            </div>

            <div className="rounded-xl border bg-card/40 p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Provider or runtime</label>
                  <Select value={provider} onValueChange={(value) => applyProvider(value as ModelProvider)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {providerChoices.map((choice) => (
                        <SelectItem key={choice.provider} value={choice.provider}>
                          {choice.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{selectedChoice?.hint ?? providerInfo.description}</p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Model ID</label>
                  <Input
                    list="onboarding-model-options"
                    value={modelId}
                    onChange={(event) => {
                      setModelId(event.target.value);
                      clearResultState();
                    }}
                    placeholder={mode === "local" ? "Auto-detect loaded model" : providerInfo.defaultModel}
                  />
                  <datalist id="onboarding-model-options">
                    {availableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                  </datalist>
                  <p className="text-xs text-muted-foreground">
                    {mode === "local"
                      ? "Leave blank to auto-detect the loaded model, or enter the exact server model ID."
                      : "Choose a suggested model or enter another tool-capable model ID."}
                  </p>
                </div>
              </div>

              {mode === "online" ? (
                <div className="mt-4 space-y-2">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <KeyRound className="h-4 w-4 text-red-400" />
                    {providerLabel(provider)} API key
                  </label>
                  <Input
                    type="password"
                    placeholder="Paste your API key"
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      clearResultState();
                    }}
                  />
                  <p className="text-xs text-muted-foreground">The key is stored only in your local app data.</p>
                </div>
              ) : (
                <div className="mt-4 space-y-2">
                  <label className="text-sm font-medium">Server URL</label>
                  <Input
                    value={baseUrl}
                    onChange={(event) => {
                      setBaseUrl(event.target.value);
                      clearResultState();
                    }}
                    placeholder={selectedChoice?.baseUrl || providerInfo.baseUrl || "http://127.0.0.1:8080/v1"}
                  />
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline" className="text-[9px]">{"No key by default"}</Badge>
                    Start the server and load a model before testing.
                  </div>
                </div>
              )}

              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((value) => !value)}
                  className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  {showAdvanced ? "Hide advanced connection" : "Advanced connection"}
                </button>

                {showAdvanced ? (
                  <div className="mt-3 rounded-lg border border-dashed p-3">
                    {mode === "local" ? (
                      <div className="space-y-2">
                        <label className="text-sm font-medium">{"Optional local auth"}</label>
                        <Input
                          type="password"
                          value={apiKey}
                          onChange={(event) => {
                            setApiKey(event.target.value);
                            clearResultState();
                          }}
                          placeholder="Leave blank unless your server requires a key"
                        />
                      </div>
                    ) : supportsBaseUrl ? (
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Custom provider base URL</label>
                        <Input
                          value={baseUrl}
                          onChange={(event) => {
                            setBaseUrl(event.target.value);
                            clearResultState();
                          }}
                          placeholder={providerInfo.baseUrl || "Provider endpoint"}
                        />
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">This provider uses its official endpoint automatically.</p>
                    )}
                    <p className="mt-3 text-xs text-muted-foreground">
                      Smart defaults: {fastMode ? "fast/simple routing enabled" : "balanced routing"}, starter workflow included, and tool-capability validation enabled.
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-start gap-2">
              <Brain className="mt-0.5 h-5 w-5 text-red-400" />
              <div>
                <div className="text-sm font-semibold">3. Self-learning</div>
                <p className="text-xs text-muted-foreground">Choose how disp8ch should learn from repeated work and your preferences.</p>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              {LEARNING_CHOICES.map((choice) => (
                <button
                  key={choice.mode}
                  type="button"
                  onClick={() => applyLearningMode(choice.mode)}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    learningMode === choice.mode
                      ? "border-red-400 bg-red-500/10"
                      : "border-border bg-card/30 hover:border-red-400/60"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold">{choice.label}</span>
                    {choice.badge ? <Badge variant="outline" className="text-[9px]">{choice.badge}</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{choice.hint}</p>
                </button>
              ))}
            </div>

            {learningMode !== "off" ? (
              <div className="grid gap-3 rounded-xl border bg-card/40 p-4 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-3">
                  <span>
                    <span className="block text-sm font-medium">Remember preferences</span>
                    <span className="block text-xs text-muted-foreground">Capture stable choices such as tone, format, and working style.</span>
                  </span>
                  <Switch checked={capturePreferences} onCheckedChange={setCapturePreferences} />
                </label>
                <label className="flex items-center justify-between gap-3">
                  <span>
                    <span className="block text-sm font-medium">Build reusable playbooks</span>
                    <span className="block text-xs text-muted-foreground">Capture repeated successful procedures for future work.</span>
                  </span>
                  <Switch checked={capturePlaybooks} onCheckedChange={setCapturePlaybooks} />
                </label>
              </div>
            ) : null}
          </section>

          {probeResult ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
              <div className="flex items-center gap-2 font-medium">
                <Check className="h-4 w-4" />
                Model connected
              </div>
              <div className="mt-1 text-xs">{probeResult.name} replied in {probeResult.latencyMs} ms.</div>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
            <Button variant="ghost" onClick={() => void handleSkip()} disabled={busy}>
              Open without AI for now
            </Button>
            <Button
              onClick={() => void handleStart()}
              disabled={!canStart || busy}
              className="gap-2"
              aria-label="Run Live Test and open disp8ch"
              title="Run Live Test"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Test connection and open disp8ch
              {!busy ? <ArrowRight className="h-4 w-4" /> : null}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
