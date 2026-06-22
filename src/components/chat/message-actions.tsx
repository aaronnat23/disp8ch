"use client";

import { useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

type MessageActionsProps = {
  content: string;
  onRegenerate?: () => void;
  className?: string;
};

/**
 * Hover-reveal action row that hangs off an assistant message.
 * - Copy: copies the assistant's plain-text content to clipboard.
 * - Regenerate: re-runs the previous user message (caller provides handler).
 *
 * Small, low-contrast icons appear on bubble hover and acknowledge the click
 * with a check icon.
 */
export function MessageActions({ content, onRegenerate, className }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore — clipboard can fail in cross-origin iframes */
    }
  };

  return (
    <div
      className={cn(
        "mt-2 flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
        className,
      )}
    >
      <button
        type="button"
        onClick={handleCopy}
        className="flex items-center gap-1 rounded border border-border/60 bg-background/60 px-2 py-1 font-mono hover:border-foreground/40 hover:text-foreground"
        aria-label="Copy message"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
      {onRegenerate ? (
        <button
          type="button"
          onClick={onRegenerate}
          className="flex items-center gap-1 rounded border border-border/60 bg-background/60 px-2 py-1 font-mono hover:border-foreground/40 hover:text-foreground"
          aria-label="Regenerate response"
        >
          <RotateCcw className="h-3 w-3" />
          Regen
        </button>
      ) : null}
    </div>
  );
}
