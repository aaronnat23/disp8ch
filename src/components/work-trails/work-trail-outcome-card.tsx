"use client";

import { Check, Circle, ExternalLink, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkTrailEventLite } from "./work-trail-strip";
import { summarizeWorkTrailOutcome } from "./work-trail-outcome";

export function WorkTrailOutcomeCard({
  trail,
  events,
  resultHref,
}: {
  trail: { status: string; userMessage: string };
  events: WorkTrailEventLite[];
  resultHref?: string | null;
}) {
  const outcome = summarizeWorkTrailOutcome(trail, events);

  return (
    <section data-testid="work-trail-outcome" className="hud-frame border border-terminal-red/40 bg-terminal-red/[0.035] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="data-label text-terminal-red">{outcome.eyebrow}</div>
          <h3 className="mt-2 max-w-lg font-display text-xl font-semibold uppercase leading-tight text-foreground">
            {outcome.title}
          </h3>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{outcome.summary}</p>
        </div>
        <div className="grid h-11 w-11 shrink-0 place-items-center border border-terminal-red bg-terminal-red text-background">
          <ShieldCheck className="h-5 w-5" />
        </div>
      </div>

      {outcome.resultName ? (
        <div className="mt-4 flex items-center justify-between gap-3 border-y border-border/80 py-2.5">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase text-muted-foreground">Connected result</div>
            <div className="truncate text-sm font-medium text-foreground">{outcome.resultName}</div>
          </div>
          {resultHref ? (
            <a href={resultHref} className="inline-flex shrink-0 items-center gap-1.5 font-display text-xs font-semibold uppercase text-terminal-red hover:underline">
              Open result <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-5">
        {outcome.phases.map((phase) => (
          <div key={phase.label} className="min-w-0 bg-background px-3 py-3">
            <div className="flex items-center gap-1.5 font-display text-[11px] font-semibold uppercase text-foreground">
              {phase.complete ? <Check className="h-3.5 w-3.5 text-terminal-red" /> : <Circle className="h-3 w-3 text-muted-foreground" />}
              {phase.label}
            </div>
            <div
              className={cn(
                "mt-1 min-h-6 break-words font-mono text-[10px] leading-tight",
                phase.complete ? "text-foreground/75" : "text-muted-foreground",
              )}
            >
              {phase.detail}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 border-l-2 border-terminal-red pl-3 text-xs leading-relaxed text-muted-foreground">
        <span className="font-semibold text-foreground">Next:</span> {outcome.nextAction}
      </div>
    </section>
  );
}
