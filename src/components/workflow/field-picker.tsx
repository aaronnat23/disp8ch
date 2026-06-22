"use client";

import { useMemo } from "react";
import type { ExecutionDataEntry } from "@/lib/engine/execution-data-map";

export function WorkflowFieldPicker(props: {
  dataMap: ExecutionDataEntry[];
  value?: string;
  onChange: (expression: string) => void;
  disabled?: boolean;
}) {
  const options = useMemo(() => {
    return props.dataMap.flatMap((entry) =>
      entry.fields.map((field) => ({
        key: `${entry.nodeId}:${field.path}`,
        label: `${entry.nodeLabel}.${field.path}`,
        expression: `{{ nodes.${entry.nodeId}.${field.path} }}`,
        preview: field.valuePreview,
        type: field.type,
      })),
    );
  }, [props.dataMap]);

  return (
    <select
      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      value={props.value ?? ""}
      disabled={props.disabled || options.length === 0}
      onChange={(event) => props.onChange(event.target.value)}
    >
      <option value="">{options.length ? "Select a previous node field" : "Run or pin data to see fields"}</option>
      {options.map((option) => (
        <option key={option.key} value={option.expression}>
          {option.label} ({option.type}) - {option.preview}
        </option>
      ))}
    </select>
  );
}
