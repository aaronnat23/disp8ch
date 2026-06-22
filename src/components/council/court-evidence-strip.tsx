"use client";

import { FileText } from "lucide-react";
import type { CourtSource } from "./court-types";

/**
 * Thin strip of attached evidence/data sources the council argues from. Hidden
 * entirely when nothing is attached, to keep the stage calm.
 */
export function CourtEvidenceStrip({ sources }: { sources: CourtSource[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/60 bg-muted/10 px-2.5 py-1.5">
      <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        <FileText className="h-3 w-3" />
        Evidence · {sources.length}
      </span>
      {sources.slice(0, 6).map((source) => (
        <span
          key={source.id}
          className="max-w-[180px] truncate rounded border border-border bg-card px-1.5 py-0.5 text-[10px]"
          title={`${source.label} (${source.kind})`}
        >
          {source.label}
        </span>
      ))}
      {sources.length > 6 ? (
        <span className="text-[10px] text-muted-foreground">+{sources.length - 6} more</span>
      ) : null}
    </div>
  );
}
