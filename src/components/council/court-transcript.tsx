"use client";

import { cn } from "@/lib/utils";
import { MessagesSquare } from "lucide-react";
import { CourtSeatGlyph } from "./court-agent-seat";
import type { CourtOpinion } from "./court-types";

/**
 * Deliberation transcript — the readable record of what each agent actually
 * argued, so a council decision is legible (the reasoning), not just a final
 * verdict. Pure renderer: it draws the `opinions` the stage already receives
 * (each agent's stance, concern, vote, and confidence) as a conversation. While
 * a session is running, entries stream in as agents speak.
 */
export function CourtTranscript({ opinions, isRunning }: { opinions: CourtOpinion[]; isRunning: boolean }) {
  if (opinions.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-card" data-court-transcript="1">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          <MessagesSquare className="h-3.5 w-3.5 text-terminal-red" />
          Deliberation
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">
          {opinions.length} {opinions.length === 1 ? "argument" : "arguments"}
          {isRunning ? " · live" : ""}
        </span>
      </div>
      <div className="max-h-[340px] space-y-2.5 overflow-y-auto p-3">
        {opinions.map((opinion, index) => (
          <div
            key={`${opinion.agentId}-${index}`}
            className={cn(
              "rounded-md border border-border/70 bg-background/40 p-2.5",
              opinion.error ? "border-red-500/40" : "",
            )}
          >
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <CourtSeatGlyph seed={opinion.agentId} size={22} />
              <span className="text-xs font-semibold">{opinion.agentName}</span>
              <span className="text-[10px] text-muted-foreground">{opinion.roleTitle}</span>
              {opinion.simulated ? (
                <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] font-mono uppercase tracking-wider text-amber-400">
                  offline
                </span>
              ) : null}
              {opinion.vote ? (
                <span className="ml-auto inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-px text-[10px] font-mono">
                  <span className="max-w-[150px] truncate">{opinion.vote}</span>
                  {typeof opinion.confidence === "number" ? (
                    <span className="shrink-0 text-muted-foreground">· {opinion.confidence}%</span>
                  ) : null}
                </span>
              ) : null}
            </div>
            {opinion.stance ? (
              <p className="whitespace-pre-wrap text-xs leading-5 text-foreground/90">{opinion.stance}</p>
            ) : null}
            {opinion.concerns && opinion.concerns.trim().length > 0 ? (
              <p className="mt-1.5 border-l-2 border-amber-500/40 pl-2 text-[11px] leading-5 text-muted-foreground">
                <span className="font-semibold text-amber-400/90">Concern: </span>
                {opinion.concerns}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
