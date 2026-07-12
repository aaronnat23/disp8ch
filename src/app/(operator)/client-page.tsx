"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  GitBranch, MessageSquare, Zap, Activity,
  AlertCircle, ArrowRight, Search,
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

function Section({
  title, action, children, className = "", contentClassName = "",
}: {
  title: string; action?: React.ReactNode; children: React.ReactNode;
  className?: string; contentClassName?: string;
}) {
  return (
    <section className={`border border-border bg-card ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <h2 className="flex items-center gap-2 font-display text-[11px] font-semibold uppercase leading-none tracking-[0.14em] text-foreground">
          <span className="h-1.5 w-1.5 bg-terminal-red" />
          {title}
        </h2>
        {action}
      </header>
      <div className={`p-5 ${contentClassName}`}>{children}</div>
    </section>
  );
}

function SectionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-terminal-red"
    >
      {children} <ArrowRight className="h-2.5 w-2.5" />
    </Link>
  );
}

function KpiCell({
  label, value, sub, href,
}: {
  label: string; value: string | number; sub?: string; href: string;
}) {
  return (
    <Link
      href={href}
      className="group relative flex flex-col gap-1.5 bg-card px-5 py-4 transition-colors hover:bg-accent/50"
    >
      <span className="data-label text-muted-foreground">{label}</span>
      <span className="font-display text-[2.4rem] font-semibold leading-none text-foreground">{value}</span>
      {sub && <span className="font-mono text-[11px] text-muted-foreground">{sub}</span>}
      <ArrowRight className="absolute right-4 top-4 h-3.5 w-3.5 text-transparent transition-colors group-hover:text-terminal-red" />
    </Link>
  );
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
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-xs font-semibold tabular-nums text-foreground">{value.toLocaleString()}</span>
      </div>
      <div className="h-1 w-full overflow-hidden bg-border/60">
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
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2 text-xs last:border-b-0">
      <span className="font-medium text-foreground">{lane.lane}</span>
      <span className="font-mono text-[11px]">
        {busy
          ? <span className="text-terminal-red">{lane.active} active · {lane.queued} queued</span>
          : <span className="text-muted-foreground">idle</span>}
        <span className="text-muted-foreground/60"> / {lane.maxConcurrent} max</span>
      </span>
    </div>
  );
}

function TrendChart({ series }: { series: DayPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (series.length === 0) {
    return (
      <p className="py-10 text-center font-mono text-xs text-muted-foreground">
        No execution data yet
      </p>
    );
  }
  const W = 600;
  const H = 170;
  const PAD = { top: 12, right: 12, bottom: 22, left: 40 };
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

  const hover = hoverIdx != null ? pts[hoverIdx] : null;

  const handleMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * W;
    let nearest = 0;
    let best = Infinity;
    pts.forEach((p, i) => {
      const dist = Math.abs(p.x - x);
      if (dist < best) { best = dist; nearest = i; }
    });
    setHoverIdx(nearest);
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none"
        style={{ height: H }}
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--terminal-red)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--terminal-red)" stopOpacity="0.02" />
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
              x={PAD.left - 6} y={g.y + 3}
              textAnchor="end" fontSize="8"
              fill="hsl(var(--muted-foreground))"
              fontFamily="var(--font-mono), monospace"
            >
              {g.label}
            </text>
          </g>
        ))}
        {/* Area fill */}
        <path d={areaPath} fill="url(#trendGrad)" />
        {/* Line */}
        <polyline
          points={polyline}
          fill="none"
          stroke="var(--terminal-red)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Day labels */}
        {pts.map((p, i) =>
          i % step === 0 ? (
            <text
              key={i}
              x={p.x} y={H - 4}
              textAnchor="middle" fontSize="8"
              fill="hsl(var(--muted-foreground))"
              fontFamily="var(--font-mono), monospace"
            >
              {p.d.day.slice(5)}
            </text>
          ) : null
        )}
        {/* Crosshair + hovered point */}
        {hover && (
          <g>
            <line
              x1={hover.x} y1={PAD.top} x2={hover.x} y2={PAD.top + chartH}
              stroke="hsl(var(--muted-foreground))" strokeWidth="0.5" strokeDasharray="3 3"
            />
            <circle cx={hover.x} cy={hover.y} r="3.5" fill="var(--terminal-red)" stroke="hsl(var(--card))" strokeWidth="1.5" />
          </g>
        )}
        {/* Dot on last point */}
        {!hover && (
          <circle
            cx={pts[pts.length - 1].x}
            cy={pts[pts.length - 1].y}
            r="3"
            fill="var(--terminal-red)"
          />
        )}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute top-1 -translate-x-1/2 border border-border bg-popover px-2.5 py-1.5 font-mono text-[11px] leading-snug shadow-sm"
          style={{ left: `${Math.min(86, Math.max(14, (hover.x / W) * 100))}%` }}
        >
          <div className="text-muted-foreground">{hover.d.day}</div>
          <div className="font-semibold text-foreground">{hover.d.calls.toLocaleString()} calls</div>
          {hover.d.costUsd > 0 && <div className="text-muted-foreground">${hover.d.costUsd.toFixed(2)}</div>}
        </div>
      )}
    </div>
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

  const activeJobs = (data?.lanes ?? []).reduce((sum, lane) => sum + lane.active, 0);
  const headline = checking || loading
    ? "Bringing the console up…"
    : attentionItems.length > 0
      ? `${attentionItems.length} ${attentionItems.length === 1 ? "item needs" : "items need"} your attention.`
      : activeJobs > 0
        ? `${activeJobs} ${activeJobs === 1 ? "job is" : "jobs are"} running right now.`
        : "All quiet. Systems standing by.";

  const quickActions = [
    { href: "/chat", label: "New session", icon: <MessageSquare className="h-3.5 w-3.5" /> },
    { href: "/workflows", label: "Run a workflow", icon: <GitBranch className="h-3.5 w-3.5" /> },
    { href: "/scheduler", label: "Automations", icon: <Zap className="h-3.5 w-3.5" /> },
    { href: "/usage", label: "Usage review", icon: <Activity className="h-3.5 w-3.5" /> },
  ];

  return (
      <>
        <main className="flex-1 overflow-auto bg-background grid-bg">
          {/* ── Hero ── */}
          <div className="border-b border-border px-6 pb-6 pt-8 lg:px-8">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="min-w-0">
                <p className="data-label text-terminal-red">
                  Operations console
                  <span suppressHydrationWarning className="text-muted-foreground">
                    {" — "}
                    {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                  </span>
                </p>
                <h1 className="mt-3 font-display text-3xl font-semibold leading-[1.1] text-foreground lg:text-4xl">
                  <span className="mr-3 select-none text-terminal-red">&gt;</span>
                  <span className="terminal-cursor">{headline}</span>
                </h1>
                <div className="mt-5 flex flex-wrap gap-2">
                  {quickActions.map((action) => (
                    <Link
                      key={action.href}
                      href={action.href}
                      className="clip-chamfer-sm flex items-center gap-2 bg-secondary px-3.5 py-2 font-display text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-terminal-red hover:text-primary-foreground"
                    >
                      {action.icon}
                      {action.label}
                    </Link>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setCommandPaletteOpen(true);
                    setCommandPaletteQuery("");
                  }}
                  className="flex items-center gap-2 border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-terminal-red hover:text-terminal-red"
                >
                  <Search className="h-3.5 w-3.5" />
                  Command palette
                  <kbd className="border border-border bg-background px-1 py-0.5 font-mono text-[10px]">⌘K</kbd>
                </button>
                {!loading && healthStatus === "ok" && (
                  <span className="flex items-center gap-1.5 border border-border bg-card px-2.5 py-[7px] font-mono text-[11px] text-muted-foreground">
                    <span className="h-1.5 w-1.5 bg-foreground/70" />
                    all clear
                  </span>
                )}
                {!loading && healthStatus === "warn" && (
                  <span className="flex items-center gap-1.5 border border-terminal-red/40 bg-card px-2.5 py-[7px] font-mono text-[11px] text-terminal-red">
                    <span className="h-1.5 w-1.5 bg-terminal-red/60" />
                    warnings
                  </span>
                )}
                {!loading && healthStatus === "fail" && (
                  <span className="flex items-center gap-1.5 border border-terminal-red bg-card px-2.5 py-[7px] font-mono text-[11px] text-terminal-red">
                    <span className="h-1.5 w-1.5 bg-terminal-red pulse-red" />
                    system error
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-5 p-6 lg:p-8">
            {(checking || loading) && (
              <p className="font-mono text-[11px] text-muted-foreground">
                {checking ? "Checking workspace access…" : "Loading live snapshot — background data fills in as it arrives."}
              </p>
            )}

            {/* ── Needs attention ── */}
            {attentionItems.length > 0 && (
              <div className="border border-terminal-red/50 bg-card">
                <div className="flex items-center gap-2 border-b border-terminal-red/30 px-5 py-3">
                  <AlertCircle className="h-4 w-4 text-terminal-red" />
                  <h2 className="font-display text-[11px] font-semibold uppercase leading-none tracking-[0.14em] text-foreground">Needs attention</h2>
                </div>
                <div>
                  {attentionItems.map((item) => (
                    <Link
                      key={item.label}
                      href={item.href}
                      className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-3 transition-colors last:border-b-0 hover:bg-accent/50"
                    >
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-foreground">{item.label}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{item.detail}</div>
                      </div>
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-terminal-red" />
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* ── KPI band ── */}
            <div data-perf-ready="dashboard" className="hud-frame grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
              <KpiCell
                label="Active workflows"
                value={activeWorkflows}
                sub={`${totalWorkflows} total`}
                href="/workflows"
              />
              <KpiCell
                label="Agents"
                value={activeAgents}
                sub={`${hasFullStats ? data?.agents.length ?? 0 : quickCounts.agents} registered`}
                href="/agents"
              />
              <KpiCell
                label="Board tasks"
                value={totalTasks}
                sub={`${tasksByStatus["inbox"] ?? 0} inbox · ${tasksByStatus["in_progress"] ?? 0} in progress`}
                href="/boards"
              />
              <KpiCell
                label="Runs, last 24h"
                value={execTotal}
                sub={`${successRate}% success · ${tel?.byType["workflow.failed"] ?? 0} failed`}
                href="/usage"
              />
            </div>

            {/* ── Inventory strip ── */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-1 font-mono text-[11px] text-muted-foreground">
              <Link href="/memory" className="transition-colors hover:text-terminal-red">
                memory {memories}{data?.memStats ? ` · ${fmtBytes(data.memStats.storageBytes)}` : ""}
              </Link>
              <Link href="/settings" className="transition-colors hover:text-terminal-red">
                models {activeModelCount}/{totalModelCount}{fastDefaultModels > 0 ? ` · ${fastDefaultModels} fast` : ""}
              </Link>
              <Link href="/documents" className="transition-colors hover:text-terminal-red">
                data sources {data?.documentsCount ?? 0}
              </Link>
              <Link href="/chat" className="transition-colors hover:text-terminal-red">
                sessions {(data?.sessions ?? []).length}
              </Link>
            </div>

            {/* ── Execution trend ── */}
            <Section
              title="Execution trend, 14 days"
              action={<SectionLink href="/metrics">full metrics</SectionLink>}
            >
              <TrendChart series={activitySeries} />
              {activitySeries.length > 0 && (
                <div className="mt-3 flex items-center gap-5 font-mono text-[11px] text-muted-foreground">
                  <span>
                    total{" "}
                    <span className="font-semibold text-foreground">
                      {activitySeries.reduce((s, d) => s + d.calls, 0).toLocaleString()}
                    </span>{" "}
                    calls
                  </span>
                  <span>
                    peak day{" "}
                    <span className="font-semibold text-foreground">
                      {Math.max(...activitySeries.map((d) => d.calls)).toLocaleString()}
                    </span>{" "}
                    calls
                  </span>
                </div>
              )}
            </Section>

            {/* ── Activity + Lanes ── */}
            <div className="grid gap-5 lg:grid-cols-5">
              <Section
                title="Activity, last 24 hours"
                className="lg:col-span-3"
                action={tel ? (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {tel.totalEvents.toLocaleString()} events
                  </span>
                ) : undefined}
                contentClassName="space-y-3"
              >
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
                  <p className="font-mono text-xs text-muted-foreground">No telemetry data available.</p>
                )}
              </Section>

              <Section title="Execution lanes" className="lg:col-span-2">
                {(data?.lanes ?? []).length > 0 ? (
                  <div>
                    {(data?.lanes ?? []).map((lane) => (
                      <LaneBadge key={lane.lane} lane={lane} />
                    ))}
                  </div>
                ) : (
                  <p className="font-mono text-xs text-muted-foreground">No execution lanes reporting.</p>
                )}
              </Section>
            </div>

            {/* ── Workflows + Sessions + Tasks ── */}
            <div className="grid gap-5 lg:grid-cols-3">
              <Section
                title="Active workflows"
                action={<SectionLink href="/workflows">view all</SectionLink>}
              >
                {recentWorkflows.length === 0 ? (
                  <p className="py-4 text-center font-mono text-xs text-muted-foreground">
                    No active workflows.{" "}
                    <Link href="/workflows" className="text-terminal-red hover:underline">Create one</Link>.
                  </p>
                ) : (
                  <div>
                    {recentWorkflows.map((wf) => (
                      <Link
                        key={wf.id}
                        href={`/workflows/${wf.id}`}
                        className="group flex items-center gap-2.5 border-b border-border/60 py-2.5 transition-colors last:border-b-0 hover:text-terminal-red"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 bg-terminal-red" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium">{wf.name}</p>
                          {wf.description && (
                            <p className="truncate font-mono text-[11px] text-muted-foreground">{wf.description}</p>
                          )}
                        </div>
                        <ArrowRight className="h-3 w-3 shrink-0 text-transparent transition-colors group-hover:text-terminal-red" />
                      </Link>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title="Recent sessions"
                action={<SectionLink href="/chat">open chat</SectionLink>}
              >
                {recentSessions.length === 0 ? (
                  <p className="py-4 text-center font-mono text-xs text-muted-foreground">
                    No saved sessions yet.
                  </p>
                ) : (
                  <div>
                    {recentSessions.map((session) => (
                      <Link
                        key={session.id}
                        href="/chat"
                        className="group flex items-center justify-between gap-3 border-b border-border/60 py-2.5 transition-colors last:border-b-0 hover:text-terminal-red"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium">{session.title}</p>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">{session.id}</p>
                        </div>
                        {session.fastMode === true && (
                          <span className="shrink-0 border border-terminal-red/40 px-1.5 py-0.5 font-mono text-[10px] text-terminal-red">
                            fast
                          </span>
                        )}
                      </Link>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title="Task board"
                action={<SectionLink href="/boards">open board</SectionLink>}
                contentClassName="space-y-3"
              >
                {[
                  { key: "inbox", label: "Inbox" },
                  { key: "in_progress", label: "In progress" },
                  { key: "review", label: "Review" },
                  { key: "done", label: "Done" },
                ].map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 ${key === "done" ? "bg-foreground/60" : "bg-terminal-red"} ${key === "in_progress" ? "pulse-red" : ""}`} />
                      <span className="text-xs text-muted-foreground">{label}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="h-1 w-24 overflow-hidden bg-border/60">
                        <div
                          className="h-full bg-terminal-red"
                          style={{ width: totalTasks > 0 ? `${Math.round(((tasksByStatus[key] ?? 0) / totalTasks) * 100)}%` : "0%" }}
                        />
                      </div>
                      <span className="w-6 text-right font-mono text-xs font-semibold tabular-nums">{tasksByStatus[key] ?? 0}</span>
                    </div>
                  </div>
                ))}
                <div className="flex items-center justify-between border-t border-border pt-2.5 text-xs">
                  <span className="text-muted-foreground">Total tasks</span>
                  <span className="font-mono font-semibold text-foreground">{totalTasks}</span>
                </div>
              </Section>
            </div>

            {/* ── System strip ── */}
            <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 border border-border bg-card px-5 py-3 font-mono text-[11px] text-muted-foreground">
              {(data?.healthChecks ?? []).map((c) => (
                <span key={c.name} className="flex items-center gap-1.5" title={c.details}>
                  <HealthDot status={c.status} />
                  {c.name.replace("-", " ")}
                </span>
              ))}
              {data?.machine && (
                <>
                  <span className="hidden text-border sm:inline">|</span>
                  <span title={data.machine.cpu.model}>cpu {data.machine.cpu.logicalCores}c</span>
                  <span>ram {data.machine.memory.usedGiB}/{data.machine.memory.totalGiB} GB</span>
                  <span>disk {data.machine.disk.freeGiB} GB free</span>
                  <span>{data.machine.platform}/{data.machine.arch} · {data.machine.nodeVersion}</span>
                </>
              )}
              <Link href="/debug" className="ml-auto flex items-center gap-1 transition-colors hover:text-terminal-red">
                debug <ArrowRight className="h-2.5 w-2.5" />
              </Link>
            </footer>
          </div>
        </main>
      {commandPaletteOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 px-4 pt-24 backdrop-blur-sm">
          <div className="w-full max-w-xl border border-border bg-card p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-terminal-red" />
                <span className="font-display text-[11px] font-semibold uppercase leading-none tracking-[0.14em] text-foreground">Command palette</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCommandPaletteOpen(false);
                  setCommandPaletteQuery("");
                }}
                className="font-mono text-[11px] text-muted-foreground hover:text-terminal-red"
              >
                esc
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
                    className="border border-border px-3 py-2.5 text-left transition-colors hover:border-terminal-red"
                  >
                    <div className="text-[13px] font-medium text-foreground">{item.label}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {item.hint}
                    </div>
                  </Link>
                ))
              ) : (
                <div className="border border-dashed border-border px-3 py-6 text-center font-mono text-xs text-muted-foreground sm:col-span-2">
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
