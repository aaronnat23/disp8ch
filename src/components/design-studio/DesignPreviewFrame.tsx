"use client";

import { useEffect, useMemo, useRef } from "react";
import { AlertTriangle, Monitor } from "lucide-react";
import { injectDesignPreviewBridge } from "@/components/design-studio/preview/edit-bridge";
import type { DesignEditTarget, DesignPreviewMode, PreviewToHost } from "@/components/design-studio/preview/selection-types";
import type { HtmlValidationResult } from "@/components/design-studio/types";

export function DesignPreviewFrame({
  title,
  source,
  validation,
  mode = "preview",
  selectedTargetId,
  onTargets,
  onSelectTarget,
}: {
  title: string;
  source: string;
  validation: HtmlValidationResult | null;
  mode?: DesignPreviewMode;
  selectedTargetId?: string | null;
  onTargets?: (targets: DesignEditTarget[]) => void;
  onSelectTarget?: (target: DesignEditTarget) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const previewSource = useMemo(() => mode === "preview" ? source : injectDesignPreviewBridge(source), [mode, source]);

  useEffect(() => {
    const handler = (event: MessageEvent<PreviewToHost>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "disp8ch-design-targets") onTargets?.(message.targets);
      if (message.type === "disp8ch-design-select") onSelectTarget?.(message.target);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onSelectTarget, onTargets]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: "disp8ch-design-mode", mode }, "*");
  }, [mode, previewSource]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: "disp8ch-design-select", id: selectedTargetId ?? null }, "*");
  }, [selectedTargetId, previewSource]);

  if (!source) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="text-center">
          <Monitor className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <div className="text-sm font-medium">No artifact selected</div>
          <div className="mt-1 text-xs text-muted-foreground">Create or select an HTML artifact to preview.</div>
        </div>
      </div>
    );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-10 items-center gap-3 border-b border-border px-3">
        <Monitor className="h-4 w-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        {validation && !validation.ok ? (
          <span className="flex items-center gap-1 text-[11px] text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            {validation.errors.length} errors
          </span>
        ) : validation ? (
          <span className="text-[11px] text-muted-foreground">{validation.warnings.length} warnings</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 bg-zinc-950 p-4">
        <iframe
          ref={iframeRef}
          title={title}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          srcDoc={previewSource}
          className="h-full w-full border border-border bg-white"
        />
      </div>
    </section>
  );
}
