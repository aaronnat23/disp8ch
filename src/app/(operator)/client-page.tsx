"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  GitBranch, Bot, Brain, MessageSquare, Database, Zap,
  Activity, AlertCircle, Clock,
  FileText, Kanban, ArrowRight, Layers, Terminal,
  Shield, Cpu, Radio, Search, Server, TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { APP_TTL, cachedJson } from "@/lib/client/app-data-cache";
import { scheduleAfterUseful } from "@/lib/client/use-after-useful";
import { readPreloadedBootstrap } from "@/lib/client/preloaded-bootstrap";
import type { Workflow } from "@/types/workflow";

// ── Types ───────────────────────────────────────────────────────────────────

interface HealthCheck { name: string; status: "ok" | "warn" | "fail"; details: string; }
interface Lane { lane: string; maxConcurrent: number; active: number; queued: number; }
interface TelemetryByType { [key: string]: number; }
interface MemStats { totalMemories: number; storageBytes: number; vectorIndexed: number; }
interface BoardTask { status: string; }
interface Agent { id: string; name: string; isActive: boolean; isDefault: boolean; }
interface BoardRow { id: string; name: string; taskCount: number; }
interface ChannelSession { id: string; title: string; fastMode: boolean | null; }
interface ModelSummary { id: string; provider: string; name: string; isActive: boolean; fastMode: boolean; }
interface MachineSpecs {
  hostname: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  cpu: { model: string; logicalCores: number; speedMhz: number };
  memory: { totalGiB: number; usedGiB: number; usedPercent: number };
  disk: { totalGiB: number; freeGiB: number; freePercent: number; path: string };
}

type DayPoint = { day: string; calls: number; tokens: number; costUsd: number };

interface DashData {
  workflows: Workflow[];
  agents: Agent[];
  boards: BoardRow[];
  tasks: BoardTask[];
  sessions: ChannelSession[];
  memStats: MemStats | null;
  models: ModelSummary[];
  documentsCount: number;
  healthChecks: HealthCheck[];
  lanes: Lane[];
  telemetry: { totalEvents: number; windowHours: number; byType: TelemetryByType } | null;
  machine: MachineSpecs | null;
}

const EMPTY_DASH_DATA: DashData = {
  workflows: [],
  agents: [],
  boards: [],
  tasks: [],
  sessions: [],
  memStats: null,
  models: [],
  documentsCount: 0,
  healthChecks: [],
  lanes: [],
  telemetry: null,
  machine: null,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, icon, href,
}: {
  label: string; value: string | number; sub?: string;
  icon: React.ReactNode; href?: string;
}) {
  const content = (
    <div className="group relative border border-border bg-card p-4 transition-all hover:border-terminal-red">
      {/* Top-left corner accent */}
      <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-terminal-red" />
      {/* Bottom-right corner accent */}
      <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-terminal-red/30" />

      <div className="flex items-center justify-between pb-2">
        <span className="data-label text-muted-foreground">{label}</span>
        <div className="text-muted-foreground group-hover:text-terminal-red transition-colors">{icon}</div>
      </div>
      <div className="data-value text-3xl text-foreground">{value}</div>
      {sub && <p className="mt-1 text-[10px] text-muted-foreground font-mono uppercase tracking-wider">{sub}</p>}
      {href && (
        <ArrowRight className="absolute bottom-3 right-3 h-3 w-3 text-muted-foreground/30 group-hover:text-terminal-red transition-colors" />
      )}
    </div>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}

function HealthDot({ status }: { status: "ok" | "warn" | "fail" }) {
  if (status === "ok") return <span className="inline-block h-2 w-2 bg-foreground" />;
  if (status === "warn") return <span className="inline-block h-2 w-2 bg-terminal-red/60" />;
  return <span className="inline-block h-2 w-2 bg-terminal-red pulse-red" />;
}

function ActivityBar({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums text-foreground">{value.toLocaleString()}</span>
      </div>
      <div className="h-1 w-full overflow-hidden bg-border">
        <div
          className="h-full bg-terminal-red transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function LaneBadge({ lane }: { lane: Lane }) {
  const busy = lane.active > 0 || lane.queued > 0;
  return (
    <div className="flex items-center justify-between border border-border px-3 py-2 text-[10px] font-mono uppercase tracking-wider">
      <span className="font-medium">{lane.lane}</span>
      <div className="flex items-center gap-2">
        {busy
          ? <span className="text-terminal-red font-semibold">{lane.active} ACTIVE / {lane.queued} QUEUED</span>
          : <span className="text-muted-foreground">IDLE</span>}
        <span className="text-muted-foreground/50">/ {lane.maxConcurrent} MAX</span>
      </div>
    </div>
  );
}

function ActivitySparkline({ series }: { series: DayPoint[] }) {
  if (series.length === 0) {
    return (
      <p className="py-6 text-center text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
        No data yet
      </p>
    );
  }
  const W = 600;
  const H = 80;
  const PAD = { top: 8, right: 8, bottom: 20, left: 36 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const maxCalls = Math.max(...series.map((d) => d.calls), 1);
  const pts = series.map((d, i) => ({
    x: PAD.left + (i / Math.max(series.length - 1, 1)) * chartW,
    y: PAD.top + chartH - (d.calls / maxCalls) * chartH,
    d,
  }));

  const polyline = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath = [
    `M ${pts[0].x.toFixed(1)},${(PAD.top + chartH).toFixed(1)}`,
    ...pts.map((p) => `L ${p.x.toFixed(1)},${p.y.toFixed(1)}`),
    `L ${pts[pts.length - 1].x.toFixed(1)},${(PAD.top + chartH).toFixed(1)}`,
    "Z",
  ].join(" ");

  // Y-axis grid lines
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
    y: PAD.top + chartH - frac * chartH,
    label: frac === 0 ? "0" : Math.round(maxCalls * frac).toString(),
  }));

  // Show only every Nth day label to avoid crowding
  const step = series.length > 10 ? 2 : 1;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
      <defs>
        <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--terminal-red))" stopOpacity="0.25" />
          <stop offset="100%" stopColor="hsl(var(--terminal-red))" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* Grid lines */}
      {gridLines.map((g) => (
        <g key={g.y}>
          <line
            x1={PAD.left} y1={g.y} x2={W - PAD.right} y2={g.y}
            stroke="hsl(var(--border))" strokeWidth="0.5"
          />
          <text
            x={PAD.left - 4} y={g.y + 3}
            textAnchor="end" fontSize="7"
            fill="hsl(var(--muted-foreground))"
            fontFamily="monospace"
          >
            {g.label}
          </text>
        </g>
      ))}
      {/* Area fill */}
      <path d={areaPath} fill="url(#sparkGrad)" />
      {/* Line */}
      <polyline
        points={polyline}
        fill="none"
        stroke="hsl(var(--terminal-red))"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Day labels */}
      {pts.map((p, i) =>
        i % step === 0 ? (
          <text
            key={i}
            x={p.x} y={H - 2}
            textAnchor="middle" fontSize="7"
            fill="hsl(var(--muted-foreground))"
            fontFamily="monospace"
          >
            {p.d.day.slice(5)}
          </text>
        ) : null
      )}
      {/* Dot on last point */}
      {pts.length > 0 && (
        <circle
          cx={pts[pts.length - 1].x}
          cy={pts[pts.length - 1].y}
          r="2.5"
          fill="hsl(var(--terminal-red))"
        />
      )}
    </svg>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [data, setData] = useState<DashData>(EMPTY_DASH_DATA);
  const [loading, setLoading] = useState(true);
  const [quickCounts, setQuickCounts] = useState({
    agents: 0,
    workflows: 0,
    boards: 0,
    tasks: 0,
    orgs: 0,
    models: 0,
    activeModels: 0,
  });
  const [activitySeries, setActivitySeries] = useState<DayPoint[]>([]);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");

  useEffect(() => {
    fetch("/api/onboarding")
      .then((r) => r.json())
      .then((d) => { if (!d.onboardingDone) router.push("/onboarding"); else setChecking(false); })
      .catch(() => setChecking(false));
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    let secondaryTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelDashboardEnrichment = () => {
      cancelled = true;
      if (secondaryTimer) { clearTimeout(secondaryTimer); secondaryTimer = null; }
    };

    async function loadFullDashboardData() {
      try {
        const [wfRes, agRes, bRes, btRes] = await Promise.allSettled([
          cachedJson<any>("workflows", "/api/workflows", APP_TTL.workflows),
          cachedJson<any>("agents", "/api/agents", APP_TTL.agents),
          cachedJson<any>("boards", "/api/boards", APP_TTL.boards),
          cachedJson<any>("boards/tasks:main-board", "/api/boards/tasks?boardId=main-board&limit=200", 5_000),
        ]);

        const wf = wfRes.status === "fulfilled" && wfRes.value.success ? wfRes.value.data : [];
        const agents = agRes.status === "fulfilled" && agRes.value.success ? agRes.value.data.agents : [];
        const boards = bRes.status === "fulfilled" && bRes.value.success ? bRes.value.data : [];
        const tasks = btRes.status === "fulfilled" && btRes.value.success ? btRes.value.data : [];

        if (cancelled) return;
        setData({
          workflows: wf,
          agents,
          boards,
          tasks,
          sessions: [],
          memStats: null,
          models: [],
          documentsCount: 0,
          healthChecks: [],
          lanes: [],
          telemetry: null,
          machine: null,
        });

        secondaryTimer = setTimeout(async () => {
          const [docRes, memRes, mdlRes, sesRes, hlRes, rnRes, tlRes, sysRes, mtrRes] = await Promise.allSettled([
            cachedJson<any>("documents:dashboard", "/api/documents?limit=200", APP_TTL.documents),
            cachedJson<any>("memory:stats", "/api/memory?action=stats", 15_000),
            cachedJson<any>("models", "/api/models", APP_TTL.models),
            cachedJson<any>("channels:sessions", "/api/channels?action=sessions", APP_TTL.channels),
            cachedJson<any>("health", "/api/health", 10_000),
            cachedJson<any>("execute/running", "/api/execute/running", APP_TTL["execute/running"]),
            cachedJson<any>("telemetry", "/api/telemetry", APP_TTL.telemetry),
            cachedJson<any>("system:summary", "/api/system/summary", 30_000),
            cachedJson<any>("metrics:14", "/api/metrics?days=14", 30_000),
          ]);

          if (cancelled) return;
          const documents = docRes.status === "fulfilled" && docRes.value.success ? docRes.value.data : [];
          const memStats = memRes.status === "fulfilled" && memRes.value.success ? memRes.value.data : null;
          const models = mdlRes.status === "fulfilled" && mdlRes.value.success ? mdlRes.value.data : [];
          const sessions = sesRes.status === "fulfilled" && sesRes.value.success ? sesRes.value.data : [];
          const healthChecks = hlRes.status === "fulfilled" && hlRes.value.success ? hlRes.value.data.checks : [];
          const lanes = rnRes.status === "fulfilled" ? (rnRes.value.lanes ?? []) : [];
          const telemetry = tlRes.status === "fulfilled" && tlRes.value.success ? tlRes.value.data : null;
          const machine =
            sysRes.status === "fulfilled" && sysRes.value.success
              ? ((sysRes.value.data?.machine ?? null) as MachineSpecs | null)
              : null;
          const series: DayPoint[] =
            mtrRes.status === "fulfilled" && mtrRes.value.success
              ? ((mtrRes.value.data as { series?: DayPoint[] })?.series ?? [])
              : [];

          setActivitySeries(series);
          setData((current) => ({
            ...current,
            sessions,
            memStats,
            models,
            documentsCount: Array.isArray(documents) ? documents.length : 0,
            healthChecks,
            lanes,
            telemetry,
            machine,
          }));
        }, 15_000);
      } catch {
        // suppress errors during data load
      }
    }

    // Bootstrap: read from SSR-injected JSON when present (server component
    // pre-fetched it). Falls back to a network call otherwise (soft nav,
    // dev fast-refresh).
    let cancelFullData: (() => void) | null = null;
    const applyBootstrap = (b: {
      agents?: { count: number };
      workflows?: { count: number };
      boards?: { count: number };
      tasks?: { total: number };
      orgs?: { count: number };
      models?: { count: number; active: number };
    }) => {
      setQuickCounts({
        agents: b.agents?.count ?? 0,
        workflows: b.workflows?.count ?? 0,
        boards: b.boards?.count ?? 0,
        tasks: b.tasks?.total ?? 0,
        orgs: b.orgs?.count ?? 0,
        models: b.models?.count ?? 0,
        activeModels: b.models?.active ?? 0,
      });
      setLoading(false);
      cancelFullData = scheduleAfterUseful(() => {
        if (!cancelled) void loadFullDashboardData();
      });
    };

    const preloaded = readPreloadedBootstrap<{
      agents?: { count: number };
      workflows?: { count: number };
      boards?: { count: number };
      tasks?: { total: number };
      orgs?: { count: number };
    }>("dashboard");
    if (preloaded) {
      applyBootstrap(preloaded);
    } else {
      fetch("/api/dashboard/bootstrap")
        .then(r => r.json())
        .then(json => {
          if (cancelled || !json.success) return;
          applyBootstrap(json.data);
        })
        .catch(() => {});
    }

    window.addEventListener("disp8ch:navigation-start", cancelDashboardEnrichment);
    return () => {
      window.removeEventListener("disp8ch:navigation-start", cancelDashboardEnrichment);
      cancelDashboardEnrichment();
      cancelFullData?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen((value) => !value);
      }
      if (event.key === "Escape") {
        setCommandPaletteOpen(false);
        setCommandPaletteQuery("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!commandPaletteOpen) {
      setCommandPaletteQuery("");
    }
  }, [commandPaletteOpen]);

  // ── Derived values ────────────────────────────────────────────────────────

  const hasFullStats = (data?.workflows ?? []).length > 0 || (data?.agents ?? []).length > 0;
  const activeWorkflows = hasFullStats
    ? (data?.workflows.filter((w) => w.isActive).length ?? 0)
    : quickCounts.workflows;
  const totalWorkflows = hasFullStats
    ? (data?.workflows.length ?? 0)
    : quickCounts.workflows;
  const activeAgents = hasFullStats
    ? (data?.agents.filter((a) => a.isActive).length ?? 0)
    : quickCounts.agents;
  const totalTasks = hasFullStats
    ? (data?.boards.reduce((s, b) => s + b.taskCount, 0) ?? 0)
    : quickCounts.tasks;
  const memories = data?.memStats?.totalMemories ?? 0;
  const activeModels = (data?.models ?? []).filter((model) => model.isActive);
  const activeModelCount = (data?.models ?? []).length > 0 ? activeModels.length : quickCounts.activeModels;
  const totalModelCount = (data?.models ?? []).length > 0 ? data.models.length : quickCounts.models;
  const fastDefaultModels = activeModels.filter((model) => model.fastMode).length;
  const recentSessions = (data?.sessions ?? []).slice(0, 5);

  const tasksByStatus = (data?.tasks ?? []).reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  const tel = data?.telemetry;
  const execTotal = (tel?.byType["workflow.complete"] ?? 0) + (tel?.byType["workflow.failed"] ?? 0);
  const execSuccess = tel?.byType["workflow.complete"] ?? 0;
  const successRate = execTotal > 0 ? Math.round((execSuccess / execTotal) * 100) : 100;
  const telTotal = Object.values(tel?.byType ?? {}).reduce((s, v) => s + v, 0);

  const healthStatus = (data?.healthChecks ?? []).reduce<"ok" | "warn" | "fail">((worst, c) => {
    if (c.status === "fail") return "fail";
    if (c.status === "warn" && worst !== "fail") return "warn";
    return worst;
  }, "ok");

  const recentWorkflows = (data?.workflows ?? []).filter((w) => w.isActive).slice(0, 5);
  const queuedLanes = (data?.lanes ?? []).filter((lane) => lane.queued > 0);
  const attentionItems = [
    healthStatus !== "ok"
      ? {
          label: healthStatus === "fail" ? "System health degraded" : "Warnings detected",
          detail: `${(data?.healthChecks ?? []).filter((check) => check.status !== "ok").length} health checks need review`,
          href: "/debug",
        }
      : null,
    activeModelCount === 0
      ? {
          label: "No active model selected",
          detail: "Configure a live provider before running agent work",
          href: "/settings",
        }
      : null,
    (tel?.byType["workflow.failed"] ?? 0) > 0
      ? {
          label: "Workflow failures recorded",
          detail: `${tel?.byType["workflow.failed"] ?? 0} failure events in the last 24h`,
          href: "/activity",
        }
      : null,
    queuedLanes.length > 0
      ? {
          label: "Queued execution work",
          detail: `${queuedLanes.reduce((sum, lane) => sum + lane.queued, 0)} queued jobs across ${queuedLanes.length} lanes`,
          href: "/running",
        }
      : null,
  ].filter((item): item is { label: string; detail: string; href: string } => Boolean(item));
  const commandPaletteItems = [
    { href: "/chat", label: "Open Chat", hint: "Webchat and session controls" },
    { href: "/agents", label: "Open Agents", hint: "Roles, skills, and extensions" },
    { href: "/workflows", label: "Open Workflows", hint: "Templates and visual editor" },
    { href: "/boards", label: "Open Boards", hint: "Task queues and workflow-backed tasks" },
    { href: "/hierarchy", label: "Open Hierarchy", hint: "Organizations, goals, and org chart" },
    { href: "/council", label: "Open Council", hint: "Multi-agent voting and debate" },
    { href: "/documents", label: "Open Data Sources", hint: "Uploads, scrape, and crawl" },
    { href: "/memory", label: "Open Memory", hint: "Memory journal and diagnostics" },
    { href: "/channels", label: "Open Channels", hint: "Channel connectivity and status" },
    { href: "/settings", label: "Open Settings", hint: "Models, tools, channels, config" },
    { href: "/activity", label: "Open Activity", hint: "Executions and telemetry" },
    { href: "/debug", label: "Open Debug", hint: "Diagnostics and raw runtime state" },
  ];
  const filteredCommandPaletteItems = commandPaletteItems.filter((item) => {
    const query = commandPaletteQuery.trim().toLowerCase();
    if (!query) return true;
    return (
      item.label.toLowerCase().includes(query) ||
      item.hint.toLowerCase().includes(query) ||
      item.href.toLowerCase().includes(query)
    );
  });

  // ── Render ────────────────────────────────────────────────────────────────

  return (
      <>
        <main className="flex-1 overflow-auto bg-background grid-bg">
          {/* ── Page Header ── */}
          <div className="border-b border-border px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-8 w-1 bg-terminal-red" />
                <div>
                  <h1 className="font-display text-xl font-bold tracking-tight uppercase">Dashboard</h1>
                  <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">System overview // live snapshot</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setCommandPaletteOpen(true);
                    setCommandPaletteQuery("");
                  }}
                  className="flex items-center gap-2 border border-border px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:border-terminal-red hover:text-terminal-red"
                >
                  <Search className="h-3.5 w-3.5" />
                  Command Palette
                </button>
                {healthStatus === "ok" && (
                  <Badge variant="outline" className="gap-1.5 text-foreground border-foreground/30 text-[10px] uppercase tracking-widest">
                    <span className="h-1.5 w-1.5 bg-foreground" />
                    ALL SYSTEMS NOMINAL
                  </Badge>
                )}
                {healthStatus === "warn" && (
                  <Badge variant="outline" className="gap-1.5 text-terminal-red border-terminal-red/40 text-[10px] uppercase tracking-widest">
                    <span className="h-1.5 w-1.5 bg-terminal-red/60" />
                    WARNINGS DETECTED
                  </Badge>
                )}
                {healthStatus === "fail" && (
                  <Badge variant="outline" className="gap-1.5 text-terminal-red border-terminal-red text-[10px] uppercase tracking-widest">
                    <span className="h-1.5 w-1.5 bg-terminal-red pulse-red" />
                    SYSTEM ERROR
                  </Badge>
                )}
              </div>
            </div>
          </div>

          <div className="p-6 space-y-6">
            <div className="flex items-center justify-between border border-border bg-card/60 px-3 py-2 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              <span>{checking ? "Checking workspace access..." : loading ? "Loading live snapshot..." : "Snapshot ready"}</span>
              <span>{loading ? "Background data will fill in as it arrives" : "Live data cached for fast tab returns"}</span>
            </div>
                {/* ── KPI Row 1 ── */}
                <div data-perf-ready="dashboard" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <StatCard
                    label="Active Workflows"
                    value={activeWorkflows}
                    sub={`${totalWorkflows} total`}
                    icon={<GitBranch className="h-4 w-4" />}
                    href="/workflows"
                  />
                  <StatCard
                    label="Agents"
                    value={activeAgents}
                    sub={`${data?.agents.length ?? 0} registered`}
                    icon={<Bot className="h-4 w-4" />}
                    href="/agents"
                  />
                  <StatCard
                    label="Board Tasks"
                    value={totalTasks}
                    sub={`${tasksByStatus["inbox"] ?? 0} inbox // ${tasksByStatus["in_progress"] ?? 0} in progress`}
                    icon={<Kanban className="h-4 w-4" />}
                    href="/boards"
                  />
                  <StatCard
                    label="Memories"
                    value={memories}
                    sub={data?.memStats ? fmtBytes(data.memStats.storageBytes) : "—"}
                    icon={<Brain className="h-4 w-4" />}
                    href="/memory"
                  />
                </div>

                {/* ── KPI Row 2 ── */}
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <StatCard
                    label="Executions (24h)"
                    value={execTotal}
                    sub={`${execSuccess} completed`}
                    icon={<Zap className="h-4 w-4" />}
                    href="/usage"
                  />
                  <StatCard
                    label="Success Rate"
                    value={`${successRate}%`}
                    sub={`${tel?.byType["workflow.failed"] ?? 0} failed`}
                    icon={<Shield className="h-4 w-4" />}
                    href="/usage"
                  />
                  <StatCard
                    label="Active Models"
                    value={activeModelCount}
                    sub={fastDefaultModels > 0 ? `${fastDefaultModels} fast defaults` : `${totalModelCount} configured`}
                    icon={<Cpu className="h-4 w-4" />}
                    href="/settings"
                  />
                  <StatCard
                    label="Data Sources"
                    value={data?.documentsCount ?? 0}
                    sub="uploads, scrapes, and crawls"
                    icon={<FileText className="h-4 w-4" />}
                    href="/documents"
                  />
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                  <Card>
                    <CardHeader className="pb-3 pt-4 px-5">
                      <CardTitle className="text-xs font-semibold flex items-center gap-2 uppercase tracking-widest">
                        <AlertCircle className="h-3.5 w-3.5 text-terminal-red" />
                        Needs Attention
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-5 pb-4">
                      {attentionItems.length === 0 ? (
                        <div className="border border-border px-3 py-3 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                          No immediate warnings. The operator attention rollup is clear.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {attentionItems.map((item) => (
                            <Link
                              key={item.label}
                              href={item.href}
                              className="flex items-center justify-between border border-border px-3 py-3 hover:border-terminal-red transition-colors"
                            >
                              <div>
                                <div className="text-xs font-medium">{item.label}</div>
                                <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                                  {item.detail}
                                </div>
                              </div>
                              <ArrowRight className="h-3 w-3 text-muted-foreground" />
                            </Link>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-3 pt-4 px-5">
                      <CardTitle className="text-xs font-semibold flex items-center gap-2 uppercase tracking-widest">
                        <Terminal className="h-3.5 w-3.5 text-terminal-red" />
                        Quick Actions
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-5 pb-4">
                      <div className="grid gap-2 sm:grid-cols-2">
                        {[
                          { href: "/chat", label: "New Session", detail: "Open chat and session controls", icon: <MessageSquare className="h-3.5 w-3.5" /> },
                          { href: "/workflows", label: "Run Workflow", detail: "Jump into the workflow editor", icon: <GitBranch className="h-3.5 w-3.5" /> },
                          { href: "/scheduler", label: "Automation", detail: "Check cron jobs and schedules", icon: <Zap className="h-3.5 w-3.5" /> },
                          { href: "/usage", label: "Usage Review", detail: "Inspect runs, rate, and reliability", icon: <Activity className="h-3.5 w-3.5" /> },
                        ].map((item) => (
                          <Link
                            key={item.href}
                            href={item.href}
                            className="group border border-border px-3 py-3 hover:border-terminal-red transition-colors"
                          >
                            <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest">
                              <span className="text-muted-foreground group-hover:text-terminal-red transition-colors">{item.icon}</span>
                              {item.label}
                            </div>
                            <div className="mt-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                              {item.detail}
                            </div>
                          </Link>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* ── Mid Row: Health + Activity ── */}
                <div className="grid gap-3 lg:grid-cols-2">
                  {/* System Health */}
                  <Card>
                    <CardHeader className="pb-3 pt-4 px-5">
                      <CardTitle className="text-xs font-semibold flex items-center gap-2 uppercase tracking-widest">
                        <Database className="h-3.5 w-3.5 text-terminal-red" />
                        System Health
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-5 pb-4 space-y-2">
                      {(data?.healthChecks ?? []).map((c) => (
                        <div key={c.name} className="flex items-center justify-between border border-border px-3 py-2">
                          <div className="flex items-center gap-2.5">
                            <HealthDot status={c.status} />
                            <span className="text-[10px] font-mono font-medium uppercase tracking-wider">{c.name.replace("-", " ")}</span>
                          </div>
                          <span className="text-[10px] text-muted-foreground truncate max-w-[200px] text-right font-mono">{c.details}</span>
                        </div>
                      ))}
                      <div className="pt-2 border-t border-border space-y-1.5">
                        <p className="data-label text-muted-foreground pb-1">Execution Lanes</p>
                        {(data?.lanes ?? []).map((lane) => (
                          <LaneBadge key={lane.lane} lane={lane} />
                        ))}
                      </div>
                    </CardContent>
                  </Card>

                  {/* Telemetry Activity */}
                  <Card>
                    <CardHeader className="pb-3 pt-4 px-5">
                      <CardTitle className="text-xs font-semibold flex items-center justify-between uppercase tracking-widest">
                        <span className="flex items-center gap-2">
                          <Radio className="h-3.5 w-3.5 text-terminal-red" />
                          Activity (24h)
                        </span>
                        {tel && (
                          <span className="text-[10px] font-mono font-normal text-muted-foreground">
                            {tel.totalEvents.toLocaleString()} events
                          </span>
                        )}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-5 pb-4 space-y-3">
                      {tel ? (
                        <>
                          <ActivityBar label="Workflow starts" value={tel.byType["workflow.start"] ?? 0} total={telTotal} />
                          <ActivityBar label="Workflow completions" value={tel.byType["workflow.complete"] ?? 0} total={telTotal} />
                          <ActivityBar label="Node completions" value={tel.byType["workflow.node_complete"] ?? 0} total={telTotal} />
                          <ActivityBar label="Memory stores" value={tel.byType["memory.stored"] ?? 0} total={telTotal} />
                          <ActivityBar label="Tool calls" value={tel.byType["tool.call"] ?? 0} total={telTotal} />
                          <ActivityBar label="Failures" value={tel.byType["workflow.failed"] ?? 0} total={telTotal} />
                        </>
                      ) : (
                        <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">No telemetry data available.</p>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {/* ── 14-Day Execution Trend ── */}
                <Card>
                  <CardHeader className="pb-3 pt-4 px-5">
                    <CardTitle className="text-xs font-semibold flex items-center justify-between uppercase tracking-widest">
                      <span className="flex items-center gap-2">
                        <TrendingUp className="h-3.5 w-3.5 text-terminal-red" />
                        Execution Trend (14 days)
                      </span>
                      <Link href="/metrics" className="text-[10px] font-mono font-normal text-muted-foreground hover:text-terminal-red flex items-center gap-1 transition-colors">
                        FULL METRICS <ArrowRight className="h-2.5 w-2.5" />
                      </Link>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-5 pb-4">
                    <ActivitySparkline series={activitySeries} />
                    {activitySeries.length > 0 && (
                      <div className="mt-2 flex items-center gap-4 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                        <span>
                          Total calls:{" "}
                          <span className="font-semibold text-foreground">
                            {activitySeries.reduce((s, d) => s + d.calls, 0).toLocaleString()}
                          </span>
                        </span>
                        <span>
                          Peak day:{" "}
                          <span className="font-semibold text-foreground">
                            {Math.max(...activitySeries.map((d) => d.calls)).toLocaleString()} calls
                          </span>
                        </span>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* ── Bottom Row: Workflows + Task Board ── */}
                <div className="grid gap-3 lg:grid-cols-2">
                  <Card>
                    <CardHeader className="pb-3 pt-4 px-5">
                      <CardTitle className="text-xs font-semibold flex items-center justify-between uppercase tracking-widest">
                        <span className="flex items-center gap-2">
                          <Server className="h-3.5 w-3.5 text-terminal-red" />
                          Machine Specs
                        </span>
                        <Link href="/debug" className="text-[10px] font-mono font-normal text-muted-foreground hover:text-terminal-red flex items-center gap-1 transition-colors">
                          OPEN DEBUG <ArrowRight className="h-2.5 w-2.5" />
                        </Link>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-5 pb-4 space-y-2">
                      {data?.machine ? (
                        <>
                          <div className="flex items-center justify-between border border-border px-3 py-2 text-[10px] font-mono uppercase tracking-wider">
                            <span className="text-muted-foreground">CPU</span>
                            <span className="text-right text-foreground">{data.machine.cpu.logicalCores} cores • {data.machine.cpu.model}</span>
                          </div>
                          <div className="flex items-center justify-between border border-border px-3 py-2 text-[10px] font-mono uppercase tracking-wider">
                            <span className="text-muted-foreground">RAM</span>
                            <span className="text-right text-foreground">{data.machine.memory.usedGiB}/{data.machine.memory.totalGiB} GB ({data.machine.memory.usedPercent}%)</span>
                          </div>
                          <div className="flex items-center justify-between border border-border px-3 py-2 text-[10px] font-mono uppercase tracking-wider">
                            <span className="text-muted-foreground">Storage</span>
                            <span className="text-right text-foreground">{data.machine.disk.freeGiB} GB free ({data.machine.disk.freePercent}%)</span>
                          </div>
                          <div className="flex items-center justify-between border border-border px-3 py-2 text-[10px] font-mono uppercase tracking-wider">
                            <span className="text-muted-foreground">Runtime</span>
                            <span className="text-right text-foreground">{data.machine.platform}/{data.machine.arch} • {data.machine.nodeVersion}</span>
                          </div>
                        </>
                      ) : (
                        <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Machine specs unavailable.</p>
                      )}
                    </CardContent>
                  </Card>

                  {/* Active Workflows */}
                  <Card>
                    <CardHeader className="pb-3 pt-4 px-5">
                      <CardTitle className="text-xs font-semibold flex items-center justify-between uppercase tracking-widest">
                        <span className="flex items-center gap-2">
                          <GitBranch className="h-3.5 w-3.5 text-terminal-red" />
                          Active Workflows
                        </span>
                        <Link href="/workflows" className="text-[10px] font-mono font-normal text-muted-foreground hover:text-terminal-red flex items-center gap-1 transition-colors">
                          VIEW ALL <ArrowRight className="h-2.5 w-2.5" />
                        </Link>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-5 pb-4">
                      {recentWorkflows.length === 0 ? (
                        <p className="text-[10px] text-muted-foreground py-4 text-center font-mono uppercase tracking-wider">
                          No active workflows. <Link href="/workflows" className="text-terminal-red hover:underline">Create one</Link>.
                        </p>
                      ) : (
                        <div className="space-y-1">
                          {recentWorkflows.map((wf) => (
                            <Link
                              key={wf.id}
                              href={`/workflows/${wf.id}`}
                              className="flex items-center justify-between border border-border px-3 py-2 hover:border-terminal-red transition-colors group"
                            >
                              <div>
                                <p className="text-xs font-medium truncate max-w-[200px]">{wf.name}</p>
                                {wf.description && (
                                  <p className="text-[10px] text-muted-foreground truncate max-w-[200px] font-mono">{wf.description}</p>
                                )}
                              </div>
                              <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0 border-terminal-red/40 text-terminal-red">
                                ACTIVE
                              </Badge>
                            </Link>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-3 pt-4 px-5">
                      <CardTitle className="text-xs font-semibold flex items-center justify-between uppercase tracking-widest">
                        <span className="flex items-center gap-2">
                          <MessageSquare className="h-3.5 w-3.5 text-terminal-red" />
                          Recent Sessions
                        </span>
                        <Link href="/chat" className="text-[10px] font-mono font-normal text-muted-foreground hover:text-terminal-red flex items-center gap-1 transition-colors">
                          OPEN CHAT <ArrowRight className="h-2.5 w-2.5" />
                        </Link>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-5 pb-4">
                      {recentSessions.length === 0 ? (
                        <p className="text-[10px] text-muted-foreground py-4 text-center font-mono uppercase tracking-wider">
                          No saved sessions yet.
                        </p>
                      ) : (
                        <div className="space-y-1">
                          {recentSessions.map((session) => (
                            <Link
                              key={session.id}
                              href="/chat"
                              className="flex items-center justify-between border border-border px-3 py-2 hover:border-terminal-red transition-colors group"
                            >
                              <div className="min-w-0">
                                <p className="text-xs font-medium truncate">{session.title}</p>
                                <p className="text-[10px] text-muted-foreground font-mono truncate">{session.id}</p>
                              </div>
                              {session.fastMode === true ? (
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0 border-terminal-red/40 text-terminal-red">
                                  FAST
                                </Badge>
                              ) : (
                                <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/70">
                                  Session
                                </span>
                              )}
                            </Link>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Task Board Summary */}
                  <Card>
                    <CardHeader className="pb-3 pt-4 px-5">
                      <CardTitle className="text-xs font-semibold flex items-center justify-between uppercase tracking-widest">
                        <span className="flex items-center gap-2">
                          <Kanban className="h-3.5 w-3.5 text-terminal-red" />
                          Task Board
                        </span>
                        <Link href="/boards" className="text-[10px] font-mono font-normal text-muted-foreground hover:text-terminal-red flex items-center gap-1 transition-colors">
                          OPEN BOARD <ArrowRight className="h-2.5 w-2.5" />
                        </Link>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-5 pb-4 space-y-3">
                      {[
                        { key: "inbox", label: "INBOX" },
                        { key: "in_progress", label: "IN PROGRESS" },
                        { key: "review", label: "REVIEW" },
                        { key: "done", label: "DONE" },
                      ].map(({ key, label }) => (
                        <div key={key} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className={`h-2 w-2 ${key === "done" ? "bg-foreground" : "bg-terminal-red"} ${key === "in_progress" ? "pulse-red" : ""}`} />
                            <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">{label}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="h-1 w-24 overflow-hidden bg-border">
                              <div
                                className="h-full bg-terminal-red"
                                style={{ width: totalTasks > 0 ? `${Math.round(((tasksByStatus[key] ?? 0) / totalTasks) * 100)}%` : "0%" }}
                              />
                            </div>
                            <span className="text-xs font-mono font-semibold tabular-nums w-6 text-right">{tasksByStatus[key] ?? 0}</span>
                          </div>
                        </div>
                      ))}
                      <div className="pt-2 border-t border-border flex items-center justify-between text-[10px] font-mono uppercase tracking-wider">
                        <span className="text-muted-foreground">Total tasks</span>
                        <span className="font-bold text-foreground">{totalTasks}</span>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* ── Quick Nav ── */}
                <Card>
                  <CardHeader className="pb-3 pt-4 px-5">
                    <CardTitle className="text-xs font-semibold flex items-center gap-2 uppercase tracking-widest">
                      <Terminal className="h-3.5 w-3.5 text-terminal-red" />
                      Quick Navigation
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-5 pb-4">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
                      {[
                        { href: "/channels", label: "Channels", icon: <MessageSquare className="h-3.5 w-3.5" /> },
                        { href: "/activity", label: "Activity", icon: <Clock className="h-3.5 w-3.5" /> },
                        { href: "/memory", label: "Memory", icon: <Brain className="h-3.5 w-3.5" /> },
                        { href: "/documents", label: "Data Sources", icon: <FileText className="h-3.5 w-3.5" /> },
                        { href: "/settings", label: "Settings", icon: <Layers className="h-3.5 w-3.5" /> },
                      ].map(({ href, label, icon }) => (
                        <Link
                          key={href}
                          href={href}
                          className="group flex items-center gap-2 border border-border px-3 py-2.5 text-[10px] font-mono font-medium uppercase tracking-wider hover:border-terminal-red hover:text-terminal-red transition-colors"
                        >
                          <span className="text-muted-foreground group-hover:text-terminal-red transition-colors">{icon}</span>
                          {label}
                        </Link>
                      ))}
                    </div>
                  </CardContent>
                </Card>
          </div>
        </main>
      {commandPaletteOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 px-4 pt-24 backdrop-blur-sm">
          <div className="w-full max-w-xl border border-terminal-red bg-card p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-muted-foreground">
                <Search className="h-4 w-4 text-terminal-red" />
                Command Palette
              </div>
              <button
                type="button"
                onClick={() => {
                  setCommandPaletteOpen(false);
                  setCommandPaletteQuery("");
                }}
                className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-terminal-red"
              >
                Esc
              </button>
            </div>
            <input
              autoFocus
              value={commandPaletteQuery}
              onChange={(event) => setCommandPaletteQuery(event.target.value)}
              placeholder="Search pages and actions..."
              className="mb-3 w-full border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-terminal-red"
            />
            <div className="grid gap-2 sm:grid-cols-2">
              {filteredCommandPaletteItems.length > 0 ? (
                filteredCommandPaletteItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => {
                      setCommandPaletteOpen(false);
                      setCommandPaletteQuery("");
                    }}
                    className="border border-border px-3 py-3 text-left hover:border-terminal-red hover:text-terminal-red"
                  >
                    <div className="text-xs font-mono uppercase tracking-wider">{item.label}</div>
                    <div className="mt-1 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                      {item.hint}
                    </div>
                  </Link>
                ))
              ) : (
                <div className="border border-dashed border-border px-3 py-6 text-center text-xs font-mono uppercase tracking-widest text-muted-foreground sm:col-span-2">
                  No matching actions
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
