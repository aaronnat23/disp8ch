"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Loader2, Plus, Trash2 } from "lucide-react";
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

  const selectedProviderInfo = PROVIDERS.find((provider) => provider.id === newModelProvider);
  const selectedAuthConfig = getProviderAuthConfig(newModelProvider);
  const providerWizard = getProviderWizardMeta(newModelProvider);
  const providerNeedsApiKey = providerRequiresApiKey(newModelProvider);
  const providerUsesBaseUrl = providerSupportsBaseUrlInput(newModelProvider);
  const providerUsesCredentialInput = providerSupportsCredentialInput(newModelProvider);
  const providerDiscoveryMode = getProviderDiscoveryMode(newModelProvider);
  const suggestedModels = selectedProviderInfo?.models.filter((model) => model.supportsTools) ?? [];

  useEffect(() => {
    setNewModelApiKey("");
    setNewModelBaseUrl(getProviderDefaultBaseUrl(newModelProvider) ?? "");
    setNewModelId("");
    setNewModelFastMode(false);
  }, [newModelProvider]);

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

  useEffect(() => {
    fetchModels();
    fetchHealth();
    fetchRuntimeConfig();
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

        <div className={gridClass}>
          <select
            value={newModelProvider}
            onChange={(event) => setNewModelProvider(event.target.value)}
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
