"use client";

import { ColorSwatchControl } from "@/components/design-studio/tweaks/ColorSwatchControl";
import { NumberSliderControl } from "@/components/design-studio/tweaks/NumberSliderControl";
import type { DesignToken } from "@/lib/design-studio/tokens";

export function TokenInspector({
  tokens,
  onPatch,
}: {
  tokens: DesignToken[];
  onPatch: (patch: unknown, summary: string) => void;
}) {
  if (tokens.length === 0) {
    return <div className="text-xs text-muted-foreground">No --disp8ch-* CSS tokens found.</div>;
  }
  return (
    <div className="space-y-1.5">
      {tokens.map((token) => (
        <div key={token.name} className="flex items-center gap-2 rounded border border-border px-2 py-1">
          <div className="min-w-0 flex-1 truncate text-[11px]">
            <div className="truncate font-medium">{token.name}</div>
            <div className="truncate text-muted-foreground">{token.value}</div>
          </div>
          {token.type === "color" ? (
            <ColorSwatchControl value={token.value} onChange={(value) => onPatch({ kind: "set-token", token: token.name, value }, `Set ${token.name}`)} />
          ) : token.type === "size" ? (
            <NumberSliderControl value={token.value} onChange={(value) => onPatch({ kind: "set-token", token: token.name, value }, `Set ${token.name}`)} />
          ) : null}
        </div>
      ))}
    </div>
  );
}
