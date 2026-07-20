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
  ExternalLink,
  FileCheck2,
  ReceiptText,
  UsersRound,
  Wrench,
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
  running: { label: "Running", className: "border-terminal-red bg-terminal-red text-white" },
  completed: { label: "Verified", className: "border-foreground bg-foreground text-background" },
  failed: { label: "Failed", className: "border-terminal-red bg-terminal-red/10 text-terminal-red" },
  paused: { label: "Paused", className: "border-border bg-muted text-foreground" },
  cancelled: { label: "Cancelled", className: "border-border text-muted-foreground" },
  draft: { label: "Draft", className: "border-border bg-muted text-muted-foreground" },
  awaiting_approval: { label: "Awaiting Approval", className: "border-terminal-red border-dashed text-terminal-red" },
  queued: { label: "Queued", className: "border-border text-foreground" },
  needs_human: { label: "Needs human", className: "border-terminal-red/50 bg-terminal-red/10 text-terminal-red" },
};

const PHASE_STATUS_DOT: Record<string, string> = {
  pending: "border-border bg-background",
  running: "mission-active-node border-terminal-red bg-terminal-red",
  paused: "border-foreground bg-foreground/20",
  completed: "border-terminal-red bg-terminal-red",
  failed: "border-terminal-red bg-background",
  skipped: "border-border bg-muted",
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
  queued: "text-muted-foreground",
  running: "text-terminal-red",
  completed: "text-foreground",
  failed: "text-terminal-red",
  cancelled: "text-muted-foreground",
  timed_out: "text-terminal-red",
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

function formatCost(costUsd: number | null | undefined): string {
  if (!costUsd) return "—";
  return `$${costUsd.toFixed(costUsd < 0.01 ? 6 : 4)}`;
}

type ReceiptData = {
  criteria: Array<{ id: string; statement: string; required: boolean; status: string; methods: string[] }>;
  evidence: Array<{ id: string; criterionId: string | null; evidenceType: string; summary: string | null }>;
  repairs: Array<{ id: string; attemptNumber: number; status: string; failedCriterionIds: string[] }>;
  outcome: null | {
    status: string;
    sourceSession: {
      id: string;
      title: string | null;
      durationMs: number;
      summary: string | null;
      requirements: Array<{ id: string; kind: "decision" | "action"; statement: string | null; owner: string | null; deadline: string | null; citations: string[] }>;
      risks: Array<{ statement: string | null; citations: string[] }>;
      openQuestions: Array<{ statement: string | null; citations: string[] }>;
    };
    contract: {
      requiredPassed: number;
      requiredTotal: number;
      evidenceCount: number;
      items: Array<{ id: string; statement: string | null; required: boolean; status: string; methods: string[]; evidence: Array<{ id: string; type: string; summary: string | null }> }>;
    };
    deliveryTeam: Array<{ role: string; agentId: string | null; agentKind: string; modelRef: string | null; status: string }>;
    result: {
      summary: string | null;
      changedFiles: string[];
      artifacts: Array<{ type?: string; path?: string; url?: string; label?: string }>;
      screenshots: string[];
      deployments: Array<{ id: string | null; eventType: string; summary: string | null }>;
      repairPasses: number;
    };
  };
};

function OutcomeReceipt({ outcome }: { outcome: NonNullable<ReceiptData["outcome"]> }) {
  const durationSeconds = Math.max(0, Math.round(outcome.sourceSession.durationMs / 1000));
  const publicResult = [...outcome.result.deployments].reverse().find((item) => item.summary?.startsWith("https://"));
  return <div className="space-y-4" data-testid="outcome-receipt">
    <div className="hud-frame grid grid-cols-2 border border-terminal-red/40 sm:grid-cols-4">
      <div className="border-b border-r p-3 sm:border-b-0"><p className="font-display text-2xl text-terminal-red">{outcome.sourceSession.requirements.length}</p><p className="font-mono text-[9px] text-muted-foreground">sourced requirements</p></div>
      <div className="border-b p-3 sm:border-b-0 sm:border-r"><p className="font-display text-2xl">{durationSeconds}s</p><p className="font-mono text-[9px] text-muted-foreground">meeting evidence</p></div>
      <div className="border-r p-3"><p className="font-display text-2xl">{outcome.contract.requiredPassed}/{outcome.contract.requiredTotal}</p><p className="font-mono text-[9px] text-muted-foreground">required checks</p></div>
      <div className="p-3"><p className="font-display text-2xl text-terminal-red">{outcome.contract.evidenceCount}</p><p className="font-mono text-[9px] text-muted-foreground">proof records</p></div>
    </div>

    <div className="grid gap-5 lg:grid-cols-[1.12fr_0.88fr]">
      <section>
        <div className="mb-2 flex items-center justify-between gap-2"><div className="flex items-center gap-2"><FileCheck2 className="h-4 w-4 text-terminal-red"/><span className="data-label">Source brief</span></div><span className="font-mono text-[9px] text-muted-foreground">{outcome.sourceSession.title}</span></div>
        {outcome.sourceSession.summary ? <p className="border-y border-border py-2 text-xs leading-5">{outcome.sourceSession.summary}</p> : null}
        <div className="divide-y divide-border border-b border-border">
          {outcome.sourceSession.requirements.map((item, index) => <div key={item.id} className="grid grid-cols-[32px_1fr] gap-2 py-2.5 text-xs"><span className="font-display text-lg text-terminal-red">{item.kind === "decision" ? "D" : "A"}{index + 1}</span><div><p className="leading-5">{item.statement}</p><div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[9px] text-muted-foreground">{item.owner ? <span>owner {item.owner}</span> : null}{item.deadline ? <span>due {item.deadline}</span> : null}<span>{item.citations.join(" ") || "source cited"}</span></div></div></div>)}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2"><UsersRound className="h-4 w-4 text-terminal-red"/><span className="data-label">Delivery team</span></div>
        <div className="divide-y divide-border border-y border-border">
          {outcome.deliveryTeam.map((member, index) => <div key={`${member.role}-${member.agentId}-${index}`} className="grid grid-cols-[90px_1fr_auto] items-center gap-2 py-2 text-xs"><span className="font-display uppercase">{member.role}</span><span className="truncate font-mono text-[10px] text-muted-foreground" title={member.modelRef || undefined}>{member.modelRef || member.agentKind}</span><span className={cn("h-2 w-2", member.status === "completed" ? "bg-terminal-red" : "border border-border")} aria-label={member.status}/></div>)}
        </div>
        <div className="mt-3 border-l-2 border-terminal-red pl-3"><p className="data-label">Delivered result</p><p className="mt-1 text-xs leading-5">{outcome.result.summary || "The run completed without a final summary."}</p></div>
        <div className="mt-3 flex flex-wrap gap-2 font-mono text-[9px] text-muted-foreground"><span>{outcome.result.changedFiles.length} changed files</span><span>{outcome.result.artifacts.length} artifacts</span><span>{outcome.result.repairPasses} repair passes</span></div>
      </section>
    </div>

    <section>
      <div className="mb-2 flex items-center justify-between gap-2"><div className="flex items-center gap-2"><ReceiptText className="h-4 w-4 text-terminal-red"/><span className="data-label">Contract to evidence</span></div><span className="font-mono text-[9px] text-terminal-red">{outcome.status}</span></div>
      <div className="divide-y divide-border border-y border-border">
        {outcome.contract.items.map((criterion) => <div key={criterion.id} className="grid gap-2 py-2.5 text-xs sm:grid-cols-[18px_1fr_0.9fr_auto]">
          {criterion.status === "passed" ? <CheckCircle2 className="h-4 w-4 text-terminal-red"/> : criterion.status === "failed" ? <XCircle className="h-4 w-4 text-terminal-red"/> : <Circle className="h-4 w-4 text-muted-foreground"/>}
          <div><p className="font-medium leading-5">{criterion.statement}</p><p className="font-mono text-[9px] text-muted-foreground">{criterion.id} · {criterion.methods.join(", ")}</p></div>
          <div className="space-y-1">{criterion.evidence.length ? criterion.evidence.map((proof) => <p key={proof.id} className="border-l border-terminal-red/60 pl-2 text-[11px] leading-4"><span className="font-mono text-[9px] text-muted-foreground">{proof.type}</span><br/>{proof.summary}</p>) : <p className="text-[11px] text-muted-foreground">No persisted proof.</p>}</div>
          <span className="font-mono text-[9px] text-muted-foreground">{criterion.status}</span>
        </div>)}
      </div>
    </section>

    {outcome.result.repairPasses > 0 || publicResult ? <div className="flex flex-wrap items-center justify-between gap-3 border-t border-terminal-red/40 pt-3">
      <div className="flex items-center gap-2 text-xs">{outcome.result.repairPasses > 0 ? <><Wrench className="h-4 w-4 text-terminal-red"/><span>{outcome.result.repairPasses} governed repair {outcome.result.repairPasses === 1 ? "pass" : "passes"} recorded</span></> : <span className="text-muted-foreground">No repair was needed.</span>}</div>
      {publicResult ? <Button asChild size="sm"><a href={publicResult.summary || "#"} target="_blank" rel="noreferrer"><ExternalLink className="mr-1 h-3.5 w-3.5"/>Open public result</a></Button> : null}
    </div> : null}
  </div>;
}

function ResultReceipt({ runId }: { runId: string }) {
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch(`/api/dynamic-workflows/${encodeURIComponent(runId)}/receipt`)
      .then((response) => response.json())
      .then((json) => {
        if (!json.success) throw new Error(json.error || "Receipt unavailable");
        setReceipt(json.data as ReceiptData);
      })
      .catch((cause) => setError(String(cause)));
  }, [runId]);

  return (
    <section className="border-y border-border py-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-sm uppercase">{receipt?.outcome ? "Outcome receipt" : "Acceptance and evidence"}</h3>
          <p className="text-xs text-muted-foreground">{receipt?.outcome ? "Meeting requirements, accountable roles, proof, and the delivered result in one exportable record." : "Every required pass must have persisted proof."}</p>
        </div>
        <div className="flex gap-2">
          <a className="border px-2 py-1 font-display text-[11px] uppercase hover:border-terminal-red" href={`/api/dynamic-workflows/${encodeURIComponent(runId)}/receipt?format=markdown`}>Markdown</a>
          <a className="border px-2 py-1 font-display text-[11px] uppercase hover:border-terminal-red" href={`/api/dynamic-workflows/${encodeURIComponent(runId)}/receipt`}>JSON</a>
        </div>
      </div>
      {error ? <p className="text-xs text-terminal-red">{error}</p> : !receipt ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Loading receipt</div>
      ) : (
        receipt.outcome ? <OutcomeReceipt outcome={receipt.outcome}/> : <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="divide-y divide-border border-y border-border">
            {receipt.criteria.map((criterion) => (
              <div key={criterion.id} className="grid grid-cols-[18px_1fr_auto] gap-2 py-2 text-xs">
                {criterion.status === "passed" ? <CheckCircle2 className="h-4 w-4 text-terminal-red" /> : criterion.status === "failed" ? <XCircle className="h-4 w-4 text-terminal-red" /> : <Circle className="h-4 w-4 text-muted-foreground" />}
                <div><div className="font-medium">{criterion.statement}</div><div className="font-mono text-[10px] text-muted-foreground">{criterion.id} · {criterion.methods.join(", ")}</div></div>
                <span className="font-mono text-[10px] text-muted-foreground">{criterion.status}</span>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <div className="data-label">Evidence {receipt.evidence.length}</div>
            {receipt.evidence.slice(-12).map((item) => <div key={item.id} className="border-l-2 border-terminal-red/50 pl-2 text-xs"><span className="font-mono text-[10px] text-muted-foreground">{item.criterionId || "run"} · {item.evidenceType}</span><p>{item.summary}</p></div>)}
            {receipt.repairs.length > 0 ? <div className="pt-2"><div className="data-label">Repair history</div>{receipt.repairs.map((repair) => <p key={repair.id} className="text-xs">Pass {repair.attemptNumber}: {repair.status} ({repair.failedCriterionIds.join(", ")})</p>)}</div> : null}
          </div>
        </div>
      )}
    </section>
  );
}

function parseWorkerResult(w: DynamicWorkflowWorkerRecord): DynamicWorkflowWorkerResult | null {
  if (!w.resultJson) return null;
  try {
    return JSON.parse(w.resultJson) as DynamicWorkflowWorkerResult;
  } catch {
    return null;
  }
}

function DeliveryStageRail({ phases, workers }: { phases: DynamicWorkflowPhaseRecord[]; workers: DynamicWorkflowWorkerRecord[] }) {
  if (!phases.length) return null;
  return <section className="hud-frame overflow-hidden border border-terminal-red/40 bg-card/30" data-testid="dynamic-run-stage">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
      <div><h3 className="font-display text-xs font-semibold uppercase">Governed delivery sequence</h3><p className="text-[10px] text-muted-foreground">Each handoff keeps its assigned model, output, and verification state.</p></div>
      <span className="font-mono text-[9px] text-terminal-red">{phases.filter((phase) => phase.status === "completed").length}/{phases.length} stages cleared</span>
    </div>
    <div className="relative grid gap-px bg-border md:grid-flow-col md:auto-cols-fr">
      {phases.map((phase, index) => {
        const phaseWorkers = workers.filter((worker) => worker.phaseId === phase.id);
        const modelRefs = [...new Set(phaseWorkers.map((worker) => worker.modelRef).filter(Boolean))] as string[];
        return <div key={phase.id} className={cn("mission-stage-enter relative min-w-0 bg-background p-3", phase.status === "running" && "bg-terminal-red/[0.04]")} style={{ animationDelay: `${index * 90}ms` }}>
          {index < phases.length - 1 ? <span className="absolute -right-2 top-6 z-10 hidden h-4 w-4 rotate-45 border-r border-t border-terminal-red bg-background md:block"/> : null}
          <div className="mb-4 flex items-center justify-between"><span className={cn("grid h-7 w-7 place-items-center border font-display text-xs", phase.status === "completed" ? "border-terminal-red bg-terminal-red text-white" : phase.status === "running" ? "mission-active-node border-terminal-red text-terminal-red" : phase.status === "failed" ? "border-terminal-red text-terminal-red" : "border-border text-muted-foreground")}>{String(index + 1).padStart(2, "0")}</span><span className="font-mono text-[8px] uppercase text-muted-foreground">{PHASE_STATUS_LABEL[phase.status] ?? phase.status}</span></div>
          <h4 className="truncate font-display text-xs font-semibold uppercase">{phase.name}</h4>
          <p className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-4 text-muted-foreground">{phase.instructions || "Awaiting phase instructions."}</p>
          <div className="mt-3 border-t pt-2"><p className="font-mono text-[8px] text-muted-foreground">{phaseWorkers.length} worker{phaseWorkers.length === 1 ? "" : "s"}</p>{modelRefs.slice(0, 2).map((model) => <p key={model} className="mt-1 truncate font-mono text-[9px] text-foreground" title={model}>{model}</p>)}</div>
        </div>;
      })}
    </div>
  </section>;
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
              <div className={cn("h-3 w-3 border-2", dotClass)} />
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
                      ? "border-terminal-red bg-terminal-red text-white"
                      : phase.status === "running"
                        ? "border-terminal-red text-terminal-red"
                        : phase.status === "failed"
                          ? "border-terminal-red border-dashed text-terminal-red"
                          : phase.status === "paused"
                            ? "border-foreground text-foreground"
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
    <div className={cn("border bg-muted/20 p-2.5 text-xs", worker.status === "running" && "border-terminal-red/50")}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={cn("font-semibold truncate", statusColor)}>
            {worker.role || `Worker ${worker.workerIndex}`}
          </span>
          {worker.status === "running" ? (
            <Loader2 className="h-3 w-3 animate-spin text-terminal-red shrink-0" />
          ) : worker.status === "completed" ? (
            <CheckCircle2 className="h-3 w-3 text-terminal-red shrink-0" />
          ) : worker.status === "failed" ? (
            <XCircle className="h-3 w-3 text-terminal-red shrink-0" />
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
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap border bg-muted/50 p-2 text-[10px] text-foreground">
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
    <div className="space-y-4" data-testid="dynamic-run-detail">
      <section className="hud-frame border border-terminal-red/40 bg-card/30">
        <div className="flex flex-wrap items-start justify-between gap-3 p-3">
          <div className="flex min-w-0 items-start gap-3">
            {onBack ? <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onBack}><ArrowLeft className="h-4 w-4"/></Button> : null}
            <div className="min-w-0"><div className="mb-1 flex items-center gap-2"><span className={cn("inline-flex h-5 items-center border px-1.5 font-display text-[9px] uppercase", statusConfig.className)}>{isRunning ? <span className="mr-1 h-1.5 w-1.5 bg-white pulse-red"/> : null}{statusConfig.label}</span><span className="font-mono text-[9px] text-muted-foreground">MISSION / {run.id.slice(0, 10)}</span></div><h2 className="truncate font-display text-xl font-semibold uppercase">{run.name}</h2>{run.description ? <p className="mt-1 line-clamp-2 max-w-3xl text-xs text-muted-foreground">{run.description}</p> : null}</div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {isPausable && onPause ? <Button variant="outline" size="sm" className="h-8" onClick={onPause}><Pause className="mr-1.5 h-3.5 w-3.5"/>Pause</Button> : null}
            {run.status === "paused" && onResume ? <Button variant="outline" size="sm" className="h-8" onClick={onResume}><Play className="mr-1.5 h-3.5 w-3.5"/>Resume</Button> : null}
            {isCancellable && onCancel ? <Button variant="outline" size="sm" className="h-8 border-terminal-red/40 text-terminal-red" onClick={onCancel}><Square className="mr-1.5 h-3.5 w-3.5"/>Cancel</Button> : null}
            {run.status === "completed" && onSaveCommand ? <Button variant="outline" size="sm" className="h-8" onClick={onSaveCommand}><Save className="mr-1.5 h-3.5 w-3.5"/>Save command</Button> : null}
          </div>
        </div>
        <div className="grid grid-cols-2 border-t sm:grid-cols-3 md:grid-cols-6">
          {[
            ["created", formatTime(run.createdAt)], ["started", formatTime(run.startedAt)], ["completed", formatTime(run.completedAt)],
            ["duration", formatDuration(run.startedAt, run.completedAt)], ["cost", formatCost(run.actualCostUsd)],
            ["tokens", totalInTokens > 0 || totalOutTokens > 0 ? (totalInTokens + totalOutTokens).toLocaleString() : "—"],
          ].map(([label, value], index) => <div key={label} className={cn("border-b p-2.5 sm:border-b-0", index > 0 && "border-l")}><p className="font-display text-sm tabular-nums">{value}</p><p className="font-mono text-[8px] text-muted-foreground">{label}</p></div>)}
        </div>
      </section>

      <DeliveryStageRail phases={run.phases} workers={run.workers}/>

      <section className="border-y border-border bg-card/20">
        <div className="flex items-center gap-2 border-b px-3 py-2"><Activity className="h-4 w-4 text-terminal-red"/><h3 className="font-display text-sm font-semibold uppercase">Phase Timeline</h3><span className="ml-auto font-mono text-[9px] text-muted-foreground">open a phase for worker evidence</span></div>
        <div className="p-3"><PhaseTimeline phases={run.phases} workers={run.workers} expandedPhases={expandedPhases} togglePhase={togglePhase} onRestartWorker={onRestartWorker}/></div>
      </section>

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

      <ResultReceipt runId={run.id} />

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
