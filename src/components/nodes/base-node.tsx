"use client";

import { Handle, Position } from "@xyflow/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type NodeAccent =
  | "green"
  | "purple"
  | "blue"
  | "orange"
  | "amber"
  | "gray"
  | "teal"
  | "cyan"
  | "red"
  | "yellow";

const ACCENT: Record<NodeAccent, { header: string; chip: string; ring: string }> = {
  green: { header: "bg-emerald-500/10", chip: "bg-emerald-500", ring: "border-emerald-400 shadow-emerald-500/20" },
  purple: { header: "bg-violet-500/10", chip: "bg-violet-500", ring: "border-violet-400 shadow-violet-500/20" },
  blue: { header: "bg-sky-500/10", chip: "bg-sky-500", ring: "border-sky-400 shadow-sky-500/20" },
  orange: { header: "bg-orange-500/10", chip: "bg-orange-500", ring: "border-orange-400 shadow-orange-500/20" },
  amber: { header: "bg-amber-500/10", chip: "bg-amber-500", ring: "border-amber-400 shadow-amber-500/20" },
  gray: { header: "bg-slate-500/10", chip: "bg-slate-500", ring: "border-slate-400 shadow-slate-500/20" },
  teal: { header: "bg-teal-500/10", chip: "bg-teal-500", ring: "border-teal-400 shadow-teal-500/20" },
  cyan: { header: "bg-cyan-500/10", chip: "bg-cyan-500", ring: "border-cyan-400 shadow-cyan-500/20" },
  red: { header: "bg-red-500/10", chip: "bg-red-500", ring: "border-red-400 shadow-red-500/20" },
  yellow: { header: "bg-yellow-500/10", chip: "bg-yellow-500", ring: "border-yellow-400 shadow-yellow-500/20" },
};

type BaseNodeProps = {
  accent: NodeAccent;
  icon: ReactNode;
  label: ReactNode;
  selected?: boolean;
  /** When true, the node is bypassed at runtime — show a muted style + badge. */
  disabled?: boolean;
  /** Per-node execution result overlay (after a run). */
  runStatus?: "running" | "completed" | "failed" | "skipped" | "cancelled" | null;
  runDurationMs?: number;
  /** Body content — usually a short description line. */
  children?: ReactNode;
  /** Show the left (input) handle. Triggers omit this. */
  hasTarget?: boolean;
  /** Show the right (output) handle. Terminal nodes may omit this. */
  hasSource?: boolean;
  /** Optional extra handles (e.g. true/false branches) rendered by the caller. */
  extraHandles?: ReactNode;
  minWidth?: number;
};

const STATUS_TONE: Record<string, string> = {
  completed: "border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "border-red-500/60 bg-red-500/10 text-red-700 dark:text-red-300",
  skipped: "border-slate-400/50 bg-slate-400/10 text-slate-600 dark:text-slate-300",
  cancelled: "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  running: "border-sky-500/60 bg-sky-500/10 text-sky-700 dark:text-sky-300",
};

function fmtMs(ms?: number): string {
  if (!Number.isFinite(ms) || ms == null) return "";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/**
 * Shared modern workflow-node shell: rounded card, tinted header with an icon
 * chip, soft shadow, and an accent ring when selected. All node components
 * render through this so the canvas looks consistent.
 */
export function BaseNode({
  accent,
  icon,
  label,
  selected,
  disabled,
  runStatus,
  runDurationMs,
  children,
  hasTarget = true,
  hasSource = true,
  extraHandles,
  minWidth = 190,
}: BaseNodeProps) {
  const tone = ACCENT[accent];
  const statusTone = runStatus ? STATUS_TONE[runStatus] : null;
  return (
    <div
      style={{ minWidth, opacity: disabled ? 0.55 : 1 }}
      className={cn(
        "relative rounded-xl border bg-card shadow-sm transition-all",
        selected ? cn("shadow-lg", tone.ring) : "border-border hover:border-foreground/25",
        disabled ? "ring-1 ring-dashed ring-muted-foreground/30" : "",
      )}
    >
      <div className={cn("flex items-center gap-2 rounded-t-xl px-2.5 py-1.5", tone.header)}>
        <div className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white", tone.chip)}>
          {icon}
        </div>
        <span className={cn("truncate text-sm font-semibold text-foreground", disabled ? "line-through" : "")}>{label}</span>
        {disabled ? (
          <span
            className="ml-auto rounded-full border border-muted-foreground/40 bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
            title="Disabled — skipped at runtime"
          >
            off
          </span>
        ) : null}
      </div>
      {children ? (
        <div className="px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">{children}</div>
      ) : (
        <div className="h-1.5" />
      )}
      {statusTone ? (
        <div className={cn("flex items-center justify-between gap-2 border-t px-2.5 py-1 text-[10px] font-medium", statusTone)}>
          <span className="uppercase tracking-wider">
            {runStatus === "completed" ? "✓ done" : runStatus === "failed" ? "✗ failed" : runStatus === "skipped" ? "skipped" : runStatus === "cancelled" ? "cancelled" : "running…"}
          </span>
          {runStatus !== "skipped" && runStatus !== "running" && Number.isFinite(runDurationMs) ? (
            <span className="opacity-80" title={Number(runDurationMs) >= 3000 ? "Slow node" : undefined}>
              {Number(runDurationMs) >= 3000 ? "🕑 " : ""}{fmtMs(runDurationMs)}
            </span>
          ) : null}
        </div>
      ) : null}
      {hasTarget ? <Handle type="target" position={Position.Left} /> : null}
      {hasSource ? <Handle type="source" position={Position.Right} /> : null}
      {extraHandles}
    </div>
  );
}
