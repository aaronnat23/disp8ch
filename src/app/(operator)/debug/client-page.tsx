"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAfterUseful } from "@/lib/client/use-after-useful";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

type DebugPayload = {
  status: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  heartbeat: Record<string, unknown> | null;
  models: Array<Record<string, unknown>>;
  config: Record<string, unknown> | null;
  automationRuns?: Array<{
    id: string;
    workflowId: string;
    workflowName: string;
    status: string;
    triggerType: string;
    sessionId: string | null;
    routeSource: unknown;
    startedAt: string;
    completedAt: string | null;
    error: string | null;
    createdObjects: Array<{ type: string; id: string; label: string | null }>;
  }>;
  durableTurns?: {
    summary: Record<string, number>;
    turns: Array<{
      clientTurnId: string;
      sessionId: string;
      status: string;
      message: string;
      responsePreview: string | null;
      error: string | null;
      attempts: number;
      workerId: string | null;
      leaseExpiresAt: string | null;
      streamBytes: number;
      createdAt: string;
      updatedAt: string;
      completedAt: string | null;
    }>;
  };
  eventLog: Array<{
    event: string;
    ts: string;
    payload: Record<string, unknown>;
  }>;
};

const DEBUG_UI_STATE_KEY = "disp8ch:debug-ui-state";

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export default function DebugPage() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<DebugPayload>({
    status: null,
    health: null,
    heartbeat: null,
    models: [],
    config: null,
    automationRuns: [],
    durableTurns: { summary: {}, turns: [] },
    eventLog: [],
  });

  const [method, setMethod] = useState("system-presence");
  const [paramsText, setParamsText] = useState("{}");
  const [callBusy, setCallBusy] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [callResult, setCallResult] = useState<string>("");
  const [hideGettingStarted, setHideGettingStarted] = useState(false);

  const loadSnapshots = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/debug");
      const json = await res.json();
      if (!json.success) {
        setError(String(json.error || "Failed to load debug snapshots"));
        return;
      }
      setPayload(json.data as DebugPayload);
    } catch (fetchError) {
      setError(String(fetchError));
    } finally {
      if (!silent) setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Defer /api/debug fetch until useful-ready so the page shell paints first.
  useAfterUseful(() => {
    void loadSnapshots();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DEBUG_UI_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
      setHideGettingStarted(Boolean(parsed.hideGettingStarted));
    } catch {
      // localStorage is optional; ignore malformed state.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(DEBUG_UI_STATE_KEY, JSON.stringify({ hideGettingStarted }));
    } catch {
      // localStorage is optional.
    }
  }, [hideGettingStarted]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadSnapshots(true);
  };

  const onCall = async () => {
    setCallBusy(true);
    setCallError(null);
    setCallResult("");
    try {
      let parsedParams: unknown = {};
      const trimmed = paramsText.trim();
      if (trimmed) {
        parsedParams = JSON.parse(trimmed);
      }

      const res = await fetch("/api/debug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: method.trim(), params: parsedParams }),
      });
      const json = await res.json();
      if (!json.success) {
        setCallError(String(json.error || "RPC call failed"));
        return;
      }
      setCallResult(safeJson(json.data));
      await loadSnapshots(true);
    } catch (rpcError) {
      setCallError(String(rpcError));
    } finally {
      setCallBusy(false);
      setRefreshing(false);
    }
  };

  const healthOk = useMemo(() => {
    const value = payload.health?.ok;
    return value === true;
  }, [payload.health]);

  return (
        <main className="flex-1 overflow-auto p-6" data-perf-ready="debug">
          <div className="mb-6 flex items-center justify-between gap-2">
            <div>
              <h1 className="text-2xl font-bold">Debug</h1>
              <p className="text-sm text-muted-foreground">
                Gateway snapshots, health details, and manual RPC calls.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={healthOk ? "default" : "secondary"}>
                {healthOk ? "Health OK" : "Health Check Pending"}
              </Badge>
              <Button variant="outline" onClick={() => void onRefresh()} disabled={refreshing || loading}>
                {refreshing ? "Refreshing..." : "Refresh"}
              </Button>
            </div>
          </div>

          {error ? (
            <Card className="mb-4 border-destructive/50">
              <CardContent className="pt-6">
                <p className="text-sm text-destructive">{error}</p>
              </CardContent>
            </Card>
          ) : null}

          {hideGettingStarted ? (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2">
              <p className="text-sm text-muted-foreground">Debug tips hidden.</p>
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
            <div className="mb-4 rounded-md border bg-muted/20 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    Getting Started
                  </div>
                  <p className="mt-2 text-sm font-medium">Use Debug for raw gateway state and manual RPC checks.</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Snapshot panes show the latest status, health, heartbeat, model catalog, and subsystem events.
                    Manual RPC is intentionally low-level; keep params as valid JSON.
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
          )}

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-xl">Snapshots</CardTitle>
                <CardDescription>Status, health, and heartbeat data.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="mb-2 text-sm font-medium">Status</div>
                  <pre className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
                    {loading ? "Loading..." : safeJson(payload.status)}
                  </pre>
                </div>
                <div>
                  <div className="mb-2 text-sm font-medium">Health</div>
                  <pre className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
                    {loading ? "Loading..." : safeJson(payload.health)}
                  </pre>
                </div>
                <div>
                  <div className="mb-2 text-sm font-medium">Last Heartbeat</div>
                  <pre className="max-h-56 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
                    {loading ? "Loading..." : safeJson(payload.heartbeat)}
                  </pre>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-xl">Manual RPC</CardTitle>
                <CardDescription>Send a raw debug method with JSON params.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Method</label>
                  <Input
                    value={method}
                    onChange={(event) => setMethod(event.target.value)}
                    placeholder="system-presence"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Params (JSON)</label>
                  <Textarea
                    rows={7}
                    value={paramsText}
                    onChange={(event) => setParamsText(event.target.value)}
                  />
                </div>
                <Button onClick={() => void onCall()} disabled={callBusy || !method.trim()}>
                  {callBusy ? "Calling..." : "Call"}
                </Button>
                {callError ? (
                  <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {callError}
                  </div>
                ) : null}
                {callResult ? (
                  <pre className="max-h-[420px] overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
                    {callResult}
                  </pre>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="text-xl">Automation Runs</CardTitle>
              <CardDescription>Recent local execution trace across workflows, schedules, WebChat, and created objects.</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading automation runs...</p>
              ) : !payload.automationRuns || payload.automationRuns.length === 0 ? (
                <p className="text-sm text-muted-foreground">No workflow executions recorded yet.</p>
              ) : (
                <div className="space-y-2">
                  {payload.automationRuns.map((run) => (
                    <div key={run.id} className="rounded-md border px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{run.workflowName}</div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {run.triggerType} · {run.sessionId || "no session"} · {run.id}
                          </div>
                        </div>
                        <Badge variant={run.status === "failed" ? "destructive" : run.status === "completed" ? "default" : "secondary"}>
                          {run.status}
                        </Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                        <span>{new Date(run.startedAt).toLocaleString()}</span>
                        {run.routeSource ? <span>route: {String(run.routeSource)}</span> : null}
                        {run.createdObjects.length > 0 ? <span>{run.createdObjects.length} created object(s)</span> : null}
                      </div>
                      {run.error ? <p className="mt-2 text-xs text-destructive">{run.error}</p> : null}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-xl">Durable Turns</CardTitle>
                  <CardDescription>Recent WebChat queue state, worker leases, retries, and stream recovery bytes.</CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    setMethod("turns.recover-stale");
                    setParamsText("{}");
                    setCallBusy(true);
                    setCallError(null);
                    setCallResult("");
                    try {
                      const res = await fetch("/api/debug", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ method: "turns.recover-stale", params: {} }),
                      });
                      const json = await res.json();
                      if (!json.success) {
                        setCallError(String(json.error || "Recover stale turns failed"));
                      } else {
                        setCallResult(safeJson(json.data));
                        await loadSnapshots(true);
                      }
                    } catch (recoverError) {
                      setCallError(String(recoverError));
                    } finally {
                      setCallBusy(false);
                    }
                  }}
                >
                  Recover Stale
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading durable turns...</p>
              ) : !payload.durableTurns || payload.durableTurns.turns.length === 0 ? (
                <p className="text-sm text-muted-foreground">No durable WebChat turns recorded yet.</p>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(payload.durableTurns.summary).map(([status, count]) => (
                      <Badge key={status} variant="outline">{status}: {count}</Badge>
                    ))}
                  </div>
                  <div className="space-y-2">
                    {payload.durableTurns.turns.slice(0, 10).map((turn) => (
                      <div key={turn.clientTurnId} className="rounded-md border px-3 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{turn.message}</div>
                            <div className="truncate text-[11px] text-muted-foreground">
                              {turn.sessionId} · {turn.clientTurnId}
                            </div>
                          </div>
                          <Badge variant={turn.status === "failed" ? "destructive" : turn.status === "completed" ? "default" : "secondary"}>
                            {turn.status}
                          </Badge>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                          <span>attempts: {turn.attempts}</span>
                          <span>stream: {turn.streamBytes} bytes</span>
                          <span>updated: {new Date(turn.updatedAt).toLocaleString()}</span>
                          {turn.leaseExpiresAt ? <span>lease: {new Date(turn.leaseExpiresAt).toLocaleTimeString()}</span> : null}
                        </div>
                        {turn.responsePreview ? <p className="mt-2 text-xs text-muted-foreground">{turn.responsePreview}</p> : null}
                        {turn.error ? <p className="mt-2 text-xs text-destructive">{turn.error}</p> : null}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="text-xl">Models</CardTitle>
              <CardDescription>Configured model catalog used by agents and workflows.</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
                {loading ? "Loading..." : safeJson(payload.models)}
              </pre>
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="text-xl">Recent Events</CardTitle>
              <CardDescription>Latest subsystem events from gateway logs.</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading events...</p>
              ) : payload.eventLog.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No debug events available yet. Runtime subsystem events will appear here after gateway activity.
                </p>
              ) : (
                <div className="space-y-2">
                  {payload.eventLog.map((evt, index) => (
                    <div key={`${evt.ts}-${evt.event}-${index}`} className="rounded-md border px-3 py-2">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <div className="text-sm font-medium">{evt.event}</div>
                        <div className="text-xs text-muted-foreground">
                          {new Date(evt.ts).toLocaleTimeString()}
                        </div>
                      </div>
                      <pre className="max-h-40 overflow-auto rounded border bg-muted/30 p-2 text-[11px]">
                        {safeJson(evt.payload)}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </main>
  );
}
