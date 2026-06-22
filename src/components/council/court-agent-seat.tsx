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
      className="inline-block shrink-0 rounded-full border border-white/30"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 32% 24%, hsl(${hue} 86% 64%), hsl(${(hue + 48) % 360} 78% 48%))`,
      }}
    />
  );
}

const STATE_CLASS: Record<CourtAgentState, string> = {
  waiting: "court-seat--waiting border-border bg-card",
  thinking: "court-seat--thinking border-sky-500/50 bg-sky-500/5",
  speaking: "court-seat--speaking border-terminal-red/60 bg-terminal-red/[0.07]",
  voted: "court-seat--voted border-border bg-card",
  dissenting: "court-seat--dissenting border-amber-500/50 bg-amber-500/5",
  simulated: "court-seat--simulated border-dashed border-border bg-card",
  error: "court-seat--error border-terminal-red/60 bg-terminal-red/5",
};

const STATE_LABEL: Record<CourtAgentState, string> = {
  waiting: "Waiting",
  thinking: "Thinking",
  speaking: "Speaking",
  voted: "Voted",
  dissenting: "Dissent",
  simulated: "Simulated",
  error: "Error",
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
        "court-seat relative flex h-[68px] items-center gap-2.5 rounded-lg border px-2.5",
        participant.isWinner ? "court-seat--voted border-emerald-500/55 bg-emerald-500/[0.06]" : STATE_CLASS[state],
      )}
      title={`${participant.agentName} — ${participant.roleTitle}`}
      data-state={state}
    >
      <CourtSeatGlyph seed={participant.agentId} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-[12px] font-semibold leading-tight">
          {participant.isJudge ? <Crown className="h-3 w-3 shrink-0 text-amber-400" /> : null}
          <span className="truncate">{participant.agentName}</span>
        </div>
        <div className="truncate text-[10px] text-muted-foreground">{participant.roleTitle}</div>
        {participant.vote ? (
          <div className="court-vote-token mt-0.5 inline-flex max-w-full items-center gap-1 rounded border border-border bg-muted/40 px-1 py-px text-[9.5px] font-mono">
            <span className="truncate">{participant.vote}</span>
            {typeof participant.confidence === "number" ? (
              <span className="shrink-0 text-muted-foreground">· {participant.confidence}%</span>
            ) : null}
          </div>
        ) : state === "thinking" || state === "speaking" ? (
          <div className="court-thinking-dots mt-1 flex items-center gap-0.5" aria-hidden>
            <span className="h-1 w-1 rounded-full bg-current opacity-60" />
            <span className="h-1 w-1 rounded-full bg-current opacity-60" />
            <span className="h-1 w-1 rounded-full bg-current opacity-60" />
          </div>
        ) : null}
      </div>
      <span
        className={cn(
          "absolute right-1.5 top-1.5 rounded-full px-1 py-px text-[8px] font-mono uppercase tracking-wider",
          state === "speaking"
            ? "bg-terminal-red text-white"
            : state === "error"
              ? "bg-terminal-red/80 text-white"
              : state === "dissenting"
                ? "bg-amber-500/80 text-white"
                : state === "voted" || participant.isWinner
                  ? "bg-emerald-500/80 text-white"
                  : "border border-border text-muted-foreground",
        )}
      >
        {participant.isWinner ? "Win" : STATE_LABEL[state].slice(0, 5)}
      </span>
    </article>
  );
}
