"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  PopulatedDynamicWorkflowRun,
  DynamicWorkflowPhaseRecord,
  DynamicWorkflowWorkerRecord,
  DynamicWorkflowWorkerResult,
  DynamicWorkflowEventRecord,
} from "@/lib/dynamic-workflows/types";
import {
  ArrowLeft,
  Pause,
  Play,
  Square,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Clock,
  Activity,
  Save,
  CheckCircle2,
  XCircle,
  Circle,
  Loader2,
} from "lucide-react";

type RunDetailProps = {
  run: PopulatedDynamicWorkflowRun;
  onPause?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
  onRestartWorker?: (workerId: string) => void;
  onSaveCommand?: () => void;
  onBack?: () => void;
};

const RUN_STATUS_CONFIG: Record<
  string,
  { label: string; className: string }
> = {
  running: { label: "Running", className: "border-blue-500/40 bg-blue-500/10 text-blue-400" },
  completed: { label: "Completed", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" },
  failed: { label: "Failed", className: "border-red-500/40 bg-red-500/10 text-red-400" },
  paused: { label: "Paused", className: "border-amber-500/40 bg-amber-500/10 text-amber-400" },
  cancelled: { label: "Cancelled", className: "border-gray-500/40 bg-gray-500/10 text-gray-400" },
  draft: { label: "Draft", className: "border-border bg-muted text-muted-foreground" },
  awaiting_approval: { label: "Awaiting Approval", className: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400" },
  queued: { label: "Queued", className: "border-purple-500/40 bg-purple-500/10 text-purple-400" },
};

const PHASE_STATUS_DOT: Record<string, string> = {
  pending: "border-gray-500 bg-gray-500/20",
  running: "border-blue-500 bg-blue-500/80 animate-pulse",
  paused: "border-amber-500 bg-amber-500/80",
  completed: "border-emerald-500 bg-emerald-500/80",
  failed: "border-red-500 bg-red-500/80",
  skipped: "border-gray-500 bg-gray-500/40",
};

const PHASE_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  paused: "Paused",
  completed: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

const WORKER_STATUS_COLOR: Record<string, string> = {
  queued: "text-purple-400",
  running: "text-blue-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  cancelled: "text-gray-400",
  timed_out: "text-amber-400",
};

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso) return "—";
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${seconds % 60}s`;
}

function formatCost(cents: number | null | undefined): string {
  if (!cents) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function parseWorkerResult(w: DynamicWorkflowWorkerRecord): DynamicWorkflowWorkerResult | null {
  if (!w.resultJson) return null;
  try {
    return JSON.parse(w.resultJson) as DynamicWorkflowWorkerResult;
  } catch {
    return null;
  }
}

function PhaseTimeline({
  phases,
  workers,
  expandedPhases,
  togglePhase,
  onRestartWorker,
}: {
  phases: DynamicWorkflowPhaseRecord[];
  workers: DynamicWorkflowWorkerRecord[];
  expandedPhases: Set<string>;
  togglePhase: (phaseId: string) => void;
  onRestartWorker?: (workerId: string) => void;
}) {
  if (phases.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-muted-foreground">
        No phases in plan.
      </p>
    );
  }

  return (
    <div className="relative">
      {phases.map((phase, idx) => {
        const phaseWorkers = workers.filter((w) => w.phaseId === phase.id);
        const isExpanded = expandedPhases.has(phase.id);
        const isLast = idx === phases.length - 1;
        const dotClass = PHASE_STATUS_DOT[phase.status] ?? PHASE_STATUS_DOT.pending;

        return (
          <div key={phase.id} className="flex gap-3">
            {/* Timeline dot + line */}
            <div className="flex flex-col items-center pt-0.5">
              <div className={cn("h-3 w-3 rounded-full border-2", dotClass)} />
              {!isLast ? (
                <div className="mt-0.5 w-0.5 flex-1 bg-border/50" />
              ) : null}
            </div>

            {/* Content */}
            <div className={cn("flex-1", !isLast ? "pb-4" : "")}>
              <button
                type="button"
                className="flex items-center gap-2 text-left group w-full"
                onClick={() => togglePhase(phase.id)}
              >
                <span className="text-xs font-semibold">
                  Phase {phase.phaseIndex + 1}: {phase.name}
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px] shrink-0",
                    phase.status === "completed"
                      ? "border-emerald-500/40 text-emerald-400"
                      : phase.status === "running"
                        ? "border-blue-500/40 text-blue-400"
                        : phase.status === "failed"
                          ? "border-red-500/40 text-red-400"
                          : phase.status === "paused"
                            ? "border-amber-500/40 text-amber-400"
                            : "border-border text-muted-foreground"
                  )}
                >
                  {PHASE_STATUS_LABEL[phase.status] ?? phase.status}
                </Badge>
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {phaseWorkers.length} worker{phaseWorkers.length !== 1 ? "s" : ""}
                </span>
                {isExpanded ? (
                  <ChevronUp className="ml-1 h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                ) : (
                  <ChevronDown className="ml-1 h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
              </button>

              {phase.instructions ? (
                <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">
                  {phase.instructions}
                </p>
              ) : null}

              {/* Expanded: worker grid */}
              {isExpanded && phaseWorkers.length > 0 ? (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {phaseWorkers.map((worker) => (
                    <WorkerCard
                      key={worker.id}
                      worker={worker}
                      onRestart={onRestartWorker}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WorkerCard({
  worker,
  onRestart,
}: {
  worker: DynamicWorkflowWorkerRecord;
  onRestart?: (workerId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const result = parseWorkerResult(worker);
  const statusColor = WORKER_STATUS_COLOR[worker.status] ?? "text-muted-foreground";

  return (
    <div className="rounded-md border bg-muted/20 p-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={cn("font-semibold truncate", statusColor)}>
            {worker.role || `Worker ${worker.workerIndex}`}
          </span>
          {worker.status === "running" ? (
            <Loader2 className="h-3 w-3 animate-spin text-blue-400 shrink-0" />
          ) : worker.status === "completed" ? (
            <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
          ) : worker.status === "failed" ? (
            <XCircle className="h-3 w-3 text-red-400 shrink-0" />
          ) : (
            <Circle className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
        </div>
        <button
          type="button"
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors shrink-0"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide" : "Details"}
        </button>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        <span>{worker.agentKind}</span>
        {worker.modelRef ? <span>{worker.modelRef}</span> : null}
        {worker.startedAt ? (
          <span>
            {formatTime(worker.startedAt)}
            {worker.completedAt
              ? ` → ${formatTime(worker.completedAt)}`
              : ""}
          </span>
        ) : null}
      </div>

      {result?.summary ? (
        <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">
          {result.summary}
        </p>
      ) : worker.resultSummary ? (
        <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">
          {worker.resultSummary}
        </p>
      ) : null}

      {worker.error ? (
        <p className="mt-1 text-[11px] text-destructive truncate">
          {worker.error.slice(0, 150)}
        </p>
      ) : null}

      {expanded ? (
        <div className="mt-2 space-y-2 border-t border-border/40 pt-2">
          {/* Prompt */}
          {worker.prompt ? (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5">
                Prompt
              </div>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[10px] text-foreground">
                {worker.prompt.slice(0, 800)}
                {worker.prompt.length > 800 ? "…" : ""}
              </pre>
            </div>
          ) : null}

          {/* Full result summary */}
          {result?.findings?.length ? (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5">
                Findings
              </div>
              <ul className="list-disc list-inside space-y-0.5 text-[10px] text-muted-foreground">
                {result.findings.map((f, i) => (
                  <li key={i}>
                    {f.claim}
                    {f.confidence != null
                      ? ` (${Math.round(f.confidence * 100)}%)`
                      : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Token / cost */}
          {(worker.inputTokens != null || worker.outputTokens != null || worker.costUsd != null) ? (
            <div className="flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
              {worker.inputTokens != null ? (
                <span>In: {worker.inputTokens.toLocaleString()} tok</span>
              ) : null}
              {worker.outputTokens != null ? (
                <span>Out: {worker.outputTokens.toLocaleString()} tok</span>
              ) : null}
              {worker.costUsd != null ? (
                <span>Cost: {formatCost(worker.costUsd)}</span>
              ) : null}
            </div>
          ) : null}

          {/* Restart */}
          {worker.status === "failed" && onRestart ? (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => onRestart(worker.id)}
            >
              <RotateCcw className="mr-1 h-2.5 w-2.5" />
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function EventStream({ runId }: { runId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<DynamicWorkflowEventRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/dynamic-workflows?runId=${encodeURIComponent(runId)}&events=1`
      );
      const json = await res.json() as {
        success?: boolean;
        data?: DynamicWorkflowEventRecord[];
      };
      if (json.success && json.data) {
        setEvents(json.data);
      }
    } catch {
      // best effort
    } finally {
      setLoading(false);
    }
  }, [runId]);

  const toggleEvents = () => {
    if (!expanded && events.length === 0) {
      fetchEvents();
    }
    setExpanded(!expanded);
  };

  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
        onClick={toggleEvents}
      >
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
        Events
        {!expanded && events.length > 0 ? (
          <span className="text-[10px]">({events.length})</span>
        ) : null}
        {loading ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : null}
      </button>

      {expanded ? (
        <div className="mt-2 max-h-60 overflow-auto rounded-md border bg-muted/10">
          {events.length === 0 && !loading ? (
            <p className="p-3 text-center text-[11px] text-muted-foreground">
              No events recorded.
            </p>
          ) : (
            <div className="divide-y divide-border/30">
              {events.map((ev) => (
                <div key={ev.id} className="px-3 py-1.5 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {formatTime(ev.createdAt)}
                    </span>
                    <span className="font-semibold text-xs">{ev.eventType}</span>
                  </div>
                  {ev.title ? (
                    <p className="mt-0.5 text-muted-foreground">{ev.title}</p>
                  ) : null}
                  {ev.detail ? (
                    <p className="text-[10px] text-muted-foreground/70 truncate">
                      {ev.detail.slice(0, 200)}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function RunDetail({
  run,
  onPause,
  onResume,
  onCancel,
  onRestartWorker,
  onSaveCommand,
  onBack,
}: RunDetailProps) {
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());
  const statusConfig = RUN_STATUS_CONFIG[run.status] ?? RUN_STATUS_CONFIG.draft;
  const isRunning = run.status === "running";
  const isPausable = run.status === "running" || run.status === "queued";
  const isCancellable =
    run.status === "running" || run.status === "queued" || run.status === "paused";

  const togglePhase = (phaseId: string) => {
    setExpandedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(phaseId)) {
        next.delete(phaseId);
      } else {
        next.add(phaseId);
      }
      return next;
    });
  };

  // Aggregate tokens across workers
  const totalInTokens = run.workers.reduce((sum, w) => sum + (w.inputTokens ?? 0), 0);
  const totalOutTokens = run.workers.reduce((sum, w) => sum + (w.outputTokens ?? 0), 0);

  // Extract artifacts from worker results
  const artifacts = run.workers.flatMap((w) => {
    const r = parseWorkerResult(w);
    return r?.artifacts ?? [];
  });

  const screenshots = run.workers.flatMap((w) => {
    const r = parseWorkerResult(w);
    return r?.screenshots ?? [];
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {onBack ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={onBack}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          ) : null}
          <div className="min-w-0">
            <h2 className="text-lg font-semibold truncate">{run.name}</h2>
            {run.description ? (
              <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                {run.description}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn("text-[10px] shrink-0", statusConfig.className)}
          >
            {isRunning ? (
              <Activity className="mr-1 h-2.5 w-2.5 animate-pulse" />
            ) : null}
            {statusConfig.label}
          </Badge>
          {isPausable && onPause ? (
            <Button variant="outline" size="sm" className="h-8" onClick={onPause}>
              <Pause className="mr-1.5 h-3.5 w-3.5" />
              Pause
            </Button>
          ) : null}
          {run.status === "paused" && onResume ? (
            <Button variant="outline" size="sm" className="h-8" onClick={onResume}>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Resume
            </Button>
          ) : null}
          {isCancellable && onCancel ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-destructive/30 text-destructive hover:bg-destructive/10"
              onClick={onCancel}
            >
              <Square className="mr-1.5 h-3.5 w-3.5" />
              Cancel
            </Button>
          ) : null}
          {run.status === "completed" && onSaveCommand ? (
            <Button variant="outline" size="sm" className="h-8" onClick={onSaveCommand}>
              <Save className="mr-1.5 h-3.5 w-3.5" />
              Save Command
            </Button>
          ) : null}
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-6">
        <Card className="p-3">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Created
          </div>
          <div className="text-sm font-semibold tabular-nums">
            {formatTime(run.createdAt)}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Started
          </div>
          <div className="text-sm font-semibold tabular-nums">
            {formatTime(run.startedAt)}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Completed
          </div>
          <div className="text-sm font-semibold tabular-nums">
            {formatTime(run.completedAt)}
          </div>
        </Card>

        <Card className="p-3">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Duration
          </div>
          <div className="text-sm font-semibold tabular-nums">
            {formatDuration(run.startedAt, run.completedAt)}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Cost
          </div>
          <div className="text-sm font-semibold tabular-nums">
            {formatCost(run.actualCostUsd)}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Tokens
          </div>
          <div className="text-sm font-semibold tabular-nums">
            {totalInTokens > 0 || totalOutTokens > 0
              ? `${(totalInTokens + totalOutTokens).toLocaleString()}`
              : "—"}
          </div>
        </Card>
      </div>

      {/* Phase timeline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Phase Timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <PhaseTimeline
            phases={run.phases}
            workers={run.workers}
            expandedPhases={expandedPhases}
            togglePhase={togglePhase}
            onRestartWorker={onRestartWorker}
          />
        </CardContent>
      </Card>

      {/* Artifacts / Screenshots */}
      {artifacts.length > 0 || screenshots.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Artifacts & Screenshots</CardTitle>
          </CardHeader>
          <CardContent>
            {artifacts.length > 0 ? (
              <div className="mb-3">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                  Files
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {artifacts.map((a, i) => (
                    <Badge key={i} variant="outline" className="text-[10px] font-mono">
                      {a.type}: {a.label ?? a.path ?? `#${i}`}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
            {screenshots.length > 0 ? (
              <div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                  Screenshots
                </div>
                <div className="flex flex-wrap gap-2">
                  {screenshots.map((s, i) => (
                    <span
                      key={i}
                      className="rounded border bg-muted/30 px-2 py-1 font-mono text-[10px]"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Error display for failed runs */}
      {run.error ? (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-destructive">Run Error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-destructive/80 font-mono">
              {run.error}
            </pre>
          </CardContent>
        </Card>
      ) : null}

      {/* Event stream */}
      <Card>
        <CardContent className="pt-4">
          <EventStream runId={run.id} />
        </CardContent>
      </Card>
    </div>
  );
}
