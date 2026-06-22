"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  RefreshCw,
  DollarSign,
  Zap,
  BarChart3,
  TrendingUp,
} from "lucide-react";
import { usePolling } from "@/lib/client/use-polling";
import { useAfterUseful } from "@/lib/client/use-after-useful";

// ── Metrics types ────────────────────────────────────────────────────────────
type MetricSummary = {
  apiCallsToday: number;
  tokensToday: number;
  costTodayUsd: number;
  apiCallsPeriod: number;
  tokensPeriod: number;
  costPeriodUsd: number;
  avgCostPerCallUsd: number;
  avgTokensPerCall: number;
  successRate: number;
  executions: {
    total: number;
    completed: number;
    failed: number;
  };
  budget: {
    dailyUsd: number;
    usedUsd: number;
    usedPercent: number;
  };
};

type DayPoint = {
  day: string;
  calls: number;
  tokens: number;
  costUsd: number;
};

type MetricItem = {
  key: string;
  calls: number;
  tokens: number;
  costUsd: number;
};

type MetricsPayload = {
  generatedAt: string;
  days: number;
  summary: MetricSummary;
  series: DayPoint[];
  providers: MetricItem[];
  models: MetricItem[];
  workflows: MetricItem[];
};

// ── Cost types ───────────────────────────────────────────────────────────────
type AgentCostSummary = {
  agentId: string;
  totalCostUsd: number;
  totalTokens: number;
  eventCount: number;
  lastSpendAt: string | null;
};

type CostAnalytics = {
  totalCostUsd: number;
  totalTokens: number;
  eventCount: number;
  byAgent: AgentCostSummary[];
  byGoal: Array<{ goalId: string; costUsd: number; tokens: number; calls: number }>;
  byDay: Array<{ date: string; costUsd: number; tokens: number }>;
};

type AgentsResponse =
  | { success: boolean; data?: Array<{ id: string; name: string }>; error?: string }
  | { success: boolean; data?: { agents?: Array<{ id: string; name: string }> }; error?: string };

// ── Defaults ─────────────────────────────────────────────────────────────────
const EMPTY_METRICS: MetricsPayload = {
  generatedAt: new Date(0).toISOString(),
  days: 14,
  summary: {
    apiCallsToday: 0,
    tokensToday: 0,
    costTodayUsd: 0,
    apiCallsPeriod: 0,
    tokensPeriod: 0,
    costPeriodUsd: 0,
    avgCostPerCallUsd: 0,
    avgTokensPerCall: 0,
    successRate: 0,
    executions: { total: 0, completed: 0, failed: 0 },
    budget: { dailyUsd: 50, usedUsd: 0, usedPercent: 0 },
  },
  series: [],
  providers: [],
  models: [],
  workflows: [],
};

const COST_PRESETS = [
  { label: "MTD", getDays: () => new Date().getDate() },
  { label: "7D", getDays: () => 7 },
  { label: "30D", getDays: () => 30 },
  { label: "90D", getDays: () => 90 },
  { label: "ALL", getDays: () => 365 },
];

type Tab = "overview" | "costs";
const METRICS_UI_STATE_KEY = "disp8ch:metrics-ui-state";

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatInt(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function fmtUsdPrecise(v: number) {
  return `$${v.toFixed(v < 0.001 ? 6 : 4)}`;
}

function fmtTokens(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(v);
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function MetricsPage() {
  const [tab, setTab] = useState<Tab>("overview");

  // ── Metrics state ──
  const [metrics, setMetrics] = useState<MetricsPayload | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);

  // ── Cost state ──
  const [costPreset, setCostPreset] = useState(2);
  const [costData, setCostData] = useState<CostAnalytics | null>(null);
  const [costLoading, setCostLoading] = useState(false);
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});
  const [goalNames, setGoalNames] = useState<Record<string, string>>({});
  const [hideGettingStarted, setHideGettingStarted] = useState(false);

  // ── Metrics loader ──
  const loadMetrics = useCallback(async () => {
    try {
      const response = await fetch("/api/metrics?days=14");
      const json = await response.json();
      if (json.success && json.data) {
        setMetrics(json.data as MetricsPayload);
      }
    } catch {
      // no-op
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  // ── Cost loader ──
  const loadCosts = useCallback(async () => {
    setCostLoading(true);
    try {
      const days = COST_PRESETS[costPreset].getDays();
      const [costsRes, agentsRes] = await Promise.all([
        fetch(`/api/costs?action=analytics&windowDays=${days}`),
        fetch("/api/agents"),
      ]);
      const costsJson = (await costsRes.json()) as { success: boolean; data: CostAnalytics };
      if (costsJson.success) setCostData(costsJson.data);

      if (agentsRes.ok) {
        const agentsJson = (await agentsRes.json()) as AgentsResponse;
        if (agentsJson.success) {
          const agentRows = Array.isArray(agentsJson.data)
            ? agentsJson.data
            : agentsJson.data?.agents ?? [];
          const map: Record<string, string> = {};
          for (const a of agentRows) map[a.id] = a.name;
          setAgentNames(map);
        }
      }

      try {
        const hRes = await fetch("/api/agents/roles?action=organizations");
        if (hRes.ok) {
          const hJson = (await hRes.json()) as {
            success: boolean;
            data: Array<{
              id: string;
              name: string;
              goals?: Array<{ id: string; name: string }>;
            }>;
          };
          if (hJson.success) {
            const gmap: Record<string, string> = {};
            for (const org of hJson.data) {
              for (const g of org.goals ?? []) gmap[g.id] = g.name;
            }
            setGoalNames(gmap);
          }
        }
      } catch {
        /* goals are optional */
      }
    } finally {
      setCostLoading(false);
    }
  }, [costPreset]);

  useAfterUseful(() => { void loadMetrics(); }, [loadMetrics]);

  usePolling(
    async () => { await loadMetrics(); },
    [loadMetrics],
    { intervalMs: 10000, enabled: true, pauseWhenHidden: true, backoffOnError: true, immediate: false },
  );

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(METRICS_UI_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
      setHideGettingStarted(Boolean(parsed.hideGettingStarted));
    } catch {
      // localStorage is optional; ignore malformed state.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(METRICS_UI_STATE_KEY, JSON.stringify({ hideGettingStarted }));
    } catch {
      // localStorage is optional.
    }
  }, [hideGettingStarted]);

  useAfterUseful(() => {
    void loadCosts();
  }, [loadCosts]);

  const resolvedMetrics = metrics ?? EMPTY_METRICS;
  const hasAnyUsageData =
    resolvedMetrics.summary.apiCallsPeriod > 0 ||
    resolvedMetrics.summary.executions.total > 0 ||
    resolvedMetrics.providers.length > 0 ||
    resolvedMetrics.models.length > 0 ||
    resolvedMetrics.workflows.length > 0;

  const maxDailyCost = useMemo(
    () => Math.max(1, ...resolvedMetrics.series.map((point) => point.costUsd)),
    [resolvedMetrics.series],
  );

  const maxDailyTokens = useMemo(
    () => Math.max(1, ...resolvedMetrics.series.map((point) => point.tokens)),
    [resolvedMetrics.series],
  );

  const avgCostPerEvent =
    costData && costData.eventCount > 0 ? costData.totalCostUsd / costData.eventCount : 0;

  const costStatCards = [
    { icon: DollarSign, label: "TOTAL COST", value: costData ? fmtUsdPrecise(costData.totalCostUsd) : "—" },
    { icon: Zap, label: "TOTAL TOKENS", value: costData ? fmtTokens(costData.totalTokens) : "—" },
    { icon: BarChart3, label: "TOTAL EVENTS", value: costData ? String(costData.eventCount) : "—" },
    { icon: TrendingUp, label: "AVG / EVENT", value: costData ? fmtUsdPrecise(avgCostPerEvent) : "—" },
  ];

  return (
        <main className="flex-1 overflow-auto p-6" data-perf-ready="metrics">
          {/* ── Header + Tabs ── */}
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">Metrics & Costs</h1>
              <p className="text-sm text-muted-foreground">
                API usage, token throughput, spend trends, and cost breakdowns.
              </p>
            </div>
            <Badge variant="outline">
              {metricsLoading
                ? "Refreshing..."
                : metrics
                  ? `Updated ${new Date(metrics.generatedAt).toLocaleTimeString()}`
                  : "No data yet"}
            </Badge>
          </div>

          {/* Tab bar */}
          <div className="mb-6 flex gap-1 border-b border-border pb-px">
            {(
              [
                { key: "overview" as Tab, label: "Overview" },
                { key: "costs" as Tab, label: "Cost Analysis" },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={cn(
                  "px-4 py-2 text-xs font-mono uppercase tracking-widest transition-colors border-b-2 -mb-px",
                  tab === key
                    ? "border-terminal-red text-terminal-red"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* ═══════════════════════ OVERVIEW TAB ═══════════════════════ */}
          {tab === "overview" && (
            <>
              {!metricsLoading && !hasAnyUsageData ? (
                hideGettingStarted ? (
                  <div className="mb-6 flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2">
                    <p className="text-sm text-muted-foreground">No metrics usage recorded yet.</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setHideGettingStarted(false)}
                    >
                      Show Tips
                    </Button>
                  </div>
                ) : (
                  <div className="mb-6 rounded-md border bg-muted/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                          Getting Started
                        </div>
                        <p className="mt-2 text-sm font-medium">Metrics populate after model calls and workflow executions.</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          Provider, model, workflow, token, and spend rows remain empty until the runtime records usage events.
                          Run a workflow or WebChat task that reaches an LLM to verify this pipeline.
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setHideGettingStarted(true)}
                      >
                        Hide Tips
                      </Button>
                    </div>
                  </div>
                )
              ) : null}

              <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card>
                  <CardHeader><CardTitle className="text-sm">API Calls Today</CardTitle></CardHeader>
                  <CardContent><div className="text-3xl font-bold">{metrics ? formatInt(metrics.summary.apiCallsToday) : "—"}</div></CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle className="text-sm">Tokens Today</CardTitle></CardHeader>
                  <CardContent><div className="text-3xl font-bold">{metrics ? formatInt(metrics.summary.tokensToday) : "—"}</div></CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle className="text-sm">Cost Today</CardTitle></CardHeader>
                  <CardContent><div className="text-3xl font-bold">{metrics ? formatUsd(metrics.summary.costTodayUsd) : "—"}</div></CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle className="text-sm">Success Rate (14d)</CardTitle></CardHeader>
                  <CardContent><div className="text-3xl font-bold">{metrics ? `${metrics.summary.successRate}%` : "—"}</div></CardContent>
                </Card>
              </div>

              <Card className="mb-6">
                <CardHeader>
                  <CardTitle>Daily Budget Progress</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span>Spent today: {metrics ? formatUsd(metrics.summary.budget.usedUsd) : "—"}</span>
                    <span>Budget: {metrics ? formatUsd(metrics.summary.budget.dailyUsd) : "—"}</span>
                  </div>
                  <Progress value={resolvedMetrics.summary.budget.usedPercent} />
                  <p className="mt-2 text-xs text-muted-foreground">
                    {metrics
                      ? `${metrics.summary.budget.usedPercent.toFixed(1)}% of daily budget used.`
                      : "Loading budget data..."}
                  </p>
                </CardContent>
              </Card>

              <div className="mb-6 grid gap-4 xl:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Daily Spend Trend (14d)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid h-40 grid-cols-[repeat(14,minmax(0,1fr))] items-end gap-1">
                      {resolvedMetrics.series.map((point) => {
                        const height = Math.max(6, (point.costUsd / maxDailyCost) * 100);
                        return (
                          <div key={`cost-${point.day}`} className="group relative h-full">
                            <div className="h-full w-full rounded bg-muted/40" />
                            <div
                              className="absolute bottom-0 left-0 right-0 rounded bg-primary/80"
                              style={{ height: `${height}%` }}
                            />
                            <div className="absolute -top-6 left-1/2 hidden -translate-x-1/2 rounded bg-black px-1.5 py-0.5 text-[10px] text-white group-hover:block">
                              {point.day.slice(5)} {formatUsd(point.costUsd)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Daily Token Throughput (14d)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid h-40 grid-cols-[repeat(14,minmax(0,1fr))] items-end gap-1">
                      {resolvedMetrics.series.map((point) => {
                        const height = Math.max(6, (point.tokens / maxDailyTokens) * 100);
                        return (
                          <div key={`tokens-${point.day}`} className="group relative h-full">
                            <div className="h-full w-full rounded bg-muted/40" />
                            <div
                              className="absolute bottom-0 left-0 right-0 rounded bg-sky-500/80"
                              style={{ height: `${height}%` }}
                            />
                            <div className="absolute -top-6 left-1/2 hidden -translate-x-1/2 rounded bg-black px-1.5 py-0.5 text-[10px] text-white group-hover:block">
                              {point.day.slice(5)} {formatInt(point.tokens)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-4 xl:grid-cols-3">
                <Card>
                  <CardHeader><CardTitle>Top Providers</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {metricsLoading && !metrics ? (
                      <p className="text-sm text-muted-foreground">Loading provider usage...</p>
                    ) : resolvedMetrics.providers.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No provider usage recorded yet.</p>
                    ) : (
                      resolvedMetrics.providers.slice(0, 8).map((item) => (
                        <div key={`provider-${item.key}`} className="rounded border px-3 py-2">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-medium">{item.key}</span>
                            <Badge variant="outline">{item.calls} calls</Badge>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatInt(item.tokens)} tokens • {formatUsd(item.costUsd)}
                          </div>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle>Top Models</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {metricsLoading && !metrics ? (
                      <p className="text-sm text-muted-foreground">Loading model usage...</p>
                    ) : resolvedMetrics.models.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No model usage recorded yet.</p>
                    ) : (
                      resolvedMetrics.models.slice(0, 8).map((item) => (
                        <div key={`model-${item.key}`} className="rounded border px-3 py-2">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-medium">{item.key}</span>
                            <Badge variant="outline">{item.calls} calls</Badge>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatInt(item.tokens)} tokens • {formatUsd(item.costUsd)}
                          </div>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle>Top Workflows</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {metricsLoading && !metrics ? (
                      <p className="text-sm text-muted-foreground">Loading workflow usage...</p>
                    ) : resolvedMetrics.workflows.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No workflow usage recorded yet.</p>
                    ) : (
                      resolvedMetrics.workflows.slice(0, 8).map((item) => (
                        <div key={`workflow-${item.key}`} className="rounded border px-3 py-2">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-medium">{item.key}</span>
                            <Badge variant="outline">{item.calls} calls</Badge>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatInt(item.tokens)} tokens • {formatUsd(item.costUsd)}
                          </div>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>
              </div>
            </>
          )}

          {/* ═══════════════════════ COST ANALYSIS TAB ═══════════════════════ */}
          {tab === "costs" && (
            <div className="space-y-6">
              {/* Time preset toolbar */}
              <div className="flex items-center justify-between">
                <div className="flex gap-1">
                  {COST_PRESETS.map((p, i) => (
                    <Button
                      key={p.label}
                      size="sm"
                      variant={costPreset === i ? "default" : "outline"}
                      onClick={() => setCostPreset(i)}
                      className={cn(
                        "font-mono text-xs uppercase tracking-widest",
                        costPreset === i && "bg-red-600 text-white border-red-600",
                      )}
                    >
                      {p.label}
                    </Button>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void loadCosts()}
                  disabled={costLoading}
                  className="font-mono text-xs uppercase tracking-widest"
                >
                  <RefreshCw className={cn("w-3 h-3 mr-1", costLoading && "animate-spin")} />
                  REFRESH
                </Button>
              </div>

              {/* Stats row */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {costStatCards.map(({ icon: Icon, label, value }) => (
                  <div key={label} className="border border-border bg-card p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Icon className="w-4 h-4 text-red-500" />
                      <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest">
                        {label}
                      </span>
                    </div>
                    <div className="font-mono text-2xl font-bold">{value}</div>
                  </div>
                ))}
              </div>

              {/* By Agent */}
              <div className="border border-border">
                <div className="px-4 py-2 border-b border-border bg-muted/20">
                  <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                    {"// COST BY AGENT"}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full font-mono text-sm">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground text-xs uppercase tracking-widest">
                        <th className="text-left px-4 py-2">AGENT</th>
                        <th className="text-right px-4 py-2">COST (USD)</th>
                        <th className="text-right px-4 py-2">TOKENS</th>
                        <th className="text-right px-4 py-2">CALLS</th>
                        <th className="text-left px-4 py-2">LAST SPEND</th>
                      </tr>
                    </thead>
                    <tbody>
                      {costLoading && !costData ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground text-xs">
                            Loading spend data...
                          </td>
                        </tr>
                      ) : (costData?.byAgent ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground text-xs">
                            No spend data
                          </td>
                        </tr>
                      ) : (
                        (costData?.byAgent ?? []).map((a) => (
                          <tr key={a.agentId} className="border-b border-border/50 hover:bg-muted/10">
                            <td className="px-4 py-2">{agentNames[a.agentId] ?? a.agentId}</td>
                            <td className="px-4 py-2 text-right text-red-400">{fmtUsdPrecise(a.totalCostUsd)}</td>
                            <td className="px-4 py-2 text-right">{fmtTokens(a.totalTokens)}</td>
                            <td className="px-4 py-2 text-right">{a.eventCount}</td>
                            <td className="px-4 py-2 text-muted-foreground text-xs">
                              {a.lastSpendAt ? new Date(a.lastSpendAt).toLocaleString() : "—"}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* By Goal */}
              {(costData?.byGoal ?? []).length > 0 && (
                <div className="border border-border">
                  <div className="px-4 py-2 border-b border-border bg-muted/20">
                    <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                      {"// COST BY GOAL"}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full font-mono text-sm">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground text-xs uppercase tracking-widest">
                          <th className="text-left px-4 py-2">GOAL</th>
                          <th className="text-right px-4 py-2">COST (USD)</th>
                          <th className="text-right px-4 py-2">TOKENS</th>
                          <th className="text-right px-4 py-2">CALLS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(costData?.byGoal ?? []).map((g) => (
                          <tr key={g.goalId} className="border-b border-border/50 hover:bg-muted/10">
                            <td className="px-4 py-2">{goalNames[g.goalId] ?? g.goalId}</td>
                            <td className="px-4 py-2 text-right text-red-400">{fmtUsdPrecise(g.costUsd)}</td>
                            <td className="px-4 py-2 text-right">{fmtTokens(g.tokens)}</td>
                            <td className="px-4 py-2 text-right">{g.calls}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Daily Spend */}
              {(costData?.byDay ?? []).length > 0 && (
                <div className="border border-border">
                  <div className="px-4 py-2 border-b border-border bg-muted/20">
                    <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                      {"// DAILY SPEND"}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full font-mono text-sm">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground text-xs uppercase tracking-widest">
                          <th className="text-left px-4 py-2">DATE</th>
                          <th className="text-right px-4 py-2">COST (USD)</th>
                          <th className="text-right px-4 py-2">TOKENS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...(costData?.byDay ?? [])].reverse().map((d) => (
                          <tr key={d.date} className="border-b border-border/50 hover:bg-muted/10">
                            <td className="px-4 py-2">{d.date}</td>
                            <td className="px-4 py-2 text-right text-red-400">{fmtUsdPrecise(d.costUsd)}</td>
                            <td className="px-4 py-2 text-right">{fmtTokens(d.tokens)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
  );
}
