"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";

type GoalStatus = "planned" | "active" | "blocked" | "done";
type GoalLevel = "vision" | "mission" | "objective" | "key_result";

type HierarchyGoal = {
  id: string;
  name: string;
  description: string | null;
  organizationId: string | null;
  organizationName: string | null;
  parentGoalId: string | null;
  parentGoalName: string | null;
  linkedDocumentIds: string[];
  deliverables: string[];
  status: GoalStatus;
  level: GoalLevel | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type GoalSpendSummary = {
  goalId: string;
  totalCostUsd: number;
  totalTokens: number;
  eventCount: number;
  agentBreakdown: Array<{ agentId: string; costUsd: number; tokens: number; calls: number }>;
  lastSpendAt: string | null;
};

type BoardTask = {
  id: string;
  status: "inbox" | "in_progress" | "review" | "done" | "blocked";
  goalId?: string | null;
  blockedBy?: string[];
};

type GoalHealthLabel = "blocked" | "stale" | "near-done" | "active";

export type GoalTreeProps = {
  goals: HierarchyGoal[];
  selectedGoalId: string;
  collapsedGoalIds: Set<string>;
  childGoalsByParent: Map<string, HierarchyGoal[]>;
  goalsById: Map<string, HierarchyGoal>;
  goalSpendMap: Record<string, GoalSpendSummary>;
  runtimeTasks: BoardTask[];
  onSelectGoal: (goalId: string) => void;
  onToggleCollapse: (goalId: string) => void;
};

function getGoalHealthLabel(
  goal: HierarchyGoal,
  runtimeTasks: BoardTask[],
): { label: GoalHealthLabel; color: string } | null {
  const goalTasks = runtimeTasks.filter((t) => t.goalId === goal.id);
  if (goalTasks.length === 0) return null;
  const done = goalTasks.filter((t) => t.status === "done").length;
  const blocked = goalTasks.filter((t) => t.status === "blocked").length;
  const ratio = done / goalTasks.length;
  const daysSince = Math.floor(
    (Date.now() - new Date(goal.updatedAt).getTime()) / 86_400_000,
  );
  const isStale = daysSince > 7 && ratio < 0.5;
  if (blocked > 0) return { label: "blocked", color: "border-terminal-red/60 text-terminal-red/80" };
  if (isStale) return { label: "stale", color: "border-yellow-500/50 text-yellow-400/80" };
  if (ratio >= 0.8) return { label: "near-done", color: "border-green-500/50 text-green-400" };
  return { label: "active", color: "border-border text-muted-foreground" };
}

export function GoalTree({
  goals,
  selectedGoalId,
  collapsedGoalIds,
  childGoalsByParent,
  goalsById,
  goalSpendMap,
  runtimeTasks,
  onSelectGoal,
  onToggleCollapse,
}: GoalTreeProps) {
  const rootGoals = goals.filter(
    (g) => !g.parentGoalId || !goalsById.has(g.parentGoalId),
  );

  const renderGoalRow = (goal: HierarchyGoal, depth: number): React.ReactNode => {
    const children = childGoalsByParent.get(goal.id) ?? [];
    const hasChildren = children.length > 0;
    const isCollapsed = collapsedGoalIds.has(goal.id);
    const isSelected = goal.id === selectedGoalId;
    const health = getGoalHealthLabel(goal, runtimeTasks);

    return (
      <div key={goal.id}>
        <div
          style={{ paddingLeft: depth * 16 }}
          className={`flex items-start gap-1 rounded border transition-colors ${
            isSelected
              ? "border-terminal-red bg-terminal-red/5"
              : "border-transparent hover:border-terminal-red/30"
          }`}
        >
          <button
            type="button"
            className="mt-2 shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={() => onToggleCollapse(goal.id)}
          >
            {hasChildren ? (isCollapsed ? "▶" : "▼") : "·"}
          </button>
          <button
            type="button"
            className="flex-1 p-2 text-left"
            onClick={() => onSelectGoal(goal.id)}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium">{goal.name}</span>
              <Badge
                variant="outline"
                className={`text-[10px] font-mono uppercase tracking-wide ${
                  goal.status === "active"
                    ? "border-green-500/50 text-green-400"
                    : goal.status === "blocked"
                      ? "border-terminal-red text-terminal-red"
                      : goal.status === "done"
                        ? "border-muted text-muted-foreground"
                        : "border-yellow-500/50 text-yellow-400"
                }`}
              >
                {goal.status}
              </Badge>
              {goal.level && (
                <Badge
                  variant="outline"
                  className="text-[10px] font-mono uppercase border-blue-500/30 text-blue-400/80"
                >
                  {goal.level.replace("_", " ")}
                </Badge>
              )}
              {hasChildren && (
                <Badge variant="secondary" className="text-[10px]">
                  {children.length} sub
                </Badge>
              )}
              {health && (
                <Badge
                  variant="outline"
                  className={`text-[9px] font-mono ${health.color}`}
                >
                  {health.label}
                </Badge>
              )}
              {goalSpendMap[goal.id] && (
                <Badge
                  variant="outline"
                  className="text-[9px] font-mono border-purple-500/30 text-purple-400/80"
                  title={`${goalSpendMap[goal.id]!.totalTokens.toLocaleString()} tokens`}
                >
                  ${goalSpendMap[goal.id]!.totalCostUsd.toFixed(3)}
                </Badge>
              )}
            </div>
            {goal.description ? (
              <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                {goal.description}
              </p>
            ) : null}
          </button>
        </div>
        {hasChildren &&
          !isCollapsed &&
          children.map((child) => renderGoalRow(child, depth + 1))}
      </div>
    );
  };

  if (rootGoals.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No goals for the active organization yet.
      </p>
    );
  }

  return <>{rootGoals.map((g) => renderGoalRow(g, 0))}</>;
}
