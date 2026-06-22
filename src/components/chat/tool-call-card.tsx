"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Wrench, CheckCircle2, XCircle } from "lucide-react";

export interface ToolCallCardProps {
  name: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  status: "running" | "done" | "error";
  live?: boolean;
}

export function ToolCallCard({ name, args, resultPreview, status, live = true }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const StatusIcon = status === "running" ? Loader2
    : status === "error" ? XCircle
    : CheckCircle2;

  return (
    <div className={`my-1 rounded border ${live ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-muted/30"} px-2 py-1 text-xs`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full text-left"
      >
        <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="font-mono font-medium truncate">{name}</span>
        <StatusIcon className={`h-3 w-3 shrink-0 ml-auto ${status === "running" ? "animate-spin text-amber-400" : status === "error" ? "text-terminal-red" : "text-green-400"}`} />
        {args && <span className="shrink-0">{expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>}
      </button>
      {expanded && args && (
        <div className="mt-1.5 space-y-1 border-t border-border pt-1.5">
          {Object.entries(args).slice(0, 8).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <span className="text-muted-foreground font-mono shrink-0">{k}:</span>
              <span className="truncate font-mono">{String(v).slice(0, 120)}</span>
            </div>
          ))}
        </div>
      )}
      {expanded && resultPreview && (
        <div className="mt-1.5 border-t border-border pt-1.5">
          <div className="text-muted-foreground font-mono text-[10px] max-h-32 overflow-auto whitespace-pre-wrap break-all">
            {resultPreview.slice(0, 800)}
            {resultPreview.length > 800 && "..."}
          </div>
        </div>
      )}
    </div>
  );
}
