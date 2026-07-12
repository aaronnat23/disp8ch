"use client";

import { cn } from "@/lib/utils";
import { Gavel, Loader2, Mic } from "lucide-react";
import { CourtSeatGlyph } from "./court-agent-seat";
import type { CourtOpinion } from "./court-types";

type CourtPodiumProps = {
  isRunning: boolean;
  /** The session has finished (a result exists), regardless of whether a winner emerged. */
  settled?: boolean;
  /** The opinion currently in the spotlight (most recent contribution). */
  current?: CourtOpinion | null;
  /** Name of the agent expected to speak next, if known. */
  nextSpeaker?: string | null;
  /** When complete, the ruling line shown at the podium. */
  verdict?: string | null;
};

/**
 * The central podium: shows whoever just spoke (their stance + vote) while a
 * session runs, or the final ruling when complete. Only this card carries the
 * single allowed pulsing accent, and only while running.
 */
export function CourtPodium({ isRunning, settled: settledProp, current, nextSpeaker, verdict }: CourtPodiumProps) {
  const settled = settledProp ?? (!isRunning && Boolean(verdict));

  return (
    <div
      className={cn(
        "min-w-0 border px-4 py-3",
        settled
          ? "hud-frame border-foreground/40 bg-secondary/40"
          : isRunning
            ? "court-podium--active hud-frame border-terminal-red/50 bg-terminal-red/[0.05]"
            : "border-border bg-card",
      )}
    >
      <div className="mb-2 flex items-center gap-2 font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {settled ? <Gavel className="h-3.5 w-3.5 text-terminal-red" /> : <Mic className="h-3.5 w-3.5 text-terminal-red" />}
        {settled ? "Court Conclusion" : "Podium"}
      </div>

      {settled ? (
        <div className="court-stamp min-w-0">
          <div className={cn("break-words font-display text-sm font-semibold [overflow-wrap:anywhere]", verdict ? "text-foreground" : "text-muted-foreground")}>
            {verdict ? (
              <>
                <span className="mr-2 select-none text-terminal-red">&gt;</span>
                {verdict}
              </>
            ) : (
              "No decision reached"
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {verdict ? "The council has reached its ruling." : "The council adjourned without a clear winner."}
          </p>
        </div>
      ) : current ? (
        <div className="flex items-start gap-3">
          <CourtSeatGlyph seed={current.agentId} size={34} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 font-display text-sm font-semibold">
              <span className="truncate">{current.agentName}</span>
              <span className="text-[11px] font-normal normal-case tracking-normal text-muted-foreground">{current.roleTitle}</span>
              {current.vote ? (
                <span className="border border-border bg-muted/40 px-1.5 py-px font-mono text-[10px] font-normal tracking-normal">
                  → {current.vote} {typeof current.confidence === "number" ? `· ${current.confidence}%` : ""}
                </span>
              ) : null}
            </div>
            <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
              {current.stance || (isRunning ? "Presenting position…" : "")}
            </p>
            {current.concerns ? (
              <p className="mt-1 line-clamp-1 text-[11px] text-terminal-red/80">Concern: {current.concerns}</p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {isRunning ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-terminal-red" />
              Opening statements…
            </>
          ) : (
            "The podium is ready."
          )}
        </div>
      )}

      {isRunning && nextSpeaker ? (
        <div className="mt-2 border-t border-border/60 pt-1.5 font-mono text-[10px] text-muted-foreground">
          next up · {nextSpeaker}
        </div>
      ) : null}
    </div>
  );
}
