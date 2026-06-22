"use client";

import { Button } from "@/components/ui/button";
import type { DesignEditTarget } from "@/components/design-studio/preview/selection-types";

const QUICK_CLASSES = ["is-primary", "is-muted", "is-compact", "is-highlighted"];

export function StyleInspector({
  target,
  onPatch,
}: {
  target: DesignEditTarget | null;
  onPatch: (patch: unknown, summary: string) => void;
}) {
  if (!target) return null;
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium uppercase text-muted-foreground">Classes</div>
      <div className="grid grid-cols-2 gap-1">
        {QUICK_CLASSES.map((className) => (
          <Button
            key={className}
            size="sm"
            variant="outline"
            className="h-7 justify-start px-2 text-[11px]"
            onClick={() => onPatch({ kind: "set-class", id: target.id, add: [className] }, `Add ${className} to ${target.label}`)}
          >
            {className}
          </Button>
        ))}
      </div>
    </div>
  );
}
