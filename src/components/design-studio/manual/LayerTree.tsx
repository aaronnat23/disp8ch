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
  const byId = new Map(targets.map((target) => [target.id, target]));
  const depthFor = (target: DesignEditTarget): number => {
    let depth = 0;
    let parentId = target.parentId;
    const seen = new Set<string>();
    while (parentId && byId.has(parentId) && !seen.has(parentId) && depth < 8) {
      seen.add(parentId);
      depth++;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return depth;
  };
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
          style={{ paddingLeft: `${8 + depthFor(target) * 12}px` }}
          className={`flex w-full min-w-0 items-center justify-between gap-2 rounded border px-2 py-1.5 text-left text-xs ${
            selectedId === target.id ? "border-terminal-red bg-terminal-red/10" : "border-border hover:bg-muted/40"
          }`}
        >
          <span className="min-w-0 truncate font-medium">{target.label}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{Math.round(target.bounds?.width || 0)}×{Math.round(target.bounds?.height || 0)}</span>
        </button>
      ))}
    </div>
  );
}
