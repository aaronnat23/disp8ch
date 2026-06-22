"use client";

import { useState } from "react";
import { CheckCircle2, Circle, ListChecks } from "lucide-react";

export function LivePlanPanel({
  steps,
}: {
  steps: Array<{ id: string; content: string; isDone: boolean; updatedAt: string }>;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const activeSteps = steps.filter((s) => !s.isDone);
  const completedSteps = steps.filter((s) => s.isDone);
  const recentCompleted = completedSteps.filter(
    (s) => Date.now() - new Date(s.updatedAt).getTime() < 30000,
  );
  const visible = [...activeSteps, ...recentCompleted];

  if (visible.length === 0) return null;

  const doneCount = completedSteps.length;
  const totalCount = steps.length;

  return (
    <div className="mx-4 mt-2 rounded-md border bg-background/70">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/50"
      >
        <ListChecks className="h-3.5 w-3.5" />
        Plan ({doneCount}/{totalCount} done)
        <span className="ml-auto text-muted-foreground">
          {collapsed ? "\u25B8" : "\u25BE"}
        </span>
      </button>
      {!collapsed ? (
        <div className="border-t px-3 py-2 space-y-1">
          {visible.map((step) => (
            <div
              key={step.id}
              className="flex items-center gap-2 rounded px-2 py-1 text-xs"
            >
              {step.isDone ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <Circle className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span
                className={
                  step.isDone
                    ? "text-muted-foreground line-through"
                    : "text-foreground"
                }
              >
                {step.content}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
