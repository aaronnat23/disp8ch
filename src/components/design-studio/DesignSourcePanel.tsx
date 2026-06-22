"use client";

import dynamic from "next/dynamic";
import { AlertCircle, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HtmlValidationResult } from "@/components/design-studio/types";

const MonacoEditor = dynamic(
  () => import("@/components/ui/monaco-editor").then((mod) => ({ default: mod.MonacoEditor })),
  { ssr: false, loading: () => <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading editor...</div> },
);

export function DesignSourcePanel({
  source,
  savedSource,
  validation,
  versionNumber,
  saving,
  onChange,
  onSave,
  onRevert,
}: {
  source: string;
  savedSource: string;
  validation: HtmlValidationResult | null;
  versionNumber: number | null;
  saving: boolean;
  onChange: (source: string) => void;
  onSave: () => void;
  onRevert: () => void;
}) {
  const dirty = source !== savedSource;
  return (
    <aside className="flex h-full w-[430px] shrink-0 flex-col border-l border-border bg-card/50">
      <div className="flex h-12 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-wider">Source</div>
          <div className="text-[10px] text-muted-foreground">v{versionNumber ?? 0}{dirty ? " · unsaved" : ""}</div>
        </div>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onRevert} disabled={!dirty} title="Revert">
          <RotateCcw className="h-4 w-4" />
        </Button>
        <Button size="sm" onClick={onSave} disabled={!dirty || saving || !source.trim()} className="h-8 gap-1.5">
          <Save className="h-3.5 w-3.5" />
          Save
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <MonacoEditor value={source} onChange={onChange} language="html" height="100%" />
      </div>
      <div className="max-h-40 overflow-auto border-t border-border px-3 py-2 text-[11px]">
        {validation?.errors.length ? (
          <div className="space-y-1 text-destructive">
            {validation.errors.map((item) => (
              <div key={item} className="flex gap-1.5"><AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />{item}</div>
            ))}
          </div>
        ) : validation?.warnings.length ? (
          <div className="space-y-1 text-muted-foreground">
            {validation.warnings.slice(0, 4).map((item) => <div key={item}>{item}</div>)}
          </div>
        ) : (
          <span className="text-muted-foreground">Validation will appear after source loads.</span>
        )}
      </div>
    </aside>
  );
}
