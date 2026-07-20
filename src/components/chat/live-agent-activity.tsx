"use client";

import { Check, Database, MessageSquareText, ScanSearch, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

export type LiveAgentProgressEvent = {
  id: string;
  event: string;
  label?: string;
  status?: string;
};

export type LiveAgentToolState = {
  id: string;
  name: string;
  status: "running" | "done" | "error";
};

type LiveAgentActivityProps = {
  phase?: string | null;
  label?: string | null;
  detail?: string | null;
  progressEvents: LiveAgentProgressEvent[];
  tools: LiveAgentToolState[];
  isStreaming: boolean;
  reasoningSignals?: number;
};

const STAGES = [
  { label: "Interpret", icon: ScanSearch },
  { label: "Resolve", icon: Database },
  { label: "Execute", icon: Wrench },
  { label: "Return", icon: MessageSquareText },
] as const;

export function getLiveAgentActivityStage(input: {
  phase?: string | null;
  progressEvents?: LiveAgentProgressEvent[];
  tools?: LiveAgentToolState[];
  isStreaming?: boolean;
}): number {
  if (input.isStreaming) return 3;
  const phase = String(input.phase || "").toLowerCase();
  const eventText = (input.progressEvents || [])
    .slice(0, 3)
    .map((event) => `${event.event} ${event.label || ""} ${event.status || ""}`)
    .join(" ")
    .toLowerCase();
  if (
    (input.tools || []).length > 0 ||
    /tool|execut|workflow|action|node|evidence|council|browser|run/.test(`${phase} ${eventText}`)
  ) return 2;
  if (/context|memory|retriev|draft|plan|review|classif|select|resolve/.test(`${phase} ${eventText}`)) return 1;
  if (/model|stream|respond|final|complet|synthesi/.test(`${phase} ${eventText}`)) return 3;
  return 0;
}

export function LiveAgentActivity({
  phase,
  label,
  detail,
  progressEvents,
  tools,
  isStreaming,
  reasoningSignals = 0,
}: LiveAgentActivityProps) {
  const activeStage = getLiveAgentActivityStage({ phase, progressEvents, tools, isStreaming });
  const latestEvents = progressEvents.filter((event) => event.label).slice(0, 3);
  const runningTools = tools.filter((tool) => tool.status === "running").length;
  const completedTools = tools.filter((tool) => tool.status === "done").length;
  const statusLabel = label || (isStreaming ? "Composing the result" : "Routing the request");

  return (
    <section
      data-testid="live-agent-activity"
      data-active-stage={STAGES[activeStage].label.toLowerCase()}
      aria-live="polite"
      className="agent-activity-shell border border-terminal-red/35 bg-background/90 shadow-[inset_3px_0_0_var(--terminal-red),0_18px_50px_rgba(0,0,0,0.2)]"
    >
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border/70 px-3">
        <div className="flex items-center gap-2">
          <span className="agent-activity-beacon h-2 w-2 bg-terminal-red" aria-hidden="true" />
          <span className="font-display text-[11px] font-semibold uppercase text-terminal-red">Agent activity</span>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {String(activeStage + 1).padStart(2, "0")}/04 · {STAGES[activeStage].label}
        </span>
      </div>

      <div className="grid grid-cols-4 border-b border-border/70" aria-label="Execution progress">
        {STAGES.map((stage, index) => {
          const StageIcon = stage.icon;
          const state = index < activeStage ? "complete" : index === activeStage ? "active" : "pending";
          return (
            <div
              key={stage.label}
              data-stage={stage.label.toLowerCase()}
              data-state={state}
              className={cn(
                "relative flex min-h-14 items-center gap-2 border-r border-border/60 px-3 last:border-r-0",
                state === "active" && "bg-terminal-red/8 text-foreground",
                state === "complete" && "text-foreground",
                state === "pending" && "text-muted-foreground/55",
              )}
            >
              <span
                className={cn(
                  "grid h-6 w-6 shrink-0 place-items-center border",
                  state === "complete" && "border-terminal-red bg-terminal-red text-background",
                  state === "active" && "agent-activity-marker border-terminal-red text-terminal-red",
                  state === "pending" && "border-border text-muted-foreground/50",
                )}
              >
                {state === "complete" ? <Check className="h-3.5 w-3.5" /> : <StageIcon className="h-3.5 w-3.5" />}
              </span>
              <span className="truncate font-display text-[10px] font-semibold uppercase">{stage.label}</span>
              {state === "active" ? <span className="absolute inset-x-0 bottom-0 h-px bg-terminal-red" aria-hidden="true" /> : null}
            </div>
          );
        })}
      </div>

      <div className="agent-activity-event px-3 py-3" key={`${phase || "queued"}-${statusLabel}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="font-display text-sm font-semibold text-foreground">{statusLabel}</div>
            {detail ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div> : null}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            {runningTools > 0 ? <span className="border border-terminal-red/50 px-2 py-1 font-mono text-[9px] text-terminal-red">{runningTools} live</span> : null}
            {completedTools > 0 ? <span className="border border-border px-2 py-1 font-mono text-[9px] text-muted-foreground">{completedTools} done</span> : null}
            {reasoningSignals > 0 ? <span className="border border-border px-2 py-1 font-mono text-[9px] text-muted-foreground">model signal</span> : null}
          </div>
        </div>

        {latestEvents.length > 0 ? (
          <div className="mt-3 grid gap-1.5">
            {latestEvents.map((event, index) => (
              <div
                key={event.id}
                className="agent-activity-event-row flex min-h-7 items-center gap-2 border-l border-border pl-2 text-[11px]"
                style={{ animationDelay: `${index * 55}ms` }}
              >
                <span className={cn("h-1.5 w-1.5 shrink-0", index === 0 ? "bg-terminal-red" : "bg-foreground/25")} aria-hidden="true" />
                <span className={cn("min-w-0 flex-1 truncate", index === 0 ? "text-foreground" : "text-muted-foreground")}>{event.label}</span>
                {event.status ? <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{event.status}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
