"use client";

import { MessageSquare, MousePointer2, SlidersHorizontal } from "lucide-react";
import { AttributeInspector } from "@/components/design-studio/manual/AttributeInspector";
import { ContentInspector } from "@/components/design-studio/manual/ContentInspector";
import { LayerTree } from "@/components/design-studio/manual/LayerTree";
import { StyleInspector } from "@/components/design-studio/manual/StyleInspector";
import { TokenInspector } from "@/components/design-studio/tweaks/TokenInspector";
import type { DesignEditTarget, DesignPreviewMode } from "@/components/design-studio/preview/selection-types";
import type { DesignToken } from "@/lib/design-studio/tokens";

export function ManualEditPanel({
  mode,
  targets,
  selectedTarget,
  tokens,
  onModeChange,
  onSelectTarget,
  onPatch,
  onAskAI,
}: {
  mode: DesignPreviewMode;
  targets: DesignEditTarget[];
  selectedTarget: DesignEditTarget | null;
  tokens: DesignToken[];
  onModeChange: (mode: DesignPreviewMode) => void;
  onSelectTarget: (target: DesignEditTarget) => void;
  onPatch: (patch: unknown, summary: string) => void;
  onAskAI: () => void;
}) {
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-border bg-card/30">
      <div className="flex h-10 items-center gap-1 border-b border-border px-2">
        {([
          ["preview", MousePointer2, "Preview"],
          ["edit", MousePointer2, "Edit"],
          ["comment", MessageSquare, "Comment"],
          ["tweaks", SlidersHorizontal, "Tweaks"],
        ] as const).map(([id, Icon, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => onModeChange(id)}
            className={`flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded text-[11px] ${
              mode === id ? "bg-terminal-red text-white" : "text-muted-foreground hover:bg-muted"
            }`}
            title={label}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
        <section className="space-y-2">
          <div className="text-[11px] font-semibold uppercase text-muted-foreground">Layers</div>
          <LayerTree targets={targets} selectedId={selectedTarget?.id ?? null} onSelect={onSelectTarget} />
        </section>
        {mode === "tweaks" ? (
          <section className="space-y-2">
            <div className="text-[11px] font-semibold uppercase text-muted-foreground">Tokens</div>
            <TokenInspector tokens={tokens} onPatch={onPatch} />
          </section>
        ) : (
          <section className="space-y-3">
            <div className="text-[11px] font-semibold uppercase text-muted-foreground">Inspector</div>
            <ContentInspector target={selectedTarget} onPatch={onPatch} />
            <StyleInspector target={selectedTarget} onPatch={onPatch} />
            <AttributeInspector target={selectedTarget} onPatch={onPatch} />
            {mode === "comment" ? (
              <div className="space-y-2 rounded border border-border bg-background p-2 text-xs text-muted-foreground">
                <p>
                  The Design assistant will attach the selected element id, text, bounds, and computed styles automatically.
                </p>
                <button
                  type="button"
                  onClick={onAskAI}
                  disabled={!selectedTarget}
                  className="w-full rounded border border-terminal-red/50 bg-terminal-red/10 px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-terminal-red/20 disabled:opacity-50"
                >
                  Ask AI about {selectedTarget?.label || selectedTarget?.id || "this element"}
                </button>
              </div>
            ) : null}
          </section>
        )}
      </div>
    </aside>
  );
}
