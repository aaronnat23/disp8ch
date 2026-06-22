"use client";

import { cn } from "@/lib/utils";
import type { CourtTallyEntry } from "./court-types";

type CourtVoteRailProps = {
  tally: CourtTallyEntry[];
  winner?: string | null;
  /** Denominator label, e.g. "votes" / "points" / "weight". */
  unitLabel?: string;
  /** True once the session is final (marks the winning bar). */
  settled?: boolean;
};

/**
 * Compact live tally. Bars grow via width transition only (no layout thrash on
 * the surrounding grid because the rail itself has a fixed column width).
 */
export function CourtVoteRail({ tally, winner, unitLabel = "votes", settled }: CourtVoteRailProps) {
  const sorted = [...tally].sort((a, b) => b.votes - a.votes);
  const total = sorted.reduce((sum, t) => sum + t.votes, 0);
  const max = Math.max(1, ...sorted.map((t) => t.votes));

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
        <span>Tally</span>
        <span>{total} {unitLabel}</span>
      </div>
      {sorted.length === 0 ? (
        <div className="py-2 text-center text-[11px] text-muted-foreground">No votes cast yet.</div>
      ) : (
        <div className="space-y-1.5">
          {sorted.map((entry) => {
            const isWinner = settled && winner === entry.option && entry.votes > 0;
            const pct = (entry.votes / max) * 100;
            return (
              <div key={entry.option}>
                <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px]">
                  <span className={cn("truncate", isWinner ? "font-semibold text-emerald-300" : "text-foreground")}>
                    {entry.option}
                  </span>
                  <span className="shrink-0 font-mono text-muted-foreground">{entry.votes}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded bg-muted">
                  <div
                    className={cn("h-1.5 rounded transition-[width] duration-500 ease-out", isWinner ? "bg-emerald-500" : "bg-terminal-red/60")}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
