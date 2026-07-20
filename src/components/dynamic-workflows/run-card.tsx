"use client";

import { useMemo } from "react";
import { Activity, Clock, Eye, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DynamicWorkflowRunRecord, DynamicWorkflowPhaseRecord, DynamicWorkflowWorkerRecord, DynamicWorkflowWorkerStatus } from "@/lib/dynamic-workflows/types";
import { cn } from "@/lib/utils";

type RunCardProps = {
  run: DynamicWorkflowRunRecord & { phases?: DynamicWorkflowPhaseRecord[]; workers?: DynamicWorkflowWorkerRecord[] };
  onPause?: (runId: string) => void;
  onResume?: (runId: string) => void;
  onCancel?: (runId: string) => void;
  onView?: (runId: string) => void;
};

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  running: { label: "Running", className: "border-terminal-red bg-terminal-red text-white" },
  completed: { label: "Verified", className: "border-foreground bg-foreground text-background" },
  failed: { label: "Failed", className: "border-terminal-red bg-terminal-red/10 text-terminal-red" },
  paused: { label: "Paused", className: "border-border bg-muted text-foreground" },
  cancelled: { label: "Cancelled", className: "border-border text-muted-foreground" },
  draft: { label: "Draft", className: "border-border text-muted-foreground" },
  awaiting_approval: { label: "Needs approval", className: "border-terminal-red border-dashed text-terminal-red" },
  queued: { label: "Queued", className: "border-border text-foreground" },
  needs_human: { label: "Needs human", className: "border-terminal-red border-dashed bg-terminal-red/5 text-terminal-red" },
};

function formatElapsed(startIso: string | null, endIso: string | null): string {
  if (!startIso) return "—";
  const seconds = Math.max(0, Math.floor(((endIso ? new Date(endIso).getTime() : Date.now()) - new Date(startIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatCost(usd: number | null | undefined): string {
  return usd == null ? "—" : `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

export function RunCard({ run, onPause, onResume, onCancel, onView }: RunCardProps) {
  const phases = run.phases ?? [];
  const completedPhases = phases.filter((phase) => phase.status === "completed").length;
  const workerSummary = useMemo(() => {
    const counts: Record<DynamicWorkflowWorkerStatus, number> = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, timed_out: 0 };
    for (const worker of run.workers ?? []) counts[worker.status] = (counts[worker.status] || 0) + 1;
    return counts;
  }, [run.workers]);
  const status = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.draft;
  const isPausable = run.status === "running" || run.status === "queued";
  const isCancellable = run.status === "running" || run.status === "queued" || run.status === "paused";

  return <article className={cn("group relative overflow-hidden border bg-card/30 transition-[transform,box-shadow] duration-200 hover:-translate-y-px hover:shadow-[0_8px_24px_rgba(var(--accent-red-rgb),0.08)]", run.status === "running" && "hud-frame border-terminal-red/50")} data-run-status={run.status}>
    <div className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="mb-1.5 flex items-center gap-2"><span className={cn("inline-flex h-5 items-center border px-1.5 font-display text-[9px] uppercase", status.className)}>{run.status === "running" ? <span className="mr-1 h-1.5 w-1.5 bg-white pulse-red"/> : null}{status.label}</span><span className="font-mono text-[9px] text-muted-foreground">{run.sourceType || "dynamic"}</span></div>
        <h3 className="truncate font-display text-sm font-semibold uppercase">{run.name}</h3>
        {run.description ? <p className="mt-1 line-clamp-2 max-w-2xl text-[11px] leading-4 text-muted-foreground">{run.description}</p> : null}
      </div>
      <div className="grid grid-cols-3 border-y sm:min-w-52">
        <div className="px-2 py-1.5"><p className="font-display text-base">{phases.length ? `${completedPhases}/${phases.length}` : "—"}</p><p className="font-mono text-[8px] text-muted-foreground">phases</p></div>
        <div className="border-x px-2 py-1.5"><p className="font-display text-base">{(run.workers ?? []).length}</p><p className="font-mono text-[8px] text-muted-foreground">workers</p></div>
        <div className="px-2 py-1.5"><p className="font-display text-base">{formatCost(run.actualCostUsd ?? run.estimatedCostUsd)}</p><p className="font-mono text-[8px] text-muted-foreground">cost</p></div>
      </div>
    </div>

    {phases.length ? <div className="relative border-y bg-background/40 px-3 py-3">
      <div className="absolute left-5 right-5 top-[18px] h-px bg-border"/>
      <div className="grid" style={{ gridTemplateColumns: `repeat(${phases.length}, minmax(0, 1fr))` }}>{phases.map((phase, index) => <div key={phase.id} className="relative z-[1] min-w-0 pr-2" style={{ animationDelay: `${Math.min(index, 5) * 70}ms` }}><span className={cn("mb-1.5 block h-3 w-3 border-2 bg-background", phase.status === "completed" && "border-terminal-red bg-terminal-red", phase.status === "running" && "mission-active-node border-terminal-red bg-terminal-red", phase.status === "failed" && "border-terminal-red bg-background", !["completed", "running", "failed"].includes(phase.status) && "border-border")}/><p className="truncate font-display text-[9px] uppercase">{phase.name}</p><p className="font-mono text-[8px] text-muted-foreground">{phase.status}</p></div>)}</div>
    </div> : null}

    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 font-mono text-[9px] text-muted-foreground">
      <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3"/>{formatElapsed(run.startedAt, run.completedAt)}</span>
      {workerSummary.running ? <span className="text-terminal-red">{workerSummary.running} live</span> : null}
      {workerSummary.completed ? <span>{workerSummary.completed} complete</span> : null}
      {workerSummary.failed ? <span className="text-terminal-red">{workerSummary.failed} failed</span> : null}
      {run.savedCommandName ? <span>/{run.savedCommandName}</span> : null}
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={() => onView?.(run.id)}><Eye className="mr-1 h-3 w-3"/>Open mission</Button>
        {isPausable && onPause ? <Button variant="ghost" size="icon" className="h-7 w-7" title="Pause run" onClick={() => onPause(run.id)}><Pause className="h-3 w-3"/></Button> : null}
        {run.status === "paused" && onResume ? <Button variant="ghost" size="icon" className="h-7 w-7" title="Resume run" onClick={() => onResume(run.id)}><Play className="h-3 w-3"/></Button> : null}
        {isCancellable && onCancel ? <Button variant="ghost" size="icon" className="h-7 w-7 text-terminal-red" title="Cancel run" onClick={() => onCancel(run.id)}><Square className="h-3 w-3"/></Button> : null}
      </div>
    </div>
    {run.error ? <p className="border-t border-terminal-red/30 bg-terminal-red/5 px-3 py-1.5 text-[10px] text-terminal-red">{run.error.slice(0, 160)}</p> : null}
  </article>;
}
