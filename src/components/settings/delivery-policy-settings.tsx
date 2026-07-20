"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type {
  DeliveryModelOption,
  DeliveryPolicy,
  DeliveryPolicyMode,
  ResolvedDeliveryTeam,
} from "@/lib/dynamic-workflows/delivery-policy";

type PolicyPayload = {
  policy: DeliveryPolicy;
  models: DeliveryModelOption[];
  resolution: ResolvedDeliveryTeam | null;
  resolutionError?: string | null;
};

const MODE_LABELS: Record<DeliveryPolicyMode, string> = {
  agent_defaults: "Agent defaults",
  balanced: "Balanced",
  quality: "Quality",
  fast: "Fast prototype",
  local: "Local/private",
  custom: "Custom roles",
};

const MODE_HELP: Record<DeliveryPolicyMode, string> = {
  agent_defaults: "Keep each selected agent's model, then fall back to the app default.",
  balanced: "Use a stronger planner and reviewer with the fastest economical implementer.",
  quality: "Prefer the strongest configured model for all three roles.",
  fast: "Prefer the fastest configured model for all three roles.",
  local: "Keep all roles on callable local models when available.",
  custom: "Pin an exact configured model to each supervised-delivery role.",
};

export function DeliveryPolicySettings() {
  const [policy, setPolicy] = useState<DeliveryPolicy | null>(null);
  const [models, setModels] = useState<DeliveryModelOption[]>([]);
  const [resolution, setResolution] = useState<ResolvedDeliveryTeam | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const applyPayload = (payload: PolicyPayload) => {
    setPolicy(payload.policy);
    setModels(payload.models);
    setResolution(payload.resolution);
    setError(payload.resolutionError || "");
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/delivery-policy");
      const json = await response.json() as { success?: boolean; data?: PolicyPayload; error?: string };
      if (!response.ok || !json.success || !json.data) throw new Error(json.error || "Could not load delivery policy.");
      applyPayload(json.data);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setMode = (mode: DeliveryPolicyMode) => {
    setPolicy((current) => {
      if (!current) return current;
      if (mode !== "custom") return { ...current, mode };
      return {
        ...current,
        mode,
        plannerModelRef: current.plannerModelRef || resolution?.planner.modelRef || models.find((model) => model.callable)?.id || null,
        implementerModelRef: current.implementerModelRef || resolution?.implementer.modelRef || models.find((model) => model.callable)?.id || null,
        reviewerModelRef: current.reviewerModelRef || resolution?.reviewer.modelRef || models.find((model) => model.callable)?.id || null,
      };
    });
    setNotice("");
  };

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/delivery-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(policy),
      });
      const json = await response.json() as { success?: boolean; data?: PolicyPayload; error?: string | Record<string, unknown> };
      if (!response.ok || !json.success || !json.data) throw new Error(typeof json.error === "string" ? json.error : "Could not save delivery policy.");
      applyPayload(json.data);
      setNotice("Supervised delivery policy saved.");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  const callableModels = models.filter((model) => model.callable);
  const roleRows = resolution ? [
    ["Planner", resolution.planner],
    ["Implementer", resolution.implementer],
    ["Reviewer", resolution.reviewer],
  ] as const : [];

  return (
    <section id="delivery-policy" className="border-y border-terminal-red/30 bg-muted/10 py-4" aria-labelledby="delivery-policy-title">
      <div className="flex flex-wrap items-start justify-between gap-3 px-1">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 text-terminal-red" />
          <div>
            <h3 id="delivery-policy-title" className="font-display text-sm uppercase">Supervised delivery policy</h3>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">Models are chosen here. Hierarchy chooses the people; Workflows applies both and shows the resolved team before a run starts.</p>
          </div>
        </div>
        {resolution?.sharedModelMode ? <Badge variant="outline">shared-model mode</Badge> : <Badge variant="outline">multi-model</Badge>}
      </div>

      {loading || !policy ? (
        <div className="flex items-center gap-2 px-1 py-5 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading policy</div>
      ) : (
        <div className="mt-4 space-y-4 px-1">
          <div className="grid gap-3 md:grid-cols-[minmax(0,240px)_1fr_auto] md:items-end">
            <label className="space-y-1">
              <span className="data-label">Default policy</span>
              <select className="h-9 w-full border bg-background px-2 text-sm focus:border-terminal-red focus:outline-none" value={policy.mode} onChange={(event) => setMode(event.target.value as DeliveryPolicyMode)}>
                {Object.entries(MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">{MODE_HELP[policy.mode]}</p>
            <Button onClick={() => void save()} disabled={saving || (policy.mode === "custom" && callableModels.length === 0)}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save policy</Button>
          </div>

          {policy.mode === "custom" ? (
            <div className="grid gap-2 md:grid-cols-3">
              {(["planner", "implementer", "reviewer"] as const).map((role) => {
                const key = `${role}ModelRef` as "plannerModelRef" | "implementerModelRef" | "reviewerModelRef";
                return (
                  <label key={role} className="space-y-1 border-l-2 border-terminal-red/50 pl-2">
                    <span className="data-label">{role}</span>
                    <select className="h-9 w-full border bg-background px-2 text-xs focus:border-terminal-red focus:outline-none" value={policy[key] || ""} onChange={(event) => setPolicy({ ...policy, [key]: event.target.value || null })}>
                      <option value="">Select model</option>
                      {callableModels.map((model) => <option key={`${role}-${model.id}`} value={model.id}>{model.name} · {model.provider}/{model.modelId} · {model.priceClass}</option>)}
                    </select>
                  </label>
                );
              })}
            </div>
          ) : null}

          {roleRows.length ? (
            <div className="grid border md:grid-cols-3">
              {roleRows.map(([label, role]) => (
                <div key={label} className="border-b p-3 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
                  <p className="data-label">{label}</p>
                  <p className="mt-1 text-sm">{role.agentName}</p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground" title={`${role.provider}/${role.modelId}`}>{role.provider}/{role.modelId}</p>
                </div>
              ))}
            </div>
          ) : null}
          {callableModels.length === 1 ? <p className="border-l-2 border-terminal-red pl-2 text-xs text-muted-foreground">Only one callable model is configured. Planner, implementer, and reviewer are automatically pinned to it; role prompts and verification remain separate.</p> : null}
          {notice ? <p className="text-xs text-foreground" role="status">{notice}</p> : null}
          {error ? <p className="text-xs text-terminal-red" role="alert">{error}</p> : null}
        </div>
      )}
    </section>
  );
}
