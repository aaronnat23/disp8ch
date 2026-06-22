"use client";

import React from "react";

type OrgHealth = {
  activeAgents: number;
  inactiveAgents: number;
  unlinkedAgents: number;
  managersWithoutReports: number;
  noCapabilities: number;
  largestSpan: number;
  maxDepth: number;
  budgetBlockedAgents: number;
};

type WorkloadSummary = {
  assignedTasks: number;
  activeTasks: number;
  workflows: number;
  liveSchedules: number;
};

type RoleSummaryItem = { label: string; value: number };

export type OrgStatsProps = {
  orgHealth: OrgHealth;
  workloadSummary: WorkloadSummary;
  collapsed: boolean;
  onToggle: () => void;
  /** Role composition counts — folded into the same expandable detail panel. */
  roleSummary?: RoleSummaryItem[];
};

/**
 * Compact org summary.
 *
 * Default view is a single slim strip with only the headline numbers
 * (agents / tasks / flows / schedules). The full health breakdown — span,
 * depth, unlinked, blocked, role composition, etc. — is hidden behind a
 * "Details" toggle so a fresh empty org doesn't show a wall of zeros.
 */
export function OrgStats({ orgHealth, workloadSummary, collapsed, onToggle, roleSummary = [] }: OrgStatsProps) {
  const totalAgents = orgHealth.activeAgents + orgHealth.inactiveAgents;

  // Headline pills — always visible.
  const headline: Array<{ label: string; value: string; tone?: "warn" }> = [
    { label: "Agents", value: `${orgHealth.activeAgents}/${totalAgents}` },
    { label: "Tasks", value: `${workloadSummary.activeTasks} active` },
    { label: "Flows", value: String(workloadSummary.workflows) },
    { label: "Schedules", value: String(workloadSummary.liveSchedules) },
  ];

  // Detail stats — only the ones worth surfacing. Warn-toned when non-zero.
  const detail: Array<{ label: string; value: number; warn?: boolean }> = [
    { label: "Inactive", value: orgHealth.inactiveAgents },
    { label: "Unlinked", value: orgHealth.unlinkedAgents, warn: orgHealth.unlinkedAgents > 0 },
    { label: "No manager", value: orgHealth.managersWithoutReports, warn: orgHealth.managersWithoutReports > 0 },
    { label: "No capabilities", value: orgHealth.noCapabilities, warn: orgHealth.noCapabilities > 0 },
    { label: "Budget blocked", value: orgHealth.budgetBlockedAgents, warn: orgHealth.budgetBlockedAgents > 0 },
    { label: "Max span", value: orgHealth.largestSpan },
    { label: "Depth", value: orgHealth.maxDepth },
    { label: "Assigned tasks", value: workloadSummary.assignedTasks },
  ];

  const warnings = detail.filter((d) => d.warn).length;

  return (
    <div className="mb-3 border border-border bg-card">
      {/* Slim always-visible summary strip */}
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        {headline.map((h) => (
          <span
            key={h.label}
            className="inline-flex items-baseline gap-1.5 text-[11px] font-mono"
          >
            <span className="uppercase tracking-wider text-muted-foreground">{h.label}</span>
            <span className="font-semibold tabular-nums text-foreground">{h.value}</span>
          </span>
        ))}
        {warnings > 0 ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-terminal-red">
            <span className="h-1.5 w-1.5 rounded-full bg-terminal-red" />
            {warnings} to review
          </span>
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          className="ml-auto text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-terminal-red transition-colors"
        >
          {collapsed ? "Details" : "Hide details"}
        </button>
      </div>

      {/* Expandable detail panel — full health + composition */}
      {!collapsed && (
        <div className="border-t border-border px-3 py-3 space-y-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
            {detail.map((d) => (
              <div key={d.label} className="flex items-baseline justify-between gap-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground truncate">
                  {d.label}
                </span>
                <span
                  className={`text-sm font-semibold tabular-nums ${
                    d.warn ? "text-terminal-red" : "text-foreground"
                  }`}
                >
                  {d.value}
                </span>
              </div>
            ))}
          </div>
          {roleSummary.length > 0 && (
            <div className="border-t border-border/60 pt-2.5">
              <div className="mb-1.5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Composition
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {roleSummary.map((item) => (
                  <span
                    key={item.label}
                    className="inline-flex items-center gap-1 border border-border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground"
                  >
                    {item.label}
                    <span className="font-semibold text-foreground">{item.value}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
