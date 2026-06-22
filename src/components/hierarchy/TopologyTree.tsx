"use client";

import React, { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShapeAvatar } from "@/components/agents/shape-avatar";
import { Download } from "lucide-react";
import { generateOrgChartSvg, ORG_CHART_STYLES, type OrgChartAgent } from "@/components/hierarchy/org-chart-svg";

type AgentRoleType = "orchestrator" | "operations" | "specialist" | "worker" | "support";

type AgentRole = {
  agentId: string;
  agentName: string;
  agentActive: boolean;
  isDefault: boolean;
  roleType: AgentRoleType;
  roleTitle: string;
  roleDescription: string;
  reportsTo: string | null;
  capabilities: string[];
  voteWeight: number;
};

type AgentWorkload = {
  assignedTasks: number;
  activeTasks: number;
  inProgressTasks: number;
  reviewTasks: number;
  workflows: number;
  scheduledWorkflows: number;
  liveSchedules: number;
  runningNow: boolean;
  heartbeatStatus: "running" | "scheduled" | "recent" | "idle" | "inactive";
  lastRunAt: string | null;
  lastRunStatus: string | null;
  failedWorkflowId: string | null;
  failedWorkflowName: string | null;
};

type AgentBudgetSummary = {
  spendCapUsd: number | null;
  spendWindowDays: number;
  budgetAction: "warn" | "block";
  spentUsd: number;
  remainingUsd: number | null;
  usagePercent: number | null;
  recentCalls: number;
  lastSpendAt: string | null;
  overCap: boolean;
  warningLevel: "ok" | "near" | "over";
};

type AgentSettingsRecord = {
  id: string;
  isActive: boolean;
  enabledExtensions: string[];
  enabledSkills: string[];
  budgetSummary?: AgentBudgetSummary | null;
  modelRef?: string | null;
};

type BoardTaskRender = {
  updatedAt?: string;
  assignedAgentId?: string | null;
};

const ROLE_TYPE_LABELS: Record<string, string> = {
  orchestrator: "Orchestrator",
  operations: "Operations Lead",
  specialist: "Specialist",
  worker: "Worker",
  support: "Support",
};

const ROLE_TYPE_ORDER: Record<AgentRoleType, number> = {
  orchestrator: 0,
  operations: 1,
  specialist: 2,
  worker: 3,
  support: 4,
};

const ROLE_EMOJI: Record<string, string> = {
  ceo: "👑",
  orchestrator: "🎯",
  coordinator: "🔗",
  analyst: "🔍",
  executor: "⚡",
  reviewer: "👁️",
  specialist: "💎",
  worker: "🔧",
  researcher: "🔬",
  assistant: "🤖",
  default: "👤",
};

function getRoleEmoji(role?: string): string {
  if (!role) return ROLE_EMOJI.default;
  const normalized = role.toLowerCase();
  for (const [key, emoji] of Object.entries(ROLE_EMOJI)) {
    if (normalized.includes(key)) return emoji;
  }
  return ROLE_EMOJI.default;
}

function sortRolesForTree(items: AgentRole[]): AgentRole[] {
  return [...items].sort((left, right) => {
    const byRole = ROLE_TYPE_ORDER[left.roleType] - ROLE_TYPE_ORDER[right.roleType];
    if (byRole !== 0) return byRole;
    return left.agentName.localeCompare(right.agentName);
  });
}

export type TopologyTreeProps = {
  roles: AgentRole[];
  orchestrator: AgentRole | null;
  rootTreeRoles: AgentRole[];
  unlinkedRoles: AgentRole[];
  expandedNodeId: string | null;
  treeSearch: string;
  showAllTreeAgents: boolean;
  treeScale: number;
  treeOffset: { x: number; y: number };
  treePanning: boolean;
  loading: boolean;
  treeStageRef: React.Ref<HTMLDivElement>;
  agentSettings: Record<string, AgentSettingsRecord>;
  workloadByAgent: Record<string, AgentWorkload>;
  directReportsCount: Map<string, number>;
  childrenByParent: Map<string, AgentRole[]>;
  runtimeTasks: BoardTaskRender[];
  collapseThreshold?: number;
  onSearchChange: (value: string) => void;
  onShowAll: () => void;
  onExpandNode: (agentId: string | null) => void;
  onTreePointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onTreePointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onFinishTreePointer: (e: React.PointerEvent<HTMLDivElement>) => void;
  onTreeWheel: (e: React.WheelEvent<HTMLDivElement>) => void;
  onAdjustScale: (delta: number) => void;
  onResetViewport: () => void;
};

export function TopologyTree({
  roles,
  orchestrator,
  rootTreeRoles,
  unlinkedRoles,
  expandedNodeId,
  treeSearch,
  showAllTreeAgents,
  treeScale,
  treeOffset,
  treePanning,
  loading,
  treeStageRef,
  agentSettings,
  workloadByAgent,
  directReportsCount,
  childrenByParent,
  runtimeTasks,
  collapseThreshold = 15,
  onSearchChange,
  onShowAll,
  onExpandNode,
  onTreePointerDown,
  onTreePointerMove,
  onFinishTreePointer,
  onTreeWheel,
  onAdjustScale,
  onResetViewport,
}: TopologyTreeProps) {
  const [exportingSvg, setExportingSvg] = useState(false);
  const [svgStyle, setSvgStyle] = useState("monochrome");

  const exportOrgChartAsSvg = () => {
    setExportingSvg(true);
    try {
      const svgAgents: OrgChartAgent[] = roles.map((r) => ({
        name: r.agentName,
        role: r.roleTitle || r.roleType,
        reportsTo: r.reportsTo,
        id: r.agentId,
      }));
      const svg = generateOrgChartSvg(svgAgents, svgStyle);
      const blob = new Blob([svg], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `org-chart-${new Date().toISOString().slice(0, 10)}.svg`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExportingSvg(false);
    }
  };

  const filteredAgents = React.useMemo(() => {
    if (!treeSearch.trim()) return roles;
    const q = treeSearch.toLowerCase();
    return roles.filter(
      (a) =>
        a.agentName?.toLowerCase().includes(q) ||
        a.roleTitle?.toLowerCase().includes(q) ||
        a.roleType?.toLowerCase().includes(q) ||
        a.agentId?.toLowerCase().includes(q),
    );
  }, [roles, treeSearch]);

  const getHeartbeatDot = (role: AgentRole) => {
    const budget = agentSettings[role.agentId]?.budgetSummary ?? null;
    const isBudgetBlocked = Boolean(budget?.overCap && budget?.budgetAction === "block");
    const workload = workloadByAgent[role.agentId];
    if (isBudgetBlocked) return "bg-terminal-red pulse-red";
    if (!workload) return "bg-muted-foreground/40";
    if (workload.heartbeatStatus === "running") return "bg-green-400 animate-pulse";
    if (workload.heartbeatStatus === "scheduled") return "bg-yellow-400";
    if (workload.heartbeatStatus === "recent") return "bg-green-400/60";
    if (workload.heartbeatStatus === "inactive") return "bg-terminal-red/60";
    return "bg-muted-foreground/40";
  };

  const renderTreeNode = (role: AgentRole, isRoot: boolean = false) => {
    const workload = workloadByAgent[role.agentId] ?? {
      assignedTasks: 0, activeTasks: 0, inProgressTasks: 0, reviewTasks: 0,
      workflows: 0, scheduledWorkflows: 0, liveSchedules: 0, runningNow: false,
      heartbeatStatus: role.agentActive ? ("idle" as const) : ("inactive" as const),
      lastRunAt: null, lastRunStatus: null, failedWorkflowId: null, failedWorkflowName: null,
    };
    const budget = agentSettings[role.agentId]?.budgetSummary ?? null;
    const isBudgetBlocked = Boolean(budget?.overCap && budget?.budgetAction === "block");
    const directReports = directReportsCount.get(role.agentId) ?? 0;
    const isExpanded = expandedNodeId === role.agentId;
    const modelRef = agentSettings[role.agentId]?.modelRef ?? null;
    const modelLabel = modelRef
      ? modelRef.replace(/^claude-/, "").replace(/^gemini-/, "gemini:").replace(/^gpt-/, "gpt:").split("-")[0]
      : null;

    return (
      <div
        key={`tree-${role.agentId}`}
        data-tree-node="true"
        data-agent-id={role.agentId}
        className={`cursor-pointer border transition-all hover:border-terminal-red ${
          isRoot ? "border-terminal-red/50 bg-terminal-red/5" : "border-border bg-card"
        } ${isExpanded ? "ring-1 ring-terminal-red/30" : ""}`}
        style={{ minWidth: 160, maxWidth: 240 }}
        onClick={() => onExpandNode(isExpanded ? null : role.agentId)}
      >
        <div className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <ShapeAvatar seed={role.agentId} size={28} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold" title={role.agentName}>
                <span className="mr-1">{getRoleEmoji(role.roleTitle || role.roleType)}</span>
                {role.agentName}
              </div>
              <div className="truncate text-[10px] text-muted-foreground" title={role.roleTitle || "No title"}>
                {role.roleTitle || "No title"}
              </div>
            </div>
            <span className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${getHeartbeatDot(role)}`} />
          </div>
          <div className="flex flex-wrap gap-1 mt-2">
            <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border border-terminal-red/30 text-terminal-red/80">
              {ROLE_TYPE_LABELS[role.roleType] || role.roleType}
            </span>
            {modelLabel && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border border-blue-500/30 text-blue-400/80">
                {modelLabel}
              </span>
            )}
            {directReports > 0 && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border border-border text-muted-foreground">
                {directReports} reports
              </span>
            )}
            {workload.activeTasks > 0 && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border border-border text-muted-foreground">
                {workload.activeTasks} tasks
              </span>
            )}
            {isBudgetBlocked && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border border-terminal-red text-terminal-red">
                BLOCKED
              </span>
            )}
          </div>
          {(() => {
            const agentTasks = (runtimeTasks ?? []).filter((t) => t.assignedAgentId === role.agentId);
            if (agentTasks.length === 0) return null;
            const days = 7;
            const now = Date.now();
            const buckets = Array.from({ length: days }, (_, i) => {
              const dayStart = now - (days - i) * 86_400_000;
              const dayEnd = dayStart + 86_400_000;
              return agentTasks.filter((t) => {
                const ts = new Date(t.updatedAt || now).getTime();
                return ts >= dayStart && ts < dayEnd;
              }).length;
            });
            const max = Math.max(1, ...buckets);
            const w = 40;
            const h = 14;
            const bw = w / days;
            return (
              <div className="mt-1.5 px-0.5">
                <svg width={w} height={h} className="opacity-50">
                  {buckets.map((count, i) => {
                    const barH = (count / max) * (h - 2);
                    return (
                      <rect
                        key={i}
                        x={i * bw + 0.5}
                        y={h - barH - 1}
                        width={bw - 1}
                        height={Math.max(1, barH)}
                        fill="hsl(var(--terminal-red))"
                        opacity={count > 0 ? 0.7 : 0.15}
                      />
                    );
                  })}
                </svg>
              </div>
            );
          })()}
        </div>
      </div>
    );
  };

  const renderOrgBranch = (
    role: AgentRole,
    isRoot: boolean = false,
    ancestry: Set<string> = new Set(),
  ) => {
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(role.agentId);
    const children = (childrenByParent.get(role.agentId) ?? []).filter(
      (child) => child.agentId !== role.agentId,
    );
    return (
      <li key={`branch-${role.agentId}`} className={role.agentActive ? "active-connector" : ""}>
        {renderTreeNode(role, isRoot)}
        {children.length > 0 ? (
          <ul className="has-connector">
            {children.map((child) =>
              nextAncestry.has(child.agentId) ? (
                <li key={`cycle-${role.agentId}-${child.agentId}`}>
                  <div className="rounded border border-dashed border-terminal-red/40 bg-terminal-red/5 px-3 py-2 text-[11px] text-muted-foreground">
                    Cycle blocked: {child.agentName}
                  </div>
                </li>
              ) : (
                renderOrgBranch(child, false, nextAncestry)
              ),
            )}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="mb-5 border border-border bg-card/50 p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            TEAM TOPOLOGY
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Drag to pan, use the mouse wheel to zoom, and click an agent node for the full governance card.
          </p>
        </div>
        <div data-tree-ignore-pan="true" className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground">
            {roles.length > collapseThreshold ? `${roles.length} agents` : ""}
          </span>
          <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wide">
            {Math.round(treeScale * 100)}%
          </Badge>
          <Button size="sm" variant="outline" onClick={() => onAdjustScale(-0.08)}>
            Zoom Out
          </Button>
          <Button size="sm" variant="outline" onClick={() => onAdjustScale(0.08)}>
            Zoom In
          </Button>
          <Button size="sm" variant="ghost" onClick={onResetViewport}>
            Reset View
          </Button>
          <select
            value={svgStyle}
            onChange={(e) => setSvgStyle(e.target.value)}
            className="h-7 rounded-md border bg-background px-2 text-xs"
          >
            {Object.entries(ORG_CHART_STYLES).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={exportOrgChartAsSvg}
            disabled={exportingSvg}
          >
            <Download className="mr-1 h-3.5 w-3.5" />
            {exportingSvg ? "Exporting..." : "Export SVG"}
          </Button>
        </div>
      </div>

      {/* Search bar */}
      <div data-tree-ignore-pan="true" className="mb-3">
        <input
          type="text"
          value={treeSearch}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search agents by name, role..."
          className="w-full rounded-md border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading hierarchy...</p>
      ) : !orchestrator ? (
        <p className="text-sm text-muted-foreground">No agents available.</p>
      ) : treeSearch.trim() ? (
        <div className="flex flex-wrap justify-center gap-3 p-4">
          {filteredAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No agents match &quot;{treeSearch}&quot;.
            </p>
          ) : (
            filteredAgents.map((role) => renderTreeNode(role))
          )}
        </div>
      ) : roles.length > collapseThreshold && !showAllTreeAgents ? (
        <div className="space-y-3">
          <div className="flex flex-wrap justify-center gap-3 p-4">
            {roles.slice(0, 10).map((role) => renderTreeNode(role))}
          </div>
          <div className="flex justify-center">
            <Button size="sm" variant="outline" onClick={onShowAll} className="text-xs">
              +{roles.length - 10} more... Show All
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={`rounded-xl border border-border/70 bg-background/40 overflow-auto ${treePanning ? "cursor-grabbing" : "cursor-grab"}`}
          style={{ touchAction: "none" }}
          onPointerDown={onTreePointerDown}
          onPointerMove={onTreePointerMove}
          onPointerUp={onFinishTreePointer}
          onPointerCancel={onFinishTreePointer}
          onWheel={onTreeWheel}
        >
          <div
            ref={treeStageRef}
            data-testid="hierarchy-tree-stage"
            className="relative flex min-h-[420px] min-w-max justify-center p-6"
            style={{
              transform: `translate(${treeOffset.x}px, ${treeOffset.y}px) scale(${treeScale})`,
              transformOrigin: "top center",
              transition: treePanning ? "none" : "transform 120ms ease-out",
            }}
          >
            <div className="org-tree min-w-max">
              <style>{`
                .org-tree { --connector-color: hsl(var(--border)); --connector-active: hsl(var(--terminal-red)); }
                .org-tree ul { display: flex; justify-content: center; padding: 0; margin: 0; list-style: none; position: relative; }
                .org-tree ul::before { content: ''; position: absolute; top: 0; left: 50%; border-left: 2px solid var(--connector-color); height: 20px; }
                .org-tree > ul::before { display: none; }
                .org-tree li { position: relative; padding: 20px 8px 0 8px; display: flex; flex-direction: column; align-items: center; }
                .org-tree li::before, .org-tree li::after { content: ''; position: absolute; top: 0; width: 50%; height: 20px; border-top: 2px solid var(--connector-color); }
                .org-tree li::before { right: 50%; border-right: 2px solid var(--connector-color); }
                .org-tree li::after { left: 50%; border-left: 2px solid var(--connector-color); }
                .org-tree li:first-child::before { border: 0 none; }
                .org-tree li:last-child::after { border: 0 none; }
                .org-tree li:only-child::before, .org-tree li:only-child::after { display: none; }
                .org-tree li:only-child { padding-top: 20px; }
                .org-tree > ul > li { padding-top: 0; }
                .org-tree > ul > li::before, .org-tree > ul > li::after { display: none; }
                .org-tree li.active-connector::before { border-color: var(--connector-active); }
                .org-tree li.active-connector::after { border-color: var(--connector-active); }
                .org-tree ul.has-connector::before { border-color: var(--connector-color); }
              `}</style>

              <ul>
                {rootTreeRoles.map((role) =>
                  renderOrgBranch(role, role.agentId === orchestrator?.agentId),
                )}
              </ul>

              {unlinkedRoles.length > 0 ? (
                <div className="mt-6 border-t border-dashed border-border pt-4">
                  <div className="mb-3 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    UNLINKED AGENTS
                  </div>
                  <div className="flex flex-wrap justify-center gap-3">
                    {sortRolesForTree(unlinkedRoles).map((role) => renderTreeNode(role))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
