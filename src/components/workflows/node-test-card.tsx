"use client";

import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function NodeTestCard({
  testing,
  result,
}: {
  testing: boolean;
  result: { success: boolean; output?: unknown; error?: string; durationMs?: number } | null;
}) {
  if (testing) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Testing node...
      </div>
    );
  }

  if (!result) return null;

  return (
    <div
      className={`mt-2 rounded-md border p-3 ${
        result.success
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-destructive/30 bg-destructive/5"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {result.success ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          ) : (
            <XCircle className="h-4 w-4 text-destructive" />
          )}
          <span className="text-xs font-semibold">
            {result.success ? "Test Passed" : "Test Failed"}
          </span>
        </div>
        {result.durationMs ? (
          <Badge variant="outline" className="text-[10px]">
            {Math.round(result.durationMs)}ms
          </Badge>
        ) : null}
      </div>
      {result.output !== undefined ? (
        <div className="rounded bg-muted/50 p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Output</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-foreground">
            {typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)}
          </pre>
        </div>
      ) : null}
      {result.error ? (
        <div className="mt-2 rounded bg-destructive/10 p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-destructive">Error</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-destructive">
            {result.error}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
