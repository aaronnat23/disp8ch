"use client";

import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";

type CourtRoundTimelineProps = {
  round: number;
  totalRounds: number;
  isRunning: boolean;
  settled: boolean;
};

/**
 * Round 1 → Round 2 → Verdict. Pure state markers, no animation — the active
 * step is just a colour accent.
 */
export function CourtRoundTimeline({ round, totalRounds, isRunning, settled }: CourtRoundTimelineProps) {
  const rounds = Array.from({ length: Math.max(1, totalRounds) }, (_, i) => i + 1);
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px] font-mono uppercase tracking-wider">
      {rounds.map((r) => {
        const done = settled || r < round;
        const active = !settled && isRunning && r === round;
        return (
          <span key={r} className="flex items-center gap-1">
            <span
              className={cn(
                "rounded px-1.5 py-0.5",
                active
                  ? "bg-terminal-red/15 text-terminal-red"
                  : done
                    ? "bg-emerald-500/10 text-emerald-400"
                    : "bg-muted text-muted-foreground",
              )}
            >
              Round {r}
            </span>
            <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
          </span>
        );
      })}
      <span
        className={cn(
          "rounded px-1.5 py-0.5",
          settled ? "bg-emerald-500/15 text-emerald-300" : "bg-muted text-muted-foreground",
        )}
      >
        Verdict
      </span>
    </div>
  );
}
