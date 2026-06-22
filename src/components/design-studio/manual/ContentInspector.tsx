"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DesignEditTarget } from "@/components/design-studio/preview/selection-types";

export function ContentInspector({
  target,
  onPatch,
}: {
  target: DesignEditTarget | null;
  onPatch: (patch: unknown, summary: string) => void;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    setText(target?.text || "");
  }, [target]);

  if (!target) return <div className="text-xs text-muted-foreground">Select an editable target in the preview or layer tree.</div>;

  const isLink = target.kind === "link" || target.tag === "a";
  return (
    <div className="space-y-2">
      <label className="text-[11px] font-medium uppercase text-muted-foreground">Text</label>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="h-24 w-full resize-none rounded border border-border bg-background p-2 text-xs outline-none focus:border-terminal-red"
      />
      <Button
        size="sm"
        className="h-8 w-full"
        onClick={() => onPatch(
          isLink ? { kind: "set-link", id: target.id, text } : { kind: "set-text", id: target.id, value: text },
          `Update ${target.label} text`,
        )}
      >
        Apply Content Patch
      </Button>
    </div>
  );
}
