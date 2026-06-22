"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { DesignEditTarget } from "@/components/design-studio/preview/selection-types";

export function AttributeInspector({
  target,
  onPatch,
}: {
  target: DesignEditTarget | null;
  onPatch: (patch: unknown, summary: string) => void;
}) {
  const [href, setHref] = useState("#");
  if (!target || (target.kind !== "link" && target.tag !== "a")) return null;
  return (
    <div className="space-y-2">
      <label className="text-[11px] font-medium uppercase text-muted-foreground">Href</label>
      <input
        value={href}
        onChange={(event) => setHref(event.target.value)}
        className="h-8 w-full rounded border border-border bg-background px-2 text-xs outline-none focus:border-terminal-red"
      />
      <Button
        size="sm"
        variant="outline"
        className="h-8 w-full"
        onClick={() => onPatch({ kind: "set-link", id: target.id, href }, `Update ${target.label} link`)}
      >
        Apply Link Patch
      </Button>
    </div>
  );
}
