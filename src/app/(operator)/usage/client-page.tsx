"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ExecutionRecord } from "@/types/execution";
import { usePolling } from "@/lib/client/use-polling";
import { useAfterUseful } from "@/lib/client/use-after-useful";

type WorkflowSummary = {
  id: string;
  name: string;
  isActive: boolean;
};

type RunningExecution = {
  executionId: string;
};

type UsageOverview = {
  windowDays: number;
  modelCalls: number;
  tokens: number;
  costUsd: number;
  workflowRuns: number;
  errorRate: number;
  topModels: Array<{ provider: string; modelId: string; calls: number; tokens: number; costUsd: number }>;
  topWorkflows: Array<{ workflowId: string; name: string; runs: number; failed: number }>;
};

const USAGE_UI_STATE_KEY = "disp8ch:usage-ui-state";

export default function UsagePage() {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [running, setRunning] = useState<RunningExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [overviewWindow, setOverviewWindow] = useState<7 | 30 | 90>(30);

  const load = useCallback(async () => {
    try {
      const [execRes, wfRes, runningRes] = await Promise.all([
        fetch("/api/execute"),
        fetch("/api/workflows"),
        fetch("/api/execute/running"),
      ]);

      const [execJson, wfJson, runningJson] = await Promise.all([
        execRes.json(),
        wfRes.json(),
        runningRes.json(),
      ]);

      if (execJson.success) setExecutions(execJson.data as ExecutionRecord[]);
      if (wfJson.success) setWorkflows(wfJson.data as WorkflowSummary[]);
      if (runningJson.success) setRunning(runningJson.data as RunningExecution[]);
    } catch {
      // no-op
    } finally {
      setLoading(false);
    }
  }, []);

  useAfterUseful(() => { void load(); }, [load]);

  useEffect(() => {
    fetch(`/api/usage/overview?windowDays=${overviewWindow}`)
      .then((response) => response.json())
      .then((json) => {
        if (json.success) setOverview(json.data as UsageOverview);
      })
      .catch(() => {});
  }, [overviewWindow]);

  usePolling(
    async () => { await load(); },
    [load],
    { intervalMs: 10000, enabled: true, pauseWhenHidden: true, backoffOnError: true, immediate: false },
  );

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(USAGE_UI_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
      setHideGettingStarted(Boolean(parsed.hideGettingStarted));
    } catch {
      // localStorage is optional; ignore malformed state.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(USAGE_UI_STATE_KEY, JSON.stringify({ hideGettingStarted }));
    } catch {
      // localStorage is optional.
    }
  }, [hideGettingStarted]);

  const metrics = useMemo(() => {
    const total = executions.length;
    const completed = executions.filter((e) => e.status === "completed").length;
    const failed = executions.filter((e) => e.status === "failed").length;
    const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    const triggerBreakdown = executions.reduce<Record<string, number>>((acc, item) => {
      acc[item.triggerType] = (acc[item.triggerType] || 0) + 1;
      return acc;
    }, {});

    return {
      total,
      completed,
      failed,
      successRate,
      triggerBreakdown,
    };
  }, [executions]);

  return (
        <main className="flex-1 overflow-auto p-6" data-perf-ready="usage">
          <div className="mb-6">
            <h1 className="text-2xl font-bold">Usage</h1>
            <p className="text-sm text-muted-foreground">
              Snapshot of workflow activity and execution reliability.
            </p>
          </div>

          {!loading && executions.length === 0 ? (
            hideGettingStarted ? (
              <div className="mb-6 flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2">
                <p className="text-sm text-muted-foreground">No executions recorded yet.</p>
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
                    <p className="mt-2 text-sm font-medium">Usage appears after workflows run.</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Manual, message, webhook, and scheduled executions are counted here. Run a workflow or send a routed chat
                      command to populate reliability, trigger, and recent execution data.
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

          <Card className="mb-6">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="text-base">Overview</CardTitle>
                <div className="flex items-center gap-1">
                  {([7, 30, 90] as const).map((days) => (
                    <Button
                      key={days}
                      type="button"
                      size="sm"
                      variant={overviewWindow === days ? "default" : "outline"}
                      onClick={() => setOverviewWindow(days)}
                    >
                      {days}d
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">Model calls</div>
                  <div className="mt-1 text-2xl font-bold">{overview ? overview.modelCalls : "—"}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">Tokens</div>
                  <div className="mt-1 text-2xl font-bold">{overview ? overview.tokens.toLocaleString() : "—"}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">Cost</div>
                  <div className="mt-1 text-2xl font-bold">{overview ? `$${overview.costUsd.toFixed(4)}` : "—"}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">Workflow runs</div>
                  <div className="mt-1 text-2xl font-bold">{overview ? overview.workflowRuns : "—"}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">Error rate</div>
                  <div className="mt-1 text-2xl font-bold">{overview ? `${overview.errorRate}%` : "—"}</div>
                </div>
              </div>
              {overview && (overview.topModels.length > 0 || overview.topWorkflows.length > 0) ? (
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Top models</div>
                    {overview.topModels.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No model calls in this window.</p>
                    ) : (
                      <div className="space-y-1">
                        {overview.topModels.map((model) => (
                          <div key={`${model.provider}:${model.modelId}`} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
                            <span className="truncate">{model.modelId}</span>
                            <span className="text-xs text-muted-foreground">
                              {model.tokens.toLocaleString()} tok · ${model.costUsd.toFixed(4)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Top workflows</div>
                    {overview.topWorkflows.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No workflow runs in this window.</p>
                    ) : (
                      <div className="space-y-1">
                        {overview.topWorkflows.map((workflow) => (
                          <div key={workflow.workflowId} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
                            <span className="truncate">{workflow.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {workflow.runs} runs{workflow.failed > 0 ? ` · ${workflow.failed} failed` : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <div className="mb-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Total Runs</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{loading ? "—" : metrics.total}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Success Rate</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{loading ? "—" : `${metrics.successRate}%`}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Running Now</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{loading ? "—" : running.length}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Active Workflows</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {loading ? "—" : workflows.filter((w) => w.isActive).length}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <CardHeader>
                <CardTitle>Trigger Breakdown</CardTitle>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <p className="text-sm text-muted-foreground">
                    Loading usage data...
                  </p>
                ) : Object.keys(metrics.triggerBreakdown).length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No executions yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {Object.entries(metrics.triggerBreakdown).map(([trigger, count]) => (
                      <div
                        key={trigger}
                        className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                      >
                        <span className="capitalize">{trigger}</span>
                        <Badge variant="outline">{count}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Recent Executions</CardTitle>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <p className="text-sm text-muted-foreground">Loading usage data...</p>
                ) : executions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No executions recorded yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {executions.slice(0, 15).map((exec) => (
                      <div
                        key={exec.id}
                        className="flex items-center justify-between rounded-md border px-3 py-2"
                      >
                        <div>
                          <div className="font-medium text-sm">{exec.workflowId}</div>
                          <div className="text-xs text-muted-foreground">
                            {new Date(exec.startedAt).toLocaleString()}
                          </div>
                          {exec.provenance ? (
                            <div className="mt-1 flex flex-wrap gap-2">
                              {exec.provenance.source ? (
                                <Badge variant="outline" className="text-[10px]">
                                  {String(exec.provenance.source)}
                                </Badge>
                              ) : null}
                              {exec.provenance.ingressProtocol ? (
                                <Badge variant="outline" className="text-[10px]">
                                  ingress {String(exec.provenance.ingressProtocol)}
                                </Badge>
                              ) : null}
                              {exec.provenance.sessionId ? (
                                <Badge variant="outline" className="text-[10px]">
                                  session {String(exec.provenance.sessionId)}
                                </Badge>
                              ) : null}
                              {exec.provenance.traceId ? (
                                <Badge variant="outline" className="text-[10px]">
                                  trace {String(exec.provenance.traceId).slice(0, 24)}
                                </Badge>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{exec.triggerType}</Badge>
                          <Badge
                            variant={
                              exec.status === "completed"
                                ? "default"
                                : exec.status === "failed"
                                ? "destructive"
                                : "secondary"
                            }
                          >
                            {exec.status}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </main>
  );
}
