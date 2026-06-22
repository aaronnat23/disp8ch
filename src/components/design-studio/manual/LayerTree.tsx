"use client";

import type { DesignEditTarget } from "@/components/design-studio/preview/selection-types";

export function LayerTree({
  targets,
  selectedId,
  onSelect,
}: {
  targets: DesignEditTarget[];
  selectedId: string | null;
  onSelect: (target: DesignEditTarget) => void;
}) {
  return (
    <div className="min-h-0 space-y-1 overflow-auto">
      {targets.length === 0 ? (
        <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
          No editable targets found. Add data-disp8ch-id markers to make the artifact easier to edit.
        </div>
      ) : targets.map((target) => (
        <button
          key={target.id}
          type="button"
          onClick={() => onSelect(target)}
          className={`flex w-full min-w-0 items-center justify-between gap-2 rounded border px-2 py-1.5 text-left text-xs ${
            selectedId === target.id ? "border-terminal-red bg-terminal-red/10" : "border-border hover:bg-muted/40"
          }`}
        >
          <span className="min-w-0 truncate font-medium">{target.label}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{target.kind}</span>
        </button>
      ))}
    </div>
  );
}
