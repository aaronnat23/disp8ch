"use client";

import { cn } from "@/lib/utils";
import { Crown } from "lucide-react";
import type { CourtAgentState, CourtParticipant } from "./court-types";

/* A tiny deterministic glyph so each agent reads as a distinct "person" in the
   chamber without any image fetch. Pure CSS gradient, stable per agent id. */
function seatHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash % 360;
}

export function CourtSeatGlyph({ seed, size = 28 }: { seed: string; size?: number }) {
  const hue = seatHue(seed);
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 border border-foreground/20"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 32% 24%, hsl(${hue} 86% 64%), hsl(${(hue + 48) % 360} 78% 48%))`,
      }}
    />
  );
}

/* Red/ink only: state reads through weight, dash, and red intensity — never a
   second hue (identity glyph colors are the one exception). */
const STATE_CLASS: Record<CourtAgentState, string> = {
  waiting: "court-seat--waiting border-border bg-card",
  thinking: "court-seat--thinking border-foreground/30 bg-secondary/60",
  speaking: "court-seat--speaking border-terminal-red/70 bg-terminal-red/[0.07]",
  voted: "court-seat--voted border-foreground/30 bg-card",
  dissenting: "court-seat--dissenting border-dashed border-terminal-red/60 bg-terminal-red/[0.04]",
  simulated: "court-seat--simulated border-dashed border-border bg-card",
  error: "court-seat--error border-terminal-red/60 bg-terminal-red/5",
};

const STATE_CHIP: Record<CourtAgentState, string> = {
  waiting: "wait",
  thinking: "think",
  speaking: "live",
  voted: "voted",
  dissenting: "dissent",
  simulated: "sim",
  error: "error",
};

/**
 * One fixed-size seat in the council chamber. State changes only swap colours /
 * a small transform; width and height stay constant to avoid layout shift.
 */
export function CourtAgentSeat({ participant }: { participant: CourtParticipant }) {
  const { state } = participant;
  return (
    <article
      className={cn(
        "court-seat relative flex h-[68px] items-center gap-2.5 border px-2.5",
        participant.isWinner ? "court-seat--voted hud-frame border-terminal-red bg-terminal-red/10" : STATE_CLASS[state],
      )}
      title={`${participant.agentName} — ${participant.roleTitle}`}
      data-state={state}
    >
      <CourtSeatGlyph seed={participant.agentId} />
      <div className="min-w-0 flex-1 pr-12">
        <div className="flex items-center gap-1 font-display text-[12px] font-semibold leading-tight">
          {participant.isJudge ? <Crown className="h-3 w-3 shrink-0 text-terminal-red" /> : null}
          <span className="truncate">{participant.agentName}</span>
        </div>
        <div className="truncate text-[10px] text-muted-foreground">{participant.roleTitle}</div>
        {participant.vote ? (
          <div className="court-vote-token mt-0.5 inline-flex max-w-full items-center gap-1 border border-border bg-muted/40 px-1 py-px text-[9.5px] font-mono">
            <span className="truncate">{participant.vote}</span>
            {typeof participant.confidence === "number" ? (
              <span className="shrink-0 text-muted-foreground">· {participant.confidence}%</span>
            ) : null}
          </div>
        ) : state === "thinking" || state === "speaking" ? (
          <div className="court-thinking-dots mt-1 flex items-center gap-0.5" aria-hidden>
            <span className="h-1 w-1 bg-current opacity-60" />
            <span className="h-1 w-1 bg-current opacity-60" />
            <span className="h-1 w-1 bg-current opacity-60" />
          </div>
        ) : null}
      </div>
      <span
        className={cn(
          "absolute right-1.5 top-1.5 px-1 py-px font-display text-[8px] font-semibold uppercase tracking-wider",
          participant.isWinner || state === "speaking"
            ? "bg-terminal-red text-primary-foreground"
            : state === "error"
              ? "bg-terminal-red/80 text-primary-foreground"
              : state === "dissenting"
                ? "border border-terminal-red/60 text-terminal-red"
                : state === "voted"
                  ? "bg-foreground/80 text-background"
                  : "border border-border text-muted-foreground",
        )}
      >
        {participant.isWinner ? "win" : STATE_CHIP[state]}
      </span>
    </article>
  );
}
