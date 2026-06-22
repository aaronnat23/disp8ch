"use client";

import { Badge } from "@/components/ui/badge";

export interface TestRunResult {
  departmentId: string;
  modelCalls: number;
  seededFinding: string | null;
  inboxPreflight: { wakeAgent: boolean; count: number; files: string[] };
  wikiNote: string | null;
  processedMoved: string[];
  briefPath: string;
  brief: string;
  vaultRoot: string;
  briefExists: boolean;
}

export function RunSummary({ result }: { result: TestRunResult }) {
  return (
    <div className="space-y-3 rounded-md border border-terminal-border bg-black/30 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-terminal-text">Test run complete</span>
        <Badge variant="outline">{result.modelCalls} model calls</Badge>
        {result.briefExists ? <Badge variant="outline">brief archived</Badge> : null}
      </div>
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-terminal-muted">
        <dt>Inbox preflight</dt>
        <dd className="font-mono">{result.inboxPreflight.count} file(s) · wakeAgent={String(result.inboxPreflight.wakeAgent)}</dd>
        <dt>Seeded finding</dt>
        <dd className="truncate font-mono">{result.seededFinding ?? "—"}</dd>
        <dt>Wiki note</dt>
        <dd className="truncate font-mono">{result.wikiNote ?? "—"}</dd>
        <dt>Processed moved</dt>
        <dd className="font-mono">{result.processedMoved.length ? result.processedMoved.join(", ") : "—"}</dd>
        <dt>Brief</dt>
        <dd className="truncate font-mono">{result.briefPath}</dd>
      </dl>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[11px] text-terminal-text">
        {result.brief}
      </pre>
    </div>
  );
}
