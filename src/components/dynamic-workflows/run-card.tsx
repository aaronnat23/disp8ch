"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  DynamicWorkflowRunRecord,
  DynamicWorkflowPhaseRecord,
  DynamicWorkflowWorkerRecord,
  DynamicWorkflowPhaseStatus,
  DynamicWorkflowWorkerStatus,
} from "@/lib/dynamic-workflows/types";
import { Pause, Play, Square, Eye, Clock, Activity } from "lucide-react";

type RunCardProps = {
  run: DynamicWorkflowRunRecord & {
    phases?: DynamicWorkflowPhaseRecord[];
    workers?: DynamicWorkflowWorkerRecord[];
  };
  onPause?: (runId: string) => void;
  onResume?: (runId: string) => void;
  onCancel?: (runId: string) => void;
  onView?: (runId: string) => void;
};

const STATUS_CONFIG: Record<
  string,
  { label: string; className: string }
> = {
  running: {
    label: "Running",
    className: "border-blue-500/40 bg-blue-500/10 text-blue-400",
  },
  completed: {
    label: "Completed",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  },
  failed: {
    label: "Failed",
    className: "border-red-500/40 bg-red-500/10 text-red-400",
  },
  paused: {
    label: "Paused",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  },
  cancelled: {
    label: "Cancelled",
    className: "border-gray-500/40 bg-gray-500/10 text-gray-400",
  },
  draft: {
    label: "Draft",
    className: "border-border bg-muted text-muted-foreground",
  },
  awaiting_approval: {
    label: "Awaiting Approval",
    className: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400",
  },
  queued: {
    label: "Queued",
    className: "border-purple-500/40 bg-purple-500/10 text-purple-400",
  },
};

function formatElapsed(startIso: string | null, endIso: string | null): string {
  if (!startIso) return "—";
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatCost(cents: number | null | undefined): string {
  if (!cents) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export function RunCard({ run, onPause, onResume, onCancel, onView }: RunCardProps) {
  const phaseProgress = useMemo(() => {
    const phases = run.phases ?? [];
    const total = phases.length;
    const completed = phases.filter((p) => p.status === "completed").length;
    const current = phases.findIndex((p) => p.status === "running");
    return { total, completed, current: current >= 0 ? current + 1 : null };
  }, [run.phases]);

  const workerSummary = useMemo(() => {
    const workers = run.workers ?? [];
    const counts: Record<DynamicWorkflowWorkerStatus, number> = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      timed_out: 0,
    };
    for (const w of workers) {
      counts[w.status] = (counts[w.status] || 0) + 1;
    }
    return counts;
  }, [run.workers]);

  const statusConfig = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.draft;
  const isRunning = run.status === "running";
  const isPausable = run.status === "running" || run.status === "queued";
  const isCancellable =
    run.status === "running" || run.status === "queued" || run.status === "paused";

  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm truncate">{run.name}</CardTitle>
          <Badge variant="outline" className={cn("shrink-0 text-[10px]", statusConfig.className)}>
            {isRunning && <Activity className="mr-1 h-2.5 w-2.5 animate-pulse" />}
            {statusConfig.label}
          </Badge>
        </div>
        {run.description ? (
          <p className="text-xs text-muted-foreground line-clamp-2">{run.description}</p>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-2">
        {/* Phase progress */}
        {phaseProgress.total > 0 ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Activity className="h-3 w-3" />
            <span>
              Phase {phaseProgress.current ?? phaseProgress.completed}/{phaseProgress.total}
            </span>
            {phaseProgress.total > 1 ? (
              <div className="ml-auto flex h-1.5 flex-1 max-w-[80px] rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{
                    width: `${(phaseProgress.completed / phaseProgress.total) * 100}%`,
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Worker summary */}
        {(run.workers ?? []).length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {workerSummary.running > 0 ? (
              <span className="text-blue-400">{workerSummary.running} running</span>
            ) : null}
            {workerSummary.completed > 0 ? (
              <span className="text-emerald-400">{workerSummary.completed} completed</span>
            ) : null}
            {workerSummary.failed > 0 ? (
              <span className="text-red-400">{workerSummary.failed} failed</span>
            ) : null}
            {workerSummary.queued > 0 ? (
              <span className="text-purple-400">{workerSummary.queued} queued</span>
            ) : null}
          </div>
        ) : null}

        {/* Elapsed and cost */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatElapsed(run.startedAt, run.completedAt)}
          </span>
          {run.actualCostUsd != null || run.estimatedCostUsd != null ? (
            <span className="text-[11px] tabular-nums">
              {run.actualCostUsd != null
                ? formatCost(run.actualCostUsd)
                : `~${formatCost(run.estimatedCostUsd)}`}
            </span>
          ) : null}
        </div>

        {/* Source / saved command */}
        {run.sourceType ? (
          <div className="text-[10px] text-muted-foreground/70 font-mono uppercase tracking-widest">
            {run.sourceType}
            {run.savedCommandName ? ` · ${run.savedCommandName}` : ""}
          </div>
        ) : null}

        {run.error ? (
          <div className="rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive truncate">
            {run.error.slice(0, 120)}
          </div>
        ) : null}

        {/* Actions */}
        <div className="flex items-center gap-1 pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => onView?.(run.id)}
          >
            <Eye className="mr-1 h-3 w-3" />
            View
          </Button>
          {isPausable && onPause ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => onPause(run.id)}
            >
              <Pause className="mr-1 h-3 w-3" />
              Pause
            </Button>
          ) : null}
          {run.status === "paused" && onResume ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => onResume(run.id)}
            >
              <Play className="mr-1 h-3 w-3" />
              Resume
            </Button>
          ) : null}
          {isCancellable && onCancel ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-destructive hover:text-destructive"
              onClick={() => onCancel(run.id)}
            >
              <Square className="mr-1 h-3 w-3" />
              Cancel
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
