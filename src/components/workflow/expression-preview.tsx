"use client";

import { resolveExecutionDataPath, type ExecutionDataEntry } from "@/lib/engine/execution-data-map";

function preview(value: unknown): string {
  if (value === undefined) return "No matching field";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function WorkflowExpressionPreview(props: {
  expression: string;
  dataMap: ExecutionDataEntry[];
}) {
  const value = resolveExecutionDataPath({ dataMap: props.dataMap, expression: props.expression });
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
      <div className="mb-1 font-medium text-muted-foreground">Preview</div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">{preview(value)}</pre>
    </div>
  );
}
