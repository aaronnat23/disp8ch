"use client";

import type { HtmlValidationResult } from "@/components/design-studio/types";

export function DesignActivityPanel({ validation }: { validation: HtmlValidationResult | null }) {
  return (
    <div className="h-10 border-t border-border bg-card/40 px-3 py-2 text-[11px] text-muted-foreground">
      {validation ? (
        <span>
          {validation.stats.lines} lines · {validation.stats.chars} chars · {validation.stats.dataDisp8chIdCount} editable markers · {validation.errors.length} errors · {validation.warnings.length} warnings
        </span>
      ) : (
        <span>Ready.</span>
      )}
    </div>
  );
}
