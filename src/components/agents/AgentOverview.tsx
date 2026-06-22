"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  AlertTriangle,
  PauseCircle,
} from "lucide-react";
import { AgentIconPicker } from "@/components/agents/AgentIconPicker";
import { PROVIDERS } from "@/types/model";
import {
  AgentRecord,
  AgentForm,
  AgentRole,
  AgentRuntimeProfile,
  ModelOption,
  formatUsd,
} from "./types";

type ReadinessCard = {
  label: string;
  ok: boolean;
  detail: string;
};

export function AgentOverview({
  selectedAgent,
  form,
  setForm,
  activeModelOptions,
  hasConfiguredModelRef,
  modelMode,
  customModelProvider,
  setCustomModelProvider,
  customModelId,
  setCustomModelId,
  modelsLoading,
  savingOverview,
  overviewDirty,
  selectedAgentRole,
  toolsCount,
  enabledTools,
  enabledSkillPacks,
  enabledExtensions,
  channelWorkflows,
  connectedChannels,
  onChangeModelMode,
  onSelectConfiguredModel,
  onCustomModelProviderChange,
  onCustomModelIdChange,
  onSaveOverview,
  loadModels,
  hasChannelConfig,
  hasScheduleConfig,
}: {
  selectedAgent: AgentRecord;
  form: AgentForm;
  setForm: React.Dispatch<React.SetStateAction<AgentForm>>;
  activeModelOptions: ModelOption[];
  hasConfiguredModelRef: boolean;
  modelMode: "global" | "configured" | "custom";
  customModelProvider: string;
  setCustomModelProvider: (value: string) => void;
  customModelId: string;
  setCustomModelId: (value: string) => void;
  modelsLoading: boolean;
  savingOverview: boolean;
  overviewDirty: boolean;
  selectedAgentRole: AgentRole | null;
  toolsCount: number;
  enabledTools: number;
  enabledSkillPacks: number;
  enabledExtensions: number;
  channelWorkflows: { length: number };
  connectedChannels: number;
  onChangeModelMode: (mode: "global" | "configured" | "custom") => void;
  onSelectConfiguredModel: (id: string) => void;
  onCustomModelProviderChange: (value: string) => void;
  onCustomModelIdChange: (value: string) => void;
  onSaveOverview: () => Promise<void>;
  loadModels: () => Promise<void>;
  hasChannelConfig: boolean;
  hasScheduleConfig: boolean;
}) {
  const [runtimeProfile, setRuntimeProfile] = useState<AgentRuntimeProfile | null>(null);
  const [runtimeProfileLoading, setRuntimeProfileLoading] = useState(false);
  const [modelTestState, setModelTestState] = useState<{
    status: "idle" | "testing" | "ok" | "error";
    message: string;
  }>({ status: "idle", message: "" });
  const [sections, setSections] = useState<Record<string, boolean>>({
    identity: true,
    runtime: true,
    model: true,
    budget: !!(selectedAgent.spendCapUsd != null || selectedAgent.budgetMonthlyCents),
    advanced: false,
  });

  const toggleSection = (key: string) => {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const readinessItems = useMemoReady(
    selectedAgent,
    activeModelOptions,
    toolsCount,
    enabledTools,
    enabledSkillPacks,
    enabledExtensions,
    channelWorkflows,
    connectedChannels,
    selectedAgentRole,
    hasChannelConfig,
    hasScheduleConfig,
  );

  useEffect(() => {
    let cancelled = false;
    setRuntimeProfileLoading(true);
    fetch(`/api/agents/${encodeURIComponent(selectedAgent.id)}/runtime-profile`)
      .then((response) => response.json())
      .then((json) => {
        if (cancelled) return;
        setRuntimeProfile(json?.success ? (json.data as AgentRuntimeProfile) : null);
      })
      .catch(() => {
        if (!cancelled) setRuntimeProfile(null);
      })
      .finally(() => {
        if (!cancelled) setRuntimeProfileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAgent.id, selectedAgent.updatedAt]);

  const runModelTest = async () => {
    const provider =
      modelMode === "custom"
        ? customModelProvider
        : runtimeProfile?.effectiveProvider || activeModelOptions.find((model) => model.id === form.modelRef)?.provider || "";
    const modelId =
      modelMode === "custom"
        ? customModelId
        : runtimeProfile?.effectiveModel || activeModelOptions.find((model) => model.id === form.modelRef)?.modelId || "";
    if (!provider || !modelId) {
      setModelTestState({ status: "error", message: "No effective provider/model is available to test." });
      return;
    }
    setModelTestState({ status: "testing", message: "Testing..." });
    try {
      const response = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          modelId,
          apiKey: form.modelApiKey,
          baseUrl: form.modelBaseUrl,
        }),
      });
      const json = await response.json();
      if (json?.success) {
        setModelTestState({
          status: "ok",
          message: `Ready in ${json.data?.latencyMs ?? "?"} ms.`,
        });
      } else {
        setModelTestState({
          status: "error",
          message: json?.error || `Model test failed with HTTP ${response.status}.`,
        });
      }
    } catch (error) {
      setModelTestState({ status: "error", message: String(error) });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Agent Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Readiness Dashboard */}
        <div className="rounded-md border bg-muted/10 p-4">
          <div className="mb-2 text-xs font-mono uppercase tracking-widest text-muted-foreground">
            Readiness
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {readinessItems.map((card) => (
              <div
                key={card.label}
                className={`rounded-md border p-3 ${
                  card.ok
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : "border-amber-500/30 bg-amber-500/5"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {card.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
                  )}
                  <span className="text-xs font-medium">{card.label}</span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">{card.detail}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Section: Runtime Profile */}
        <SectionHeader
          title="Runtime Profile"
          expanded={sections.runtime}
          onToggle={() => toggleSection("runtime")}
        />
        {sections.runtime ? (
          <div className="rounded-md border bg-background p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">Effective run configuration</div>
                <div className="text-xs text-muted-foreground">
                  Inherited and overridden values the runtime will use for this agent.
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => void runModelTest()} disabled={modelTestState.status === "testing"}>
                {modelTestState.status === "testing" ? "Testing..." : "Test Model"}
              </Button>
            </div>
            {runtimeProfileLoading ? (
              <div className="text-xs text-muted-foreground">Loading runtime profile...</div>
            ) : runtimeProfile ? (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                <RuntimeProfileRow
                  label="Model"
                  value={`${runtimeProfile.effectiveProvider}/${runtimeProfile.effectiveModel}`}
                  detail={runtimeProfile.modelSource.replace(/_/g, " ")}
                  tone={runtimeProfile.providerHealth === "ok" ? "ok" : runtimeProfile.providerHealth === "error" ? "bad" : "warn"}
                />
                <RuntimeProfileRow
                  label="Tool Use"
                  value={runtimeProfile.toolCallSupport ? "Supported" : "Not supported"}
                  detail={`${runtimeProfile.contextWindow ? runtimeProfile.contextWindow.toLocaleString() : "unknown"} context tokens`}
                  tone={runtimeProfile.toolCallSupport ? "ok" : "bad"}
                />
                <RuntimeProfileRow
                  label="Workspace"
                  value={runtimeProfile.workspacePath || "Default workspace"}
                  detail={runtimeProfile.workspaceTrusted ? "path exists" : "not verified"}
                  tone={runtimeProfile.workspaceTrusted || !runtimeProfile.workspacePath ? "ok" : "warn"}
                />
                <RuntimeProfileRow
                  label="Tools"
                  value={`${runtimeProfile.enabledToolsCount} enabled`}
                  detail={runtimeProfile.highRiskToolsEnabled ? "high-risk tools enabled" : "high-risk tools off"}
                  tone={runtimeProfile.highRiskToolsEnabled ? "warn" : "ok"}
                />
                <RuntimeProfileRow
                  label="Skills & Channels"
                  value={runtimeProfile.skillsReady ? "Skills ready" : "No skills enabled"}
                  detail={`${runtimeProfile.channelsConfigured} channel(s), wakeups ${runtimeProfile.hasCronWakeup ? "on" : "off"}`}
                  tone={runtimeProfile.skillsReady || runtimeProfile.channelsConfigured > 0 ? "ok" : "warn"}
                />
                <RuntimeProfileRow
                  label="Budget"
                  value={runtimeProfile.budgetCap == null ? "No monthly cap" : `${formatUsd((runtimeProfile.budgetSpent ?? 0) / 100)} / ${formatUsd(runtimeProfile.budgetCap / 100)}`}
                  detail={runtimeProfile.budgetAction ? `action: ${runtimeProfile.budgetAction}` : "no hard action"}
                  tone="ok"
                />
                <div className="md:col-span-2 xl:col-span-3 rounded-md border bg-muted/20 p-3">
                  <div className="mb-2 text-[11px] font-medium uppercase text-muted-foreground">Startup Files</div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(runtimeProfile.startupFiles).map(([name, exists]) => (
                      <Badge key={name} variant={exists ? "secondary" : "outline"} className="text-[10px]">
                        {name}: {exists ? "ready" : "missing"}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">Runtime profile unavailable.</div>
            )}
            {modelTestState.message ? (
              <div className={`mt-3 rounded-md border px-3 py-2 text-xs ${
                modelTestState.status === "ok"
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700"
                  : modelTestState.status === "error"
                    ? "border-red-500/30 bg-red-500/5 text-red-700"
                    : "border-border bg-muted/20 text-muted-foreground"
              }`}>
                {modelTestState.message}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Section: Identity */}
        <SectionHeader
          title="Identity"
          expanded={sections.identity}
          onToggle={() => toggleSection("identity")}
        />
        {sections.identity ? (
          <div className="space-y-3 pl-1">
            <div className="flex items-end gap-3">
              <div className="space-y-2">
                <Label>Icon</Label>
                <AgentIconPicker
                  value={form.icon || "Bot"}
                  onChange={(icon) => setForm((current) => ({ ...current, icon }))}
                />
              </div>
              <div className="flex-1 space-y-2">
                <Label>Name</Label>
                <Input
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Display name and icon for this agent throughout the application.
            </p>
          </div>
        ) : null}

        {/* Section: Model Configuration */}
        <SectionHeader
          title="Model Configuration"
          expanded={sections.model}
          onToggle={() => toggleSection("model")}
        />
        {sections.model ? (
          <div className="space-y-4 pl-1">
            <div className="space-y-2">
              <Label>Model Strategy</Label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={modelMode}
                onChange={(event) =>
                  onChangeModelMode(event.target.value as "global" | "configured" | "custom")
                }
              >
                <option value="global">Use global default model</option>
                <option value="configured">Use configured model row</option>
                <option value="custom">Use custom provider:model-id</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Each agent can run a different provider/model for council, hierarchy, and workflow execution.
              </p>
            </div>

            {modelMode === "configured" ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>Configured Model</Label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void loadModels()}
                    disabled={modelsLoading}
                  >
                    {modelsLoading ? "Loading..." : "Refresh Models"}
                  </Button>
                </div>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={hasConfiguredModelRef ? form.modelRef : ""}
                  onChange={(event) => onSelectConfiguredModel(event.target.value)}
                >
                  {activeModelOptions.length === 0 ? (
                    <option value="">No active models configured</option>
                  ) : (
                    activeModelOptions.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name} ({model.provider}/{model.modelId})
                      </option>
                    ))
                  )}
                </select>
                <p className="text-[10px] text-muted-foreground">
                  Stored as model row id: {form.modelRef || "none"}.
                </p>
              </div>
            ) : null}

            {modelMode === "custom" ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Provider</Label>
                  <Select
                    value={customModelProvider}
                    onValueChange={onCustomModelProviderChange}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Model ID</Label>
                  <Input
                    value={customModelId}
                    onChange={(event) => onCustomModelIdChange(event.target.value)}
                    placeholder="gemini-2.5-flash"
                  />
                </div>
                <div className="md:col-span-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  Runtime reference: {form.modelRef || "set provider and model id"}
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label>Workspace Path</Label>
              <Input
                value={form.workspacePath}
                onChange={(event) =>
                  setForm((current) => ({ ...current, workspacePath: event.target.value }))
                }
              />
              <p className="text-[10px] text-muted-foreground">
                Filesystem path for this agent&apos;s workspace. Leave empty to use the default.
              </p>
            </div>
          </div>
        ) : null}

        {/* Section: Budget & Limits */}
        <SectionHeader
          title="Budget & Limits"
          expanded={sections.budget}
          onToggle={() => toggleSection("budget")}
        />
        {sections.budget ? (
          <div className="rounded-md border bg-muted/20 p-3 pl-1 space-y-3">
            <BudgetGauge
              spent={selectedAgent.spentMonthlyCents ?? 0}
              cap={selectedAgent.budgetMonthlyCents ?? 0}
              isActive={selectedAgent.isActive}
            />
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Spend Cap (USD)</Label>
                <Input
                  value={form.spendCapUsd}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, spendCapUsd: event.target.value }))
                  }
                  placeholder="Leave blank for unlimited"
                />
              </div>
              <div className="space-y-2">
                <Label>Window (days)</Label>
                <Input
                  value={form.spendWindowDays}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, spendWindowDays: event.target.value }))
                  }
                  placeholder="30"
                />
              </div>
              <div className="space-y-2">
                <Label>Cap Action</Label>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={form.budgetAction}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      budgetAction: event.target.value as "warn" | "block",
                    }))
                  }
                >
                  <option value="warn">Warn only</option>
                  <option value="block">Block runs</option>
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Monthly Budget (cents)</Label>
              <Input
                value={form.budgetMonthlyCents}
                onChange={(event) =>
                  setForm((current) => ({ ...current, budgetMonthlyCents: event.target.value }))
                }
                placeholder="Leave blank to skip monthly tracking"
              />
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <div className="rounded-md border bg-background p-3">
                <div className="text-[11px] uppercase text-muted-foreground">Spent</div>
                <div className="mt-1 text-lg font-semibold">{formatUsd(selectedAgent.budgetSummary?.spentUsd ?? 0)}</div>
              </div>
              <div className="rounded-md border bg-background p-3">
                <div className="text-[11px] uppercase text-muted-foreground">Remaining</div>
                <div className="mt-1 text-lg font-semibold">{formatUsd(selectedAgent.budgetSummary?.remainingUsd ?? null)}</div>
              </div>
              <div className="rounded-md border bg-background p-3">
                <div className="text-[11px] uppercase text-muted-foreground">Calls</div>
                <div className="mt-1 text-lg font-semibold">{selectedAgent.budgetSummary?.recentCalls ?? 0}</div>
              </div>
              <div className="rounded-md border bg-background p-3">
                <div className="text-[11px] uppercase text-muted-foreground">Last Spend</div>
                <div className="mt-1 text-sm font-medium">
                  {selectedAgent.budgetSummary?.lastSpendAt
                    ? new Date(selectedAgent.budgetSummary.lastSpendAt).toLocaleString()
                    : "No spend yet"}
                </div>
              </div>
            </div>
            {selectedAgent.budgetSummary?.usagePercent !== null &&
            typeof selectedAgent.budgetSummary?.usagePercent === "number" ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Usage in current window</span>
                  <span>{selectedAgent.budgetSummary?.usagePercent?.toFixed(1)}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full ${
                      selectedAgent.budgetSummary?.overCap
                        ? "bg-red-500"
                        : selectedAgent.budgetSummary?.warningLevel === "near"
                          ? "bg-amber-500"
                          : "bg-emerald-500"
                    }`}
                    style={{ width: `${Math.min(100, selectedAgent.budgetSummary?.usagePercent || 0)}%` }}
                  />
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No cap is set. This agent can spend without a hard budget limit.
              </p>
            )}
          </div>
        ) : null}

        {/* Section: Advanced */}
        <SectionHeader
          title="Advanced"
          expanded={sections.advanced}
          onToggle={() => toggleSection("advanced")}
        />
        {sections.advanced ? (
          <div className="rounded-md border bg-muted/20 p-3 space-y-3 pl-1">
            <div>
              <div className="text-sm font-medium">Model Overrides</div>
              <p className="text-xs text-muted-foreground">
                Per-agent API key, base URL, system prompt, temperature, and token limit. Leave blank to inherit global model settings.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label>API Key Override</Label>
                <Input
                  type="password"
                  value={form.modelApiKey}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, modelApiKey: event.target.value }))
                  }
                  placeholder="Inherits global model key"
                />
              </div>
              <div className="space-y-2">
                <Label>Base URL Override</Label>
                <Input
                  value={form.modelBaseUrl}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, modelBaseUrl: event.target.value }))
                  }
                  placeholder="e.g. https://my-proxy.example.com/v1"
                />
              </div>
              <div className="space-y-2">
                <Label>Temperature (0–1)</Label>
                <Input
                  value={form.temperature}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, temperature: event.target.value }))
                  }
                  placeholder="Inherits global default"
                />
                <p className="text-[10px] text-muted-foreground">
                  Higher values produce more creative output.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Max Tokens</Label>
                <Input
                  value={form.maxTokens}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, maxTokens: event.target.value }))
                  }
                  placeholder="Inherits global default"
                />
                <p className="text-[10px] text-muted-foreground">
                  Maximum completion tokens per turn.
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <Label>System Prompt</Label>
              <textarea
                className="w-full min-h-[80px] rounded-md border bg-background px-3 py-2 text-sm resize-y"
                value={form.systemPrompt}
                onChange={(event) =>
                  setForm((current) => ({ ...current, systemPrompt: event.target.value }))
                }
                placeholder="Override system prompt for this agent. Used when no workflow node overrides it."
              />
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Overrides the default system prompt. Leave empty to use the built-in prompt.
              </p>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-5">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(event) =>
                setForm((current) => ({ ...current, isDefault: event.target.checked }))
              }
            />
            Default Agent
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(event) =>
                setForm((current) => ({ ...current, isActive: event.target.checked }))
              }
            />
            Active
          </label>
        </div>
        <div className="flex items-center justify-end">
          <Button onClick={onSaveOverview} disabled={savingOverview}>
            {savingOverview ? "Saving..." : overviewDirty ? "Save Changes" : "Saved"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RuntimeProfileRow({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "ok" | "warn" | "bad";
}) {
  const toneClass =
    tone === "ok"
      ? "border-emerald-500/20 bg-emerald-500/5"
      : tone === "bad"
        ? "border-red-500/20 bg-red-500/5"
        : "border-amber-500/20 bg-amber-500/5";
  return (
    <div className={`rounded-md border p-3 ${toneClass}`}>
      <div className="text-[11px] uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium" title={value}>{value}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{detail}</div>
    </div>
  );
}

function SectionHeader({
  title,
  expanded,
  onToggle,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium hover:bg-muted/50 transition"
    >
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
      )}
      {title}
    </button>
  );
}

function useMemoReady(
  selectedAgent: AgentRecord,
  activeModelOptions: ModelOption[],
  toolsCount: number,
  enabledTools: number,
  enabledSkillPacks: number,
  enabledExtensions: number,
  channelWorkflows: { length: number },
  connectedChannels: number,
  selectedAgentRole: AgentRole | null,
  hasChannelConfig: boolean,
  hasScheduleConfig: boolean,
): ReadinessCard[] {
  const hasModel = Boolean(selectedAgent.modelRef || activeModelOptions.length > 0);
  const hasTools = enabledTools > 0 || toolsCount === 0;
  const hasSkills = enabledSkillPacks > 0 || enabledExtensions > 0;
  const hasChannel = connectedChannels > 0 || channelWorkflows.length > 0;
  const hasRole = Boolean(selectedAgentRole);
  const budgetOk = selectedAgent.spendCapUsd === null || selectedAgent.budgetSummary?.overCap !== true;
  return [
    {
      label: "Model",
      ok: hasModel,
      detail: selectedAgent.modelRef || (hasModel ? "global fallback" : "Not set"),
    },
    {
      label: "Tools",
      ok: hasTools,
      detail: toolsCount ? `${enabledTools}/${toolsCount} toolsets` : "No tools",
    },
    {
      label: "Skills",
      ok: hasSkills,
      detail: `${enabledSkillPacks} skills, ${enabledExtensions} extensions`,
    },
    {
      label: "Channels",
      ok: hasChannelConfig,
      detail: hasChannelConfig ? "Configured" : "Not set",
    },
    {
      label: "Role",
      ok: hasRole,
      detail: selectedAgentRole?.roleTitle || selectedAgentRole?.roleType || "Unassigned",
    },
    {
      label: "Budget",
      ok: budgetOk,
      detail: selectedAgent.budgetMonthlyCents
        ? `$${selectedAgent.budgetMonthlyCents / 100}/mo`
        : selectedAgent.spendCapUsd === null
          ? "No cap"
          : formatUsd(selectedAgent.budgetSummary?.spentUsd ?? 0),
    },
  ];
}

function BudgetGauge({
  spent,
  cap,
  isActive,
}: {
  spent: number;
  cap: number;
  isActive: boolean;
}) {
  const pct = cap > 0 ? (spent / cap) * 100 : 0;
  const status = !isActive
    ? "paused"
    : pct >= 100
      ? "exhausted"
      : pct >= 80
        ? "warning"
        : "healthy";

  const config = {
    healthy: {
      color: "bg-emerald-500",
      textColor: "text-emerald-500",
      icon: ShieldCheck,
      label: "Healthy",
    },
    warning: {
      color: "bg-amber-500",
      textColor: "text-amber-500",
      icon: AlertTriangle,
      label: "Warning",
    },
    exhausted: {
      color: "bg-destructive",
      textColor: "text-destructive",
      icon: AlertCircle,
      label: "Exhausted",
    },
    paused: {
      color: "bg-muted-foreground",
      textColor: "text-muted-foreground",
      icon: PauseCircle,
      label: "Paused",
    },
  }[status];

  const StatusIcon = config.icon;

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">Monthly Budget</span>
          <Badge variant="outline" className={`text-[10px] ${config.textColor}`}>
            <StatusIcon className="mr-1 h-3 w-3 inline" />
            {config.label}
          </Badge>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-2">
        <div className="rounded border bg-muted/30 px-2 py-1.5">
          <div className="text-[10px] text-muted-foreground">Spent</div>
          <div className="text-sm font-medium">
            ${(spent / 100).toFixed(2)}
          </div>
        </div>
        <div className="rounded border bg-muted/30 px-2 py-1.5">
          <div className="text-[10px] text-muted-foreground">Budget Cap</div>
          <div className="text-sm font-medium">
            ${(cap / 100).toFixed(2)}
          </div>
        </div>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${config.color}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      {status === "paused" ? (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-xs text-destructive">
            Budget Exhausted — Agent Paused. Increase budget or wait for next cycle.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export { useMemoReady };
