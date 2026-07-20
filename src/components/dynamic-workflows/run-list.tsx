"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/empty-state";
import { RunCard } from "@/components/dynamic-workflows/run-card";
import { cn } from "@/lib/utils";
import type {
  AcceptanceMethod,
  DynamicWorkflowPlan,
  DynamicWorkflowRunRecord,
  DynamicWorkflowPhaseRecord,
  DynamicWorkflowWorkerRecord,
} from "@/lib/dynamic-workflows/types";
import { Activity, AlertTriangle, CheckCircle2, RefreshCw, Loader2, Play, ShieldCheck } from "lucide-react";
import { RunDetail } from "@/components/dynamic-workflows/run-detail";
import type { PopulatedDynamicWorkflowRun } from "@/lib/dynamic-workflows/types";
import type { ResolvedDeliveryTeam } from "@/lib/dynamic-workflows/delivery-policy";

type RunListProps = {
  className?: string;
  onViewRun?: (runId: string) => void;
};

type RunFilter = "all" | "running" | "completed" | "failed";

type ApiRun = DynamicWorkflowRunRecord & {
  phases?: DynamicWorkflowPhaseRecord[];
  workers?: DynamicWorkflowWorkerRecord[];
};

const FILTERS: Array<{ value: RunFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const FILTER_MATCHES: Record<RunFilter, (r: DynamicWorkflowRunRecord) => boolean> = {
  all: () => true,
  running: (r) => r.status === "running" || r.status === "queued" || r.status === "awaiting_approval",
  completed: (r) => r.status === "completed",
  failed: (r) => r.status === "failed" || r.status === "cancelled",
};

export function RunList({ className, onViewRun }: RunListProps) {
  const searchParams = useSearchParams();
  const [runs, setRuns] = useState<ApiRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RunFilter>("all");
  const [actionRunningId, setActionRunningId] = useState<string | null>(null);
  const [mode, setMode] = useState<"standard" | "supervised">(() => searchParams.get("mode") === "supervised" ? "supervised" : "standard");
  const [selectedRun, setSelectedRun] = useState<PopulatedDynamicWorkflowRun | null>(null);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/dynamic-workflows");
      const json = await res.json() as { success?: boolean; data?: { runs?: ApiRun[] }; error?: string };
      if (!json.success) {
        setFetchError(json.error ?? "Failed to load runs");
        setRuns([]);
        return;
      }
      setRuns(json.data?.runs ?? []);
    } catch (err) {
      setFetchError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    if (searchParams.get("mode") === "supervised") setMode("supervised");
  }, [searchParams]);

  const handleApiAction = async (
    runId: string,
    action: "pause" | "resume" | "cancel"
  ) => {
    setActionRunningId(runId);
    try {
      const res = await fetch(`/api/dynamic-workflows/${encodeURIComponent(runId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, runId }),
      });
      const json = await res.json() as { success?: boolean; error?: string };
      if (json.success) {
        fetchRuns();
      }
    } catch {
      // best effort on UI action
    } finally {
      setActionRunningId(null);
    }
  };

  const viewRun = useCallback(async (runId: string) => {
    if (onViewRun) {
      onViewRun(runId);
      return;
    }
    const response = await fetch(`/api/dynamic-workflows/${encodeURIComponent(runId)}`);
    const json = await response.json() as { success?: boolean; data?: PopulatedDynamicWorkflowRun };
    if (json.success && json.data) setSelectedRun(json.data);
  }, [onViewRun]);

  useEffect(() => {
    const requestedRun = String(searchParams.get("run") || "").trim();
    if (requestedRun) void viewRun(requestedRun);
  }, [searchParams, viewRun]);

  const filteredRuns = runs.filter((r) => FILTER_MATCHES[filter](r));

  const filterCounts: Record<RunFilter, number> = {
    all: runs.length,
    running: runs.filter(FILTER_MATCHES.running).length,
    completed: runs.filter(FILTER_MATCHES.completed).length,
    failed: runs.filter(FILTER_MATCHES.failed).length,
  };

  if (selectedRun) {
    return (
      <RunDetail
        run={selectedRun}
        onBack={() => { setSelectedRun(null); void fetchRuns(); }}
        onPause={() => void handleApiAction(selectedRun.id, "pause").then(() => viewRun(selectedRun.id))}
        onResume={() => void handleApiAction(selectedRun.id, "resume").then(() => viewRun(selectedRun.id))}
        onCancel={() => void handleApiAction(selectedRun.id, "cancel").then(() => viewRun(selectedRun.id))}
      />
    );
  }

  return (
    <div className={cn("space-y-4", className)} data-testid="dynamic-runs-console">
      <section className="hud-frame border border-terminal-red/40 bg-card/30" data-perf-ready="dynamic-runs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-3">
          <div className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center border border-terminal-red bg-terminal-red text-white"><Activity className="h-4 w-4"/></span><div><h2 className="font-display text-sm font-semibold uppercase">Delivery mission control</h2><p className="text-[10px] text-muted-foreground">Plan, implementation, independent review, and persisted proof.</p></div></div>
          <div className="flex border border-border p-0.5" role="group" aria-label="Run mode">
            {(["standard", "supervised"] as const).map((value) => (
              <button key={value} type="button" className={cn("min-h-8 px-3 font-display text-xs uppercase", mode === value ? "bg-terminal-red text-white" : "text-muted-foreground hover:text-foreground")} onClick={() => setMode(value)}>{value === "standard" ? "Runs" : "Supervised"}</button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4">
          <div className="border-b p-3 sm:border-b-0 sm:border-r"><p className="font-display text-2xl text-terminal-red">{filterCounts.running}</p><p className="mt-0.5 flex items-center gap-1 font-mono text-[9px] text-muted-foreground"><Activity className="h-3 w-3"/>active</p></div>
          <div className="border-b p-3 sm:border-b-0 sm:border-r"><p className="font-display text-2xl">{filterCounts.completed}</p><p className="mt-0.5 flex items-center gap-1 font-mono text-[9px] text-muted-foreground"><CheckCircle2 className="h-3 w-3"/>verified</p></div>
          <div className="border-r p-3"><p className="font-display text-2xl">{filterCounts.failed}</p><p className="mt-0.5 flex items-center gap-1 font-mono text-[9px] text-muted-foreground"><AlertTriangle className="h-3 w-3"/>needs action</p></div>
          <div className="p-3"><p className="font-display text-2xl">{filterCounts.all}</p><p className="mt-0.5 font-mono text-[9px] text-muted-foreground">total missions</p></div>
        </div>
      </section>

      {mode === "supervised" ? (
        <SupervisedRunComposer onCreated={() => { setMode("standard"); void fetchRuns(); }} />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-y py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map(({ value, label }) => (
            <button key={value} type="button" className={cn("border px-2.5 py-1 font-mono text-[10px] transition-colors", filter === value ? "border-terminal-red bg-terminal-red text-white" : "border-border text-muted-foreground hover:border-terminal-red hover:text-foreground")} onClick={() => setFilter(value)}>{label}{filterCounts[value] > 0 ? ` ${filterCounts[value]}` : ""}</button>
          ))}
        </div>
        <Button variant="outline" size="sm" className="h-7" onClick={fetchRuns} disabled={loading}><RefreshCw className={cn("mr-1 h-3 w-3", loading && "animate-spin")}/>Refresh</Button>
      </div>

      {/* Loading */}
      {loading && runs.length === 0 ? (
        <div className="flex min-h-[180px] items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading dynamic runs...
        </div>
      ) : fetchError ? (
        <EmptyState
          title="Could not load runs"
          description={fetchError}
          action={
            <Button variant="outline" onClick={fetchRuns}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          }
        />
      ) : filteredRuns.length === 0 ? (
        <EmptyState
          title={
            runs.length === 0
              ? "No dynamic workflow runs yet"
              : `No ${filter} runs`
          }
          description={
            runs.length === 0
              ? "Start one from WebChat or use a harness template."
              : "Adjust the filter to see other runs."
          }
          action={
            runs.length === 0 ? (
              <Button variant="outline" onClick={fetchRuns}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {filteredRuns.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              onView={viewRun}
              onPause={
                actionRunningId === run.id ? undefined : (id) => handleApiAction(id, "pause")
              }
              onResume={
                actionRunningId === run.id ? undefined : (id) => handleApiAction(id, "resume")
              }
              onCancel={
                actionRunningId === run.id ? undefined : (id) => handleApiAction(id, "cancel")
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

type AgentChoice = {
  id: string;
  name: string;
  modelRef: string | null;
  workspacePath: string;
  resolvedWorkspacePath?: string;
  enabledToolsets: string[];
  isDefault: boolean;
  isActive: boolean;
  effectiveProvider?: string;
  effectiveModel?: string;
  estimatedPriceClass?: "economy" | "standard" | "premium" | "unknown";
  runtimeKind?: "local" | "remote";
  callable?: boolean;
};

type OrganizationChoice = {
  id: string;
  name: string;
  memberCount: number;
  isActive: boolean;
};

function SupervisedRunComposer({ onCreated }: { onCreated: () => void }) {
  const searchParams = useSearchParams();
  const [agents, setAgents] = useState<AgentChoice[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationChoice[]>([]);
  const [teamSelection, setTeamSelection] = useState("auto");
  const [resolution, setResolution] = useState<ResolvedDeliveryTeam | null>(null);
  const [resolving, setResolving] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [advancedDirty, setAdvancedDirty] = useState(false);
  const [objective, setObjective] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [criteriaText, setCriteriaText] = useState("");
  const [plannerId, setPlannerId] = useState("");
  const [implementerId, setImplementerId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [plannerModel, setPlannerModel] = useState("");
  const [implementerModel, setImplementerModel] = useState("");
  const [reviewerModel, setReviewerModel] = useState("");
  const [commandsText, setCommandsText] = useState("");
  const [maxRepairPasses, setMaxRepairPasses] = useState(1);
  const [budget, setBudget] = useState("1.00");
  const [submitting, setSubmitting] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [plannedPlan, setPlannedPlan] = useState<DynamicWorkflowPlan | null>(null);
  const [error, setError] = useState("");

  const resolveTeam = useCallback(async (selection: string) => {
    setResolving(true);
    setError("");
    try {
      const organizationId = selection.startsWith("org:") ? selection.slice(4) : null;
      const selectedAgentId = selection.startsWith("agent:") ? selection.slice(6) : null;
      const response = await fetch("/api/dynamic-workflows/resolve-delivery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, selectedAgentId }),
      });
      const json = await response.json() as { success?: boolean; data?: ResolvedDeliveryTeam; error?: string | Record<string, unknown> };
      if (!response.ok || !json.success || !json.data) throw new Error(typeof json.error === "string" ? json.error : "Could not resolve the delivery team.");
      const next = json.data;
      setResolution(next);
      setPlannerId(next.planner.agentId);
      setImplementerId(next.implementer.agentId);
      setReviewerId(next.reviewer.agentId);
      setPlannerModel(next.planner.modelRef);
      setImplementerModel(next.implementer.modelRef);
      setReviewerModel(next.reviewer.modelRef);
      setWorkspaceRoot(next.workspaceRoot);
      setAdvancedDirty(false);
    } catch (cause) {
      setResolution(null);
      setError(String(cause));
    } finally {
      setResolving(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      fetch("/api/agents").then((response) => response.json()),
      fetch("/api/hierarchy/organizations").then((response) => response.json()),
    ]).then(async ([agentJson, organizationJson]) => {
      const active = ((agentJson.data?.agents || []) as AgentChoice[]).filter((agent) => agent.isActive);
      const next = await Promise.all(active.map(async (agent) => {
        try {
          const response = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/runtime-profile`);
          const profile = (await response.json()).data as {
            effectiveProvider?: string; effectiveModel?: string; estimatedPriceClass?: AgentChoice["estimatedPriceClass"];
            runtimeKind?: AgentChoice["runtimeKind"]; providerHealth?: string; toolCallSupport?: boolean;
          } | undefined;
          return { ...agent, ...profile, callable: response.ok && profile?.providerHealth !== "error" && profile?.toolCallSupport !== false && profile?.effectiveModel !== "none configured" };
        } catch {
          return { ...agent, callable: false };
        }
      }));
      setAgents(next);
      setOrganizations((organizationJson.data?.organizations || []) as OrganizationChoice[]);
      const requestedOrganization = String(searchParams.get("org") || "").trim();
      const requestedAgent = String(searchParams.get("agent") || "").trim();
      const initialSelection = requestedOrganization ? `org:${requestedOrganization}` : requestedAgent ? `agent:${requestedAgent}` : "auto";
      setTeamSelection(initialSelection);
      await resolveTeam(initialSelection);
    }).catch(() => {
      setResolving(false);
      setError("Could not load configured agents and organizations.");
    });
  }, [resolveTeam, searchParams]);

  const selected = (id: string) => agents.find((agent) => agent.id === id);
  const criteria = criteriaText.split("\n").map((value) => value.trim()).filter(Boolean);
  const commands = commandsText.split("\n").map((value) => value.trim()).filter(Boolean);
  const canPlan = Boolean(objective.trim() && workspaceRoot.trim() && plannerId && implementerId && reviewerId);
  const valid = Boolean(plannedPlan && plannedPlan.acceptanceContract?.length);
  const setupLocked = Boolean(plannedPlan);
  const supervision = {
    version: 1 as const,
    mode: "supervised" as const,
    planner: { agentId: plannerId, modelRef: plannerModel.trim() || undefined },
    implementer: { agentId: implementerId, modelRef: implementerModel.trim() || undefined },
    reviewer: { agentId: reviewerId, modelRef: reviewerModel.trim() || undefined },
    maxRepairPasses,
    requireHumanApprovalBeforePublish: true,
  };

  const generate = async () => {
    if (!canPlan) return;
    setPlanning(true);
    setPlannedPlan(null);
    setError("");
    try {
      const response = await fetch("/api/dynamic-workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "plan_supervised",
          prompt: objective.trim(),
          workspaceRoot: workspaceRoot.trim(),
          initialCriteria: criteria,
          verificationCommands: commands,
          supervision,
          limits: { maxConcurrency: 1, maxWorkers: 8, maxRuntimeSeconds: 600, budgetLimitUsd: Number(budget) || 1 },
        }),
      });
      const json = await response.json() as { success?: boolean; data?: { plan?: DynamicWorkflowPlan }; error?: string };
      if (!response.ok || !json.success || !json.data?.plan) throw new Error(json.error || "Planner could not create a contract.");
      setPlannedPlan(json.data.plan);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPlanning(false);
    }
  };

  const updateCriterion = (index: number, update: Partial<NonNullable<DynamicWorkflowPlan["acceptanceContract"]>[number]>) => {
    setPlannedPlan((current) => {
      if (!current?.acceptanceContract) return current;
      const acceptanceContract = current.acceptanceContract.map((criterion, criterionIndex) =>
        criterionIndex === index ? { ...criterion, ...update } : criterion,
      );
      return { ...current, acceptanceContract, acceptanceCriteria: acceptanceContract.map((criterion) => criterion.statement) };
    });
  };

  const start = async () => {
    if (!valid || !plannedPlan) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/dynamic-workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_run",
          approve: true,
          name: objective.trim().slice(0, 120),
          sourceType: "manual",
          sourceRef: "workflows:supervised",
          managerAgentId: plannerId,
          organizationId: resolution?.organizationId || undefined,
          goalId: String(searchParams.get("goal") || "").trim() || undefined,
          plan: plannedPlan,
        }),
      });
      const json = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !json.success) throw new Error(json.error || "Run could not start.");
      onCreated();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="border-y border-border bg-muted/10 px-3 py-4" aria-labelledby="supervised-run-title">
      <div className="mb-4 flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 text-terminal-red" />
        <div>
          <h3 id="supervised-run-title" className="font-display text-sm uppercase">Configure supervised run</h3>
          <p className="text-xs text-muted-foreground">Choose the roles first. The planning model drafts the contract; review it before execution.</p>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-3 border border-terminal-red/30 bg-background p-3 lg:col-span-2">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
            <label className="space-y-1">
              <span className="data-label">Delivery team</span>
              <select disabled={setupLocked || resolving} className="h-9 w-full border bg-background px-2 text-sm focus:border-terminal-red focus:outline-none disabled:cursor-not-allowed disabled:opacity-60" value={teamSelection} onChange={(event) => { const value = event.target.value; setTeamSelection(value); void resolveTeam(value); }}>
                <option value="auto">Automatic · active hierarchy</option>
                {organizations.map((organization) => <option key={organization.id} value={`org:${organization.id}`}>{organization.name} · {organization.memberCount} members</option>)}
                {agents.map((agent) => <option key={agent.id} value={`agent:${agent.id}`}>{agent.name} · selected implementer</option>)}
              </select>
            </label>
            <Button type="button" size="sm" variant="outline" disabled={setupLocked} asChild><a href="/settings?tab=models#delivery-policy">Change policy</a></Button>
            <Button type="button" size="sm" variant="outline" disabled={setupLocked || resolving} onClick={() => setAdvanced((value) => !value)}>{advanced ? "Hide advanced" : "Advanced"}</Button>
          </div>
          {resolving ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Resolving team</div> : resolution ? (
            <>
              <div className="grid border md:grid-cols-3">
                {([ ["Planner", resolution.planner], ["Implementer", resolution.implementer], ["Reviewer", resolution.reviewer] ] as const).map(([label, role]) => (
                  <div key={label} className="border-b p-2 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
                    <p className="data-label">{label}</p>
                    <p className="mt-1 text-xs">{advancedDirty ? selected(label === "Planner" ? plannerId : label === "Implementer" ? implementerId : reviewerId)?.name || role.agentName : role.agentName}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{advancedDirty ? (label === "Planner" ? plannerModel : label === "Implementer" ? implementerModel : reviewerModel) || "agent default" : `${role.provider}/${role.modelId}`}</p>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground">
                <span>policy: {resolution.policy.mode.replaceAll("_", " ")}</span>
                <span>·</span>
                <span>{resolution.sharedModelMode && !advancedDirty ? "shared-model mode" : "role-specific models"}</span>
                {resolution.organizationName ? <><span>·</span><span>org: {resolution.organizationName}</span></> : null}
              </div>
              {resolution.warnings.map((warning) => <p key={warning} className="border-l-2 border-terminal-red pl-2 text-xs text-muted-foreground">{warning}</p>)}
            </>
          ) : null}
        </div>
        <label className="space-y-1 lg:col-span-2">
          <span className="data-label">Objective</span>
          <textarea disabled={setupLocked} className="min-h-20 w-full border bg-background px-3 py-2 text-sm focus:border-terminal-red focus:outline-none disabled:cursor-not-allowed disabled:opacity-60" value={objective} onChange={(event) => setObjective(event.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="data-label">Confirmed workspace root</span>
          <input disabled={setupLocked} className="h-9 w-full border bg-background px-3 font-mono text-xs focus:border-terminal-red focus:outline-none disabled:cursor-not-allowed disabled:opacity-60" value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="data-label">Requested constraints, one per line (optional)</span>
          <textarea disabled={setupLocked} className="min-h-20 w-full border bg-background px-3 py-2 text-xs focus:border-terminal-red focus:outline-none disabled:cursor-not-allowed disabled:opacity-60" value={criteriaText} onChange={(event) => setCriteriaText(event.target.value)} />
        </label>
        {advanced ? ([ ["Planner", plannerId, setPlannerId, plannerModel, setPlannerModel], ["Implementer", implementerId, setImplementerId, implementerModel, setImplementerModel], ["Reviewer", reviewerId, setReviewerId, reviewerModel, setReviewerModel] ] as const).map(([label, value, setValue, model, setModel]) => (
          <div key={label} className="space-y-1 border-l-2 border-terminal-red/50 pl-2">
            <span className="data-label">{label}</span>
            <select disabled={setupLocked} className="h-9 w-full border bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60" value={value} onChange={(event) => { setValue(event.target.value); setAdvancedDirty(true); if (label === "Implementer") { const agent = selected(event.target.value); setWorkspaceRoot(agent?.resolvedWorkspacePath || agent?.workspacePath || workspaceRoot); } }}>
              <option value="">Select agent</option>
              {agents.map((agent) => <option key={`${label}-${agent.id}`} value={agent.id}>{agent.name} · {agent.effectiveProvider || "unknown"}/{agent.effectiveModel || agent.modelRef || "app default"} · {agent.enabledToolsets.length} toolsets</option>)}
            </select>
            <input disabled={setupLocked} className="h-8 w-full border bg-background px-2 font-mono text-[11px] disabled:cursor-not-allowed disabled:opacity-60" placeholder="Explicit model ref for this run" value={model} onChange={(event) => { setModel(event.target.value); setAdvancedDirty(true); }} />
          </div>
        )) : null}
        <label className="space-y-1">
          <span className="data-label">Verification commands, one per line</span>
          <textarea disabled={setupLocked} className="min-h-20 w-full border bg-background px-3 py-2 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-60" value={commandsText} onChange={(event) => setCommandsText(event.target.value)} placeholder="pnpm.cmd exec tsc --noEmit" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1"><span className="data-label">Repair passes</span><input disabled={setupLocked} type="number" min={0} max={2} className="h-9 w-full border bg-background px-2 disabled:cursor-not-allowed disabled:opacity-60" value={maxRepairPasses} onChange={(event) => setMaxRepairPasses(Math.max(0, Math.min(2, Number(event.target.value))))} /></label>
          <label className="space-y-1"><span className="data-label">Budget USD</span><input disabled={setupLocked} inputMode="decimal" className="h-9 w-full border bg-background px-2 disabled:cursor-not-allowed disabled:opacity-60" value={budget} onChange={(event) => setBudget(event.target.value)} /></label>
        </div>
      </div>
      {plannedPlan?.planning ? (
        <div className="mt-4 space-y-3 border border-terminal-red/40 bg-background p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="data-label">Planner contract</p>
              <p className="mt-1 text-sm">{plannedPlan.planning.summary}</p>
            </div>
            <span className="font-mono text-[10px] text-muted-foreground">{plannedPlan.planning.provider}/{plannedPlan.planning.modelId}</span>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <p className="data-label mb-1">Implementation</p>
              <ol className="space-y-1 text-xs text-muted-foreground">
                {plannedPlan.planning.implementationSteps.map((step, index) => <li key={`${index}-${step}`}>{index + 1}. {step}</li>)}
              </ol>
            </div>
            <div>
              <p className="data-label mb-1">Risks</p>
              {plannedPlan.planning.risks.length ? <ul className="space-y-1 text-xs text-muted-foreground">{plannedPlan.planning.risks.map((risk) => <li key={risk}>- {risk}</li>)}</ul> : <p className="text-xs text-muted-foreground">No material risks identified.</p>}
            </div>
          </div>
          <div className="space-y-2">
            <p className="data-label">Editable acceptance contract</p>
            {plannedPlan.acceptanceContract?.map((criterion, index) => (
              <div key={criterion.id} className="grid gap-2 border-l-2 border-terminal-red/50 pl-2 md:grid-cols-[1fr_auto_auto]">
                <input aria-label={`${criterion.id} statement`} className="h-9 border bg-background px-2 text-xs" value={criterion.statement} onChange={(event) => updateCriterion(index, { statement: event.target.value })} />
                <label className="flex h-9 items-center gap-1.5 border px-2 font-mono text-[10px]"><input type="checkbox" checked={criterion.required} onChange={(event) => updateCriterion(index, { required: event.target.checked })} />required</label>
                <select aria-label={`${criterion.id} method`} className="h-9 border bg-background px-2 font-mono text-[10px]" value={criterion.methods[0]} onChange={(event) => updateCriterion(index, { methods: [event.target.value as AcceptanceMethod] })}>
                  {(["review", "command", "browser", "artifact", "citation", "human"] as AcceptanceMethod[]).map((method) => <option key={method}>{method}</option>)}
                </select>
              </div>
            ))}
          </div>
          {plannedPlan.verification?.commands?.length ? <div><p className="data-label mb-1">Proposed commands</p><pre className="overflow-x-auto border bg-muted/20 p-2 font-mono text-[10px]">{plannedPlan.verification.commands.join("\n")}</pre></div> : null}
        </div>
      ) : null}
      {error ? <p className="mt-3 border-l-2 border-terminal-red pl-2 text-xs text-terminal-red" role="alert">{error}</p> : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {plannedPlan ? <Button variant="outline" disabled={planning || submitting} onClick={() => setPlannedPlan(null)}>Edit setup</Button> : null}
        <Button variant="outline" disabled={!canPlan || planning || submitting || setupLocked} onClick={() => void generate()}>{planning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}{planning ? "Planning" : "Generate contract"}</Button>
        <Button disabled={!valid || submitting || planning} onClick={() => void start()}><Play className="mr-2 h-4 w-4" />{submitting ? "Starting" : "Approve and start"}</Button>
      </div>
    </section>
  );
}
