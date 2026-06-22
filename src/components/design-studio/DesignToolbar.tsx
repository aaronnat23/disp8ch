"use client";

import { Download, FilePlus2, RefreshCw, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DesignToolbar({
  disabled,
  newArtifactDisabled,
  onImportArtifact,
  onNewArtifact,
  onRefresh,
  onExportHtml,
}: {
  disabled: boolean;
  newArtifactDisabled: boolean;
  onImportArtifact: () => void;
  onNewArtifact: () => void;
  onRefresh: () => void;
  onExportHtml: () => void;
}) {
  return (
    <div className="flex h-12 items-center gap-2 border-b border-border bg-card/40 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Sparkles className="h-4 w-4 text-terminal-red" />
        <span className="truncate text-xs font-semibold uppercase tracking-wider">Design Studio</span>
        <span className="hidden truncate text-[11px] text-muted-foreground md:inline">
          Import HTML, code, or image. Edit and export when ready.
        </span>
      </div>
      <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onImportArtifact}>
        <Upload className="h-3.5 w-3.5" />
        Import
      </Button>
      <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onNewArtifact} disabled={newArtifactDisabled}>
        <FilePlus2 className="h-3.5 w-3.5" />
        Blank HTML
      </Button>
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onRefresh} title="Refresh">
        <RefreshCw className="h-4 w-4" />
      </Button>
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onExportHtml} disabled={disabled} title="Export HTML">
        <Download className="h-4 w-4" />
      </Button>
    </div>
  );
}
