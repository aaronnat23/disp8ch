"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Activity, CheckCircle2, XCircle, Zap, Brain, Wrench,
  RefreshCw, Circle, ShieldCheck, ShieldX, Clock, GitBranch, X, ChevronDown, ChevronRight,
} from "lucide-react";
import { usePolling } from "@/lib/client/use-polling";
import { useAfterUseful } from "@/lib/client/use-after-useful";
import { WorkTrailPanel } from "@/components/work-trails/work-trail-panel";
import { BackgroundSubagentsSection } from "@/components/activity/background-subagents-section";
import { WorkMonitor } from "@/components/activity/work-monitor";

interface TelemetryEvent {
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

type RunningExecution = {
  executionId: string;
  workflowId: string;
  triggerType: "message" | "webhook" | "manual" | "cron";
  startedAt: string;
  activeNodeId: string | null;
  activeNodeType: string | null;
  completedNodes: number;
  totalNodes: number;
};

type LaneSnapshot = {
  lane: "main" | "cron" | "subflow";
  maxConcurrent: number;
  active: number;
  queued: number;
};

type AgentRecord = {
  id: string;
  name: string;
  isActive: boolean;
};

type TraceNode = {
  nodeId: string;
  nodeType?: string;
  output?: unknown;
  duration?: number;
  error?: string;
};

type TraceChild = {
  id: string;
  workflowId: string;
  workflowName?: string;
  status: string;
  startedAt?: string;
};

type TraceParent = {
  id: string;
  workflowId: string;
  workflowName?: string;
  status: string;
};

type ExecutionTrace = {
  executionId: string;
  workflowId: string;
  workflowName?: string;
  status: string;
  triggerType: string;
  triggerData?: unknown;
  startedAt: string;
  completedAt?: string;
  error?: string;
  parentExecutionId?: string;
  parentNodeId?: string;
  parent?: TraceParent | null;
  children?: TraceChild[];
  nodes: TraceNode[];
};

// ── Node type colors (from Live Canvas) ─────────────────────────────────────

const NODE_TYPE_COLOR: Record<string, string> = {
  "claude-agent": "#8b5cf6",
  "parallel-agents": "#06b6d4",
  "message-trigger": "#10b981",
  "cron-trigger": "#f59e0b",
  "webhook-trigger": "#6366f1",
  "manual-trigger": "#94a3b8",
  "http-request": "#3b82f6",
  "memory-recall": "#ec4899",
  "memory-store": "#ec4899",
  "if-else": "#f97316",
  "send-webchat": "#22c55e",
  "send-telegram": "#22c55e",
  "send-discord": "#22c55e",
  "run-code": "#eab308",
  "council": "#a855f7",
  "loop": "#14b8a6",
  "error-handler": "#ef4444",
};

function nodeColor(type: string | null | undefined): string {
  return NODE_TYPE_COLOR[type ?? ""] ?? "#64748b";
}

function triggerIcon(t: string) {
  if (t === "cron") return "⏰";
  if (t === "webhook") return "🔗";
  if (t === "message") return "💬";
  return "▶";
}

function elapsedStr(start: string): string {
  const ms = Date.now() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

// ── Event metadata ──────────────────────────────────────────────────────────

const EVENT_META: Record<string, { label: string; icon: React.ReactNode; color: string; dot: string }> = {
  "workflow.start":        { label: "Workflow started",    icon: <Circle className="h-3.5 w-3.5" />,       color: "text-violet-400", dot: "bg-violet-500" },
  "workflow.complete":     { label: "Workflow completed",  icon: <CheckCircle2 className="h-3.5 w-3.5" />, color: "text-green-400",  dot: "bg-green-500" },
  "workflow.failed":       { label: "Workflow failed",     icon: <XCircle className="h-3.5 w-3.5" />,      color: "text-red-400",    dot: "bg-red-500" },
  "workflow.cancelled":    { label: "Workflow cancelled",  icon: <XCircle className="h-3.5 w-3.5" />,      color: "text-amber-400",  dot: "bg-amber-500" },
  "workflow.node_complete":{ label: "Node completed",      icon: <Zap className="h-3.5 w-3.5" />,          color: "text-blue-400",   dot: "bg-blue-500" },
  "memory.stored":         { label: "Memory stored",       icon: <Brain className="h-3.5 w-3.5" />,        color: "text-pink-400",   dot: "bg-pink-500" },
  "tool.call":             { label: "Tool called",         icon: <Wrench className="h-3.5 w-3.5" />,       color: "text-cyan-400",   dot: "bg-cyan-500" },
  "tool.approval_queued":  { label: "Approval requested",  icon: <ShieldCheck className="h-3.5 w-3.5" />,  color: "text-yellow-400", dot: "bg-yellow-500" },
  "tool.approval_approved":{ label: "Approval granted",    icon: <ShieldCheck className="h-3.5 w-3.5" />,  color: "text-green-400",  dot: "bg-green-500" },
  "tool.approval_denied":  { label: "Approval denied",     icon: <ShieldX className="h-3.5 w-3.5" />,      color: "text-red-400",    dot: "bg-red-500" },
};

function eventMeta(type: string) {
  return EVENT_META[type] ?? {
    label: type,
    icon: <Activity className="h-3.5 w-3.5" />,
    color: "text-muted-foreground",
    dot: "bg-muted-foreground",
  };
}

function relativeTime(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 5000)  return "just now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

function summarise(event: TelemetryEvent): string {
  const d = event.data;
  switch (event.type) {
    case "workflow.start":
    case "workflow.complete":
    case "workflow.failed":
      return [d.workflowId, d.status, d.nodeCount ? `${d.nodeCount} nodes` : ""].filter(Boolean).join(" · ");
    case "workflow.node_complete":
      return [d.nodeType, d.durationMs != null ? `${d.durationMs}ms` : ""].filter(Boolean).join(" · ");
    case "memory.stored":
      return String(d.type ?? d.content ?? "").slice(0, 80);
    case "tool.call":
      return String(d.name ?? "").slice(0, 60);
    case "tool.approval_queued":
    case "tool.approval_approved":
    case "tool.approval_denied":
      return String(d.name ?? "").slice(0, 60);
    default:
      return Object.entries(d).slice(0, 2).map(([k, v]) => `${k}: ${String(v)}`).join(" · ");
  }
}

const FILTER_OPTIONS = ["attention", "all", "workflow", "memory", "tool"] as const;
type Filter = typeof FILTER_OPTIONS[number];

const ACTIVITY_UI_STATE_KEY = "disp8ch:activity-ui-state";
const ATTENTION_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function matchesFilter(type: string, filter: Filter) {
  if (filter === "all") return true;
  return type.startsWith(filter);
}

function isAttentionEvent(e: TelemetryEvent): boolean {
  const d = e.data;
  const ageMs = Date.now() - new Date(e.ts).getTime();
  const isRecent = Number.isFinite(ageMs) && ageMs <= ATTENTION_EVENT_WINDOW_MS;
  if ((e.type === "workflow.failed" || e.type === "workflow.cancelled") && isRecent) return true;
  if (e.type === "tool.approval_queued") return true;
  if (isRecent && (d.status === "failed" || d.status === "error" || d.status === "interrupted" || d.status === "blocked")) return true;
  if (typeof d.durationMs === "number" && d.durationMs > 60000) return true;
  if (typeof d.costUsd === "number" && d.costUsd >= 0.1) return true;
  return false;
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function ActivityPage() {
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [running, setRunning] = useState<RunningExecution[]>([]);
  const [lanes, setLanes] = useState<LaneSnapshot[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [workflowNames, setWorkflowNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("attention");
  const [paused, setPaused] = useState(false);
  const [stoppingExecutionId, setStoppingExecutionId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);

  // Trace drawer
  const [traceOpen, setTraceOpen] = useState(false);
  const [traceLoading, setTraceLoading] = useState(false);
  const [trace, setTrace] = useState<ExecutionTrace | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  const loadWorkflowNames = useCallback(async () => {
    try {
      const res = await fetch("/api/workflows");
      const json = await res.json();
      if (!json.success || !Array.isArray(json.data)) return;
      const nameMap: Record<string, string> = {};
      for (const wf of json.data as Array<{ id: string; name: string }>) {
        nameMap[wf.id] = wf.name;
      }
      setWorkflowNames(nameMap);
    } catch { /* no-op */ }
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      const json = await res.json() as { success: boolean; data?: { agents?: AgentRecord[] } };
      if (json.success && json.data?.agents) setAgents(json.data.agents.filter((a) => a.isActive));
    } catch { /* no-op */ }
  }, []);

  const loadRunning = useCallback(async () => {
    try {
      const res = await fetch("/api/execute/running");
      const json = await res.json();
      if (json.success) {
        setRunning(json.data as RunningExecution[]);
        setLanes((json.lanes ?? []) as LaneSnapshot[]);
      }
    } catch { /* no-op */ }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/telemetry?action=recent&limit=200");
      const json = await res.json() as { success: boolean; data: TelemetryEvent[] };
      if (json.success) setEvents([...json.data].reverse());
    } catch { /* no-op */ }
    finally { setLoading(false); }
  }, []);

  const interruptExecution = useCallback(async (executionId: string) => {
    setStoppingExecutionId(executionId);
    try {
      await fetch("/api/execute/running", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ executionId }),
      });
      await Promise.all([loadRunning(), load()]);
    } finally { setStoppingExecutionId(null); }
  }, [load, loadRunning]);

  const retryExecution = useCallback(async (event: TelemetryEvent) => {
    const workflowId = event.data.workflowId;
    if (typeof workflowId !== "string" || !workflowId) return;
    const prevExecId = typeof event.data.executionId === "string" ? event.data.executionId : null;
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId,
          triggerType: "manual",
          triggerData: { triggeredAt: new Date().toISOString(), retryOf: prevExecId },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.success === false) {
        console.error("retry failed", data?.error);
      } else {
        // Eagerly refresh — the new execution should appear in the feed.
        void load();
        void loadRunning();
      }
    } catch (err) {
      console.error("retry execution error", err);
    }
  }, [load, loadRunning]);

  const openTrace = useCallback(async (executionId: string) => {
    setTraceOpen(true);
    setTraceLoading(true);
    setTrace(null);
    setExpandedNodes(new Set());
    try {
      const res = await fetch(`/api/execute?action=trace&executionId=${encodeURIComponent(executionId)}`);
      const json = await res.json() as { success: boolean; data?: ExecutionTrace };
      if (json.success && json.data) setTrace(json.data);
    } catch { /* ignore */ }
    finally { setTraceLoading(false); }
  }, []);

  // All Activity data is deferred behind useful-ready. The page shell + getting
  // started panel render from static content immediately; running/telemetry
  // populate after the ready marker is observable.
  useAfterUseful(() => {
    void loadRunning();
    void load();
    void loadWorkflowNames();
    void loadAgents();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(ACTIVITY_UI_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
      setHideGettingStarted(Boolean(parsed.hideGettingStarted));
    } catch {
      // localStorage is optional; ignore malformed state.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        ACTIVITY_UI_STATE_KEY,
        JSON.stringify({ hideGettingStarted }),
      );
    } catch {
      // localStorage is optional.
    }
  }, [hideGettingStarted]);

  usePolling(
    async () => { await load(); await loadRunning(); setTick((t) => t + 1); },
    [load, loadRunning],
    { intervalMs: 2000, enabled: !paused, pauseWhenHidden: true, backoffOnError: true, immediate: false },
  );

  const visible = filter === "attention"
    ? events.filter(isAttentionEvent)
    : events.filter((e) => matchesFilter(e.type, filter));
  const isActive = running.length > 0;

  const counts = {
    workflow: events.filter((e) => e.type.startsWith("workflow")).length,
    memory:   events.filter((e) => e.type.startsWith("memory")).length,
    tool:     events.filter((e) => e.type.startsWith("tool")).length,
  };

  const laneLabel = (lane: LaneSnapshot["lane"]) => {
    if (lane === "cron") return "Scheduler";
    if (lane === "subflow") return "Subflow";
    return "Main";
  };

  // Which agents are currently busy (matched by workflow name heuristic)
  const busyAgentIds = new Set(
    running
      .filter((r) => r.activeNodeType === "claude-agent")
      .flatMap((r) => {
        const name = workflowNames[r.workflowId]?.toLowerCase() ?? "";
        return agents.filter((a) => name.includes(a.name.toLowerCase())).map((a) => a.id);
      }),
  );

  return (
      <>
        <main className="flex-1 overflow-auto p-6 space-y-6" data-perf-ready="activity">

          {/* ── Top bar ── */}
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className={`h-2.5 w-2.5 rounded-full ${isActive ? "bg-green-500 animate-pulse" : "bg-muted-foreground/40"}`} />
                <h1 className="text-2xl font-bold">Activity</h1>
                {isActive && (
                  <Badge className="bg-green-600/20 text-green-400 border-green-600 text-[10px]" variant="outline">
                    {running.length} RUNNING
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Live execution monitoring, agent activity, and event stream.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-muted-foreground">
                {tick > 0 ? "live" : "loading"}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPaused((p) => !p)}
                className={paused ? "border-yellow-500 text-yellow-400" : ""}
              >
                {paused ? <><Clock className="mr-1.5 h-3.5 w-3.5" />Paused</> : <><RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />Live</>}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { void load(); void loadRunning(); }}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* ── Live Work Monitor (agents + workflow executions) ── */}
          <WorkMonitor />

          {/* ── Cross-tab work trails ── */}
          <WorkTrailPanel />

          {/* ── Background subagents (async delegation visibility) ── */}
          <BackgroundSubagentsSection />

          {/* ── Running Executions (color-coded cards from Live Canvas) ── */}
          {running.length > 0 && (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {running.map((exec) => {
                const name = workflowNames[exec.workflowId] ?? exec.workflowId.slice(0, 12);
                const pct = exec.totalNodes > 0
                  ? Math.min(100, Math.round((exec.completedNodes / exec.totalNodes) * 100))
                  : 0;
                const color = nodeColor(exec.activeNodeType);
                return (
                  <Card key={exec.executionId} className="relative overflow-hidden border-2" style={{ borderColor: color + "55" }}>
                    {/* Animated top progress bar */}
                    <div className="absolute top-0 left-0 h-1 w-full bg-muted">
                      <div className="h-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
                    </div>

                    <CardHeader className="pb-2 pt-4">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-mono truncate max-w-[200px]">{name}</CardTitle>
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{triggerIcon(exec.triggerType)}</span>
                          <Button
                            size="sm" variant="ghost" className="h-6 text-[10px] px-2"
                            onClick={() => void openTrace(exec.executionId)}
                          >
                            <GitBranch className="h-3 w-3 mr-1" />Trace
                          </Button>
                          <Button
                            size="sm" variant="outline" className="h-6 text-[10px] px-2"
                            onClick={() => void interruptExecution(exec.executionId)}
                            disabled={stoppingExecutionId === exec.executionId}
                          >
                            {stoppingExecutionId === exec.executionId ? "..." : "Interrupt"}
                          </Button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className="text-[9px] uppercase tracking-wider">{exec.triggerType}</Badge>
                        <span className="text-[10px] font-mono text-muted-foreground">{elapsedStr(exec.startedAt)}</span>
                        <span className="text-[10px] font-mono text-muted-foreground ml-auto">{exec.completedNodes}/{exec.totalNodes} nodes</span>
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-3">
                      {/* Active node pill */}
                      {exec.activeNodeType ? (
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full animate-pulse flex-shrink-0" style={{ backgroundColor: color }} />
                          <span className="text-xs font-mono truncate" style={{ color }}>{exec.activeNodeType}</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/40 flex-shrink-0" />
                          <span className="text-xs font-mono text-muted-foreground">waiting…</span>
                        </div>
                      )}

                      {/* Mini node track */}
                      <div className="flex items-center gap-1 flex-wrap">
                        {Array.from({ length: Math.min(exec.totalNodes, 12) }).map((_, i) => (
                          <div
                            key={i}
                            className="h-1.5 w-4 rounded-full transition-all duration-300"
                            style={{
                              backgroundColor: i < exec.completedNodes ? color
                                : i === exec.completedNodes ? color + "88" : "#334155",
                            }}
                          />
                        ))}
                        {exec.totalNodes > 12 && (
                          <span className="text-[10px] text-muted-foreground font-mono">+{exec.totalNodes - 12}</span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {/* ── Summary row: counters + agents + lanes ── */}
          <div className="grid gap-4 xl:grid-cols-[1fr_1fr_1fr]">
            {/* Event summary cards */}
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Events</div>
                <div className="grid grid-cols-3 gap-2">
                  {(["workflow", "memory", "tool"] as const).map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setFilter((f) => f === cat ? "all" : cat)}
                      className={`rounded-md border px-2 py-2 text-center transition-colors ${
                        filter === cat ? "border-primary bg-primary/10" : "border-border hover:bg-muted"
                      }`}
                    >
                      <div className="text-lg font-bold">{counts[cat]}</div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{cat}</div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Active agents panel */}
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Active Agents</div>
                {agents.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No active agents.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {agents.slice(0, 12).map((agent) => {
                      const busy = busyAgentIds.has(agent.id);
                      return (
                        <div
                          key={agent.id}
                          className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-mono transition-all ${
                            busy ? "border-violet-500/50 bg-violet-500/5 text-violet-300" : "border-border text-muted-foreground"
                          }`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${busy ? "bg-violet-400 animate-pulse" : "bg-muted-foreground/40"}`} />
                          {agent.name}
                        </div>
                      );
                    })}
                    {agents.length > 12 && (
                      <span className="text-[10px] text-muted-foreground self-center">+{agents.length - 12} more</span>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Lane concurrency */}
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Execution Lanes</div>
                {lanes.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No lanes reported.</p>
                ) : (
                  <div className="space-y-2">
                    {lanes.map((lane) => (
                      <div key={lane.lane} className="flex items-center justify-between rounded-md border px-3 py-2">
                        <span className="text-sm font-medium">{laneLabel(lane.lane)}</span>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>Active {lane.active}/{lane.maxConcurrent}</span>
                          {lane.queued > 0 && <Badge variant="secondary" className="text-[10px]">{lane.queued} queued</Badge>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Filter tabs ── */}
          <div className="flex gap-2 flex-wrap">
            {FILTER_OPTIONS.map((f) => {
              const issues = f === "attention" ? events.filter(isAttentionEvent).length : 0;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors capitalize inline-flex items-center ${
                    filter === f
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {f === "attention" ? "Needs attention" : f === "all" ? `All (${events.length})` : f}
                  {f === "attention" && issues > 0 ? (
                    <Badge variant="destructive" className="ml-1.5 h-4 px-1 text-[9px]">{issues}</Badge>
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* ── Event Feed ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="h-4 w-4" />
                {visible.length} events
                {!paused && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse inline-block" />}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <p className="p-6 text-sm text-muted-foreground">Loading events…</p>
              ) : filter === "attention" && visible.length === 0 && events.length > 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <CheckCircle2 className="mb-3 h-8 w-8 text-emerald-500/50" />
                  <p className="text-sm font-medium text-foreground">Nothing needs attention</p>
                  <p className="mt-1 text-xs text-muted-foreground">All systems are running normally.</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => setFilter("all")}>
                    Show all events
                  </Button>
                </div>
              ) : visible.length === 0 ? (
                hideGettingStarted ? (
                  <div className="flex items-center justify-between gap-3 p-6">
                    <p className="text-sm text-muted-foreground">No events yet.</p>
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
                  <div className="p-6">
                    <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/20 p-4">
                      <div>
                        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                          Getting Started
                        </div>
                        <p className="mt-2 text-sm font-medium">Run a workflow to populate live activity.</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          This feed shows workflow starts, completions, tool calls, memory writes, approvals,
                          and running execution progress once the runtime emits telemetry.
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
              ) : (
                <div className="divide-y">
                  {visible.map((event, i) => {
                    const meta = eventMeta(event.type);
                    return (
                      <div key={`${event.ts}-${i}`} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
                        <div className="mt-1 shrink-0">
                          <span className={`${meta.dot} inline-block h-2 w-2 rounded-full mt-1`} />
                        </div>
                        <div className={`shrink-0 mt-0.5 ${meta.color}`}>{meta.icon}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">{meta.label}</span>
                            <div className="flex items-center gap-2 shrink-0">
                              {(event.type === "workflow.start" || event.type === "workflow.complete" || event.type === "workflow.failed") &&
                                typeof event.data.executionId === "string" && (
                                <button
                                  onClick={() => void openTrace(event.data.executionId as string)}
                                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted border border-transparent hover:border-border transition-colors"
                                >
                                  <GitBranch className="h-3 w-3" />Trace
                                </button>
                              )}
                              {(event.type === "workflow.failed" || event.type === "workflow.cancelled") &&
                                typeof event.data.workflowId === "string" && (
                                <button
                                  onClick={() => void retryExecution(event)}
                                  title="Retry this workflow"
                                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 border border-emerald-500/30 transition-colors"
                                >
                                  <RefreshCw className="h-3 w-3" />Retry
                                </button>
                              )}
                              <span className="text-xs text-muted-foreground">{relativeTime(event.ts)}</span>
                            </div>
                          </div>
                          {summarise(event) && (
                            <p className="mt-0.5 text-xs text-muted-foreground truncate">{summarise(event)}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

        </main>

      {/* ── Trace Drawer ── */}
      {traceOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40" onClick={() => setTraceOpen(false)} />
          {/* Panel */}
          <div className="relative z-10 flex h-full w-full max-w-xl flex-col bg-background border-l shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Execution Trace</span>
                {trace && (
                  <Badge
                    variant="outline"
                    className={`text-[10px] ml-1 ${
                      trace.status === "completed" ? "border-green-600 text-green-400"
                      : trace.status === "failed" ? "border-red-600 text-red-400"
                      : "border-yellow-600 text-yellow-400"
                    }`}
                  >
                    {trace.status}
                  </Badge>
                )}
              </div>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setTraceOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {traceLoading && (
                <p className="text-sm text-muted-foreground animate-pulse">Loading trace…</p>
              )}
              {!traceLoading && !trace && (
                <p className="text-sm text-muted-foreground">No trace data available.</p>
              )}
              {trace && (
                <>
                  {/* Execution meta */}
                  <div className="rounded-md border bg-muted/20 p-4 space-y-2 text-xs font-mono">
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-24">Workflow</span>
                      <span className="truncate">{trace.workflowName ?? trace.workflowId}</span>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-24">Exec ID</span>
                      <span className="truncate text-[10px]">{trace.executionId}</span>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-24">Trigger</span>
                      <span>{trace.triggerType}</span>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-24">Started</span>
                      <span>{new Date(trace.startedAt).toLocaleString()}</span>
                    </div>
                    {trace.completedAt && (
                      <div className="flex gap-2">
                        <span className="text-muted-foreground w-24">Completed</span>
                        <span>{new Date(trace.completedAt).toLocaleString()}</span>
                      </div>
                    )}
                    {trace.error && (
                      <div className="flex gap-2">
                        <span className="text-muted-foreground w-24">Error</span>
                        <span className="text-red-400 break-all">{trace.error}</span>
                      </div>
                    )}
                  </div>

                  {(trace.parent || (trace.children && trace.children.length > 0)) ? (
                    <div className="rounded-md border bg-muted/10 p-4 space-y-3 text-xs">
                      <div className="font-mono uppercase tracking-widest text-muted-foreground">Run Links</div>
                      {trace.parent ? (
                        <button
                          type="button"
                          onClick={() => void openTrace(trace.parent!.id)}
                          className="flex w-full items-center gap-2 rounded border bg-background px-3 py-2 text-left hover:bg-muted/40"
                        >
                          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">Parent: {trace.parent.workflowName ?? trace.parent.workflowId}</div>
                            <div className="truncate font-mono text-[10px] text-muted-foreground">{trace.parent.id}</div>
                          </div>
                          <Badge variant="outline" className="text-[10px]">{trace.parent.status}</Badge>
                        </button>
                      ) : null}
                      {trace.children && trace.children.length > 0 ? (
                        <div className="space-y-1.5">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            Children ({trace.children.length})
                          </div>
                          {trace.children.map((child) => (
                            <button
                              type="button"
                              key={child.id}
                              onClick={() => void openTrace(child.id)}
                              className="flex w-full items-center gap-2 rounded border bg-background px-3 py-2 text-left hover:bg-muted/40"
                            >
                              <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-medium">{child.workflowName ?? child.workflowId}</div>
                                <div className="truncate font-mono text-[10px] text-muted-foreground">{child.id}</div>
                              </div>
                              <Badge variant="outline" className="text-[10px]">{child.status}</Badge>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Node timeline */}
                  {trace.nodes.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No node results recorded for this execution.</p>
                  ) : (
                    <div className="space-y-2">
                      <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-3">
                        Node Timeline — {trace.nodes.length} nodes
                      </div>
                      {trace.nodes.map((node, idx) => {
                        const color = nodeColor(node.nodeType);
                        const isExpanded = expandedNodes.has(node.nodeId);
                        const hasOutput = node.output !== undefined && node.output !== null && node.output !== "";
                        return (
                          <div key={node.nodeId} className="rounded-md border overflow-hidden">
                            <button
                              className="flex w-full items-center gap-3 px-3 py-2.5 hover:bg-muted/30 transition-colors text-left"
                              onClick={() => {
                                setExpandedNodes((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(node.nodeId)) next.delete(node.nodeId);
                                  else next.add(node.nodeId);
                                  return next;
                                });
                              }}
                            >
                              {/* Step number */}
                              <span className="text-[10px] font-mono text-muted-foreground w-5 shrink-0">{idx + 1}</span>
                              {/* Color dot */}
                              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                              {/* Node info */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-mono truncate" style={{ color }}>{node.nodeType ?? node.nodeId}</span>
                                  {node.nodeType !== node.nodeId && (
                                    <span className="text-[10px] text-muted-foreground truncate">{node.nodeId}</span>
                                  )}
                                </div>
                              </div>
                              {/* Badges */}
                              <div className="flex items-center gap-1.5 shrink-0">
                                {node.duration !== undefined && (
                                  <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                                    {node.duration < 1000 ? `${node.duration}ms` : `${(node.duration / 1000).toFixed(1)}s`}
                                  </Badge>
                                )}
                                {node.error ? (
                                  <Badge variant="destructive" className="text-[9px] px-1.5 py-0">error</Badge>
                                ) : hasOutput ? (
                                  <Badge variant="secondary" className="text-[9px] px-1.5 py-0">output</Badge>
                                ) : null}
                                {isExpanded
                                  ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                                  : <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                }
                              </div>
                            </button>
                            {isExpanded && (
                              <div className="border-t bg-muted/10 px-3 py-2 space-y-2">
                                {node.error && (
                                  <div>
                                    <div className="text-[10px] font-mono uppercase text-red-400 mb-1">Error</div>
                                    <pre className="text-[11px] text-red-300 whitespace-pre-wrap break-all font-mono">{node.error}</pre>
                                  </div>
                                )}
                                {hasOutput && (
                                  <div>
                                    <div className="text-[10px] font-mono uppercase text-muted-foreground mb-1">Output</div>
                                    <pre className="text-[11px] text-foreground/80 whitespace-pre-wrap break-all font-mono max-h-48 overflow-y-auto">
                                      {typeof node.output === "string" ? node.output : JSON.stringify(node.output, null, 2)}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
