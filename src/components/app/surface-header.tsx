"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type SurfaceHeaderStatusItem = {
  label: string;
  value: string | number;
  tone?: "default" | "ok" | "warn" | "danger";
};

const TONE_CLASS: Record<NonNullable<SurfaceHeaderStatusItem["tone"]>, string> = {
  default: "border-border text-muted-foreground",
  ok: "border-emerald-500/40 text-emerald-300",
  warn: "border-amber-500/40 text-amber-300",
  danger: "border-red-500/40 text-red-300",
};

export function SurfaceHeader({
  title,
  subtitle,
  statusItems = [],
  primaryAction,
  secondaryActions,
  className,
}: {
  title: string;
  subtitle?: string;
  statusItems?: SurfaceHeaderStatusItem[];
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 border-b border-border/70 pb-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
          {statusItems.slice(0, 5).map((item) => (
            <Badge
              key={`${item.label}:${item.value}`}
              variant="outline"
              className={cn("h-6 gap-1 text-[10px]", TONE_CLASS[item.tone ?? "default"])}
              title={`${item.label}: ${item.value}`}
            >
              <span className="text-muted-foreground">{item.label}</span>
              <span>{item.value}</span>
            </Badge>
          ))}
        </div>
        {subtitle ? <p className="max-w-3xl text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {(primaryAction || secondaryActions) ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {secondaryActions}
          {primaryAction}
        </div>
      ) : null}
    </div>
  );
}

