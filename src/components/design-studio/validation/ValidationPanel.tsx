"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";

export function ValidationPanel({
  report,
  onRunCheck,
  checking,
}: {
  report: any | null;
  onRunCheck: () => void;
  checking: boolean;
}) {
  const failures = Array.isArray(report?.failures) ? report.failures : [];
  const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
  return (
    <div className="flex h-32 min-h-0 items-stretch gap-3 border-t border-border bg-card/40 p-3 text-xs">
      <button
        type="button"
        onClick={onRunCheck}
        disabled={checking}
        className="h-9 rounded border border-border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
      >
        {checking ? "Checking..." : "Run Visual Check"}
      </button>
      <div className="min-w-[140px]">
        {report ? (
          <div className="flex items-center gap-2">
            {report.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-destructive" />}
            <span className="font-semibold">Score {report.score ?? "?"}</span>
          </div>
        ) : (
          <span className="text-muted-foreground">No preview report yet.</span>
        )}
        <div className="mt-1 text-[11px] text-muted-foreground">
          {failures.length} failures · {warnings.length} warnings
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {[...failures, ...warnings].slice(0, 6).map((item, index) => (
          <div key={`${index}-${item}`} className="truncate text-[11px] text-muted-foreground">{item}</div>
        ))}
      </div>
      {report?.screenshots?.desktop ? (
        <img src={report.screenshots.desktop} alt="Desktop validation screenshot" className="h-full w-36 rounded border border-border object-cover" />
      ) : null}
      {report?.screenshots?.mobile ? (
        <img src={report.screenshots.mobile} alt="Mobile validation screenshot" className="h-full w-20 rounded border border-border object-cover" />
      ) : null}
    </div>
  );
}
