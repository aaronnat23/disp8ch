"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

type LinkedDocumentSummary = {
  id: string;
  sourceType: string;
  name: string;
  mimeType: string | null;
  sourceUrl: string | null;
  sizeBytes: number | null;
  excerpt: string;
  createdAt: string;
  updatedAt?: string;
};

type GoalSourcePackItem = {
  key: string;
  sourceType: string | null;
  sourceRef: string | null;
  label: string;
  taskCount: number;
  workflowCount: number;
  document: LinkedDocumentSummary | null;
};

type AgentRole = {
  agentId: string;
  agentName: string;
  agentActive: boolean;
  roleType: string;
};

type WorkObjectSummary = {
  id: string;
  title: string;
  status: string;
  priority: string;
  ownerAgentId: string | null;
  linkedTaskIds: string[];
  linkedWorkflowIds: string[];
  linkedDocumentIds: string[];
  blockers: string[];
  riskLevel: string;
};

type ProjectSummary = {
  id: string;
  name: string;
  status: string;
  primaryWorkspaceId: string | null;
};

export type GoalDrilldownProps = {
  goalFocus: HierarchyGoal;
  selectedGoalId: string;
  activeOrganizationId: string;
  childGoalsByParent: Map<string, HierarchyGoal[]>;
  linkedDocumentsById: Record<string, LinkedDocumentSummary | null>;
  goalSourcePackItems: GoalSourcePackItem[];
  inlineEditGoal: { id: string; field: "name" | "description"; value: string } | null;
  inlineEditSaving: boolean;
  updatingGoalField: string | null;
  assignAllOpen: boolean;
  assignAllTitle: string;
  assignAllDesc: string;
  assignAllPriority: "low" | "medium" | "high";
  assignAllSaving: boolean;
  assignAllProgress: number;
  assignAllResult: { created: number; total: number; agentNames: string[] } | null;
  roles: AgentRole[];
  goalsSectionRef: React.RefObject<HTMLDivElement | null>;
  onSelectGoal: (goalId: string) => void;
  onUpdateGoalField: (goalId: string, field: string, value: string) => void;
  onStartInlineEdit: (id: string, field: "name" | "description", value: string) => void;
  onSaveInlineEdit: () => void;
  onCancelInlineEdit: () => void;
  onToggleAssignAll: () => void;
  onAssignAllTitleChange: (title: string) => void;
  onAssignAllDescChange: (desc: string) => void;
  onAssignAllPriorityChange: (p: "low" | "medium" | "high") => void;
  onAssignGoalToAllAgents: () => void;
};

function formatSourceSize(size: number | null): string {
  if (!size || size < 0) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function GoalDrilldown({
  goalFocus,
  selectedGoalId,
  activeOrganizationId,
  childGoalsByParent,
  linkedDocumentsById,
  goalSourcePackItems,
  inlineEditGoal,
  inlineEditSaving,
  updatingGoalField,
  assignAllOpen,
  assignAllTitle,
  assignAllDesc,
  assignAllPriority,
  assignAllSaving,
  assignAllProgress,
  assignAllResult,
  roles,
  goalsSectionRef,
  onSelectGoal,
  onUpdateGoalField,
  onStartInlineEdit,
  onSaveInlineEdit,
  onCancelInlineEdit,
  onToggleAssignAll,
  onAssignAllTitleChange,
  onAssignAllDescChange,
  onAssignAllPriorityChange,
  onAssignGoalToAllAgents,
}: GoalDrilldownProps) {
  const router = useRouter();
  const [workObject, setWorkObject] = useState<WorkObjectSummary | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/hierarchy/work-objects?rootGoalId=${encodeURIComponent(goalFocus.id)}`)
      .then((response) => response.json())
      .then((json) => {
        if (!cancelled) setWorkObject(json?.success ? (json.data as WorkObjectSummary | null) : null);
      })
      .catch(() => {
        if (!cancelled) setWorkObject(null);
      });
    fetch(`/api/hierarchy/projects?goalId=${encodeURIComponent(goalFocus.id)}&includeDone=true`)
      .then((response) => response.json())
      .then((json) => {
        if (!cancelled) setProjects(json?.success ? (json.data as ProjectSummary[]) : []);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [goalFocus.id]);

  const subGoals = childGoalsByParent.get(goalFocus.id) ?? [];
  const displayedDocuments = goalFocus.linkedDocumentIds
    .map((id) => linkedDocumentsById[id] ?? null)
    .filter(Boolean) as LinkedDocumentSummary[];

  return (
    <div className="mb-5 border border-terminal-red/30 bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Goal Focus
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            The selected goal drilldown stays pinned here so deep links and large org trees do not hide it below the topology canvas.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="border-terminal-red/40 text-terminal-red hover:bg-terminal-red/10"
            onClick={onToggleAssignAll}
          >
            {assignAllOpen ? "Cancel" : "Assign to All Agents"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const params = new URLSearchParams();
              params.set("topic", `What should the team decide next for goal: ${goalFocus.name}?`);
              if (goalFocus.organizationId ?? activeOrganizationId) params.set("org", goalFocus.organizationId ?? activeOrganizationId);
              if (goalFocus.id) params.set("goal", goalFocus.id);
              router.push(`/council?${params.toString()}`);
            }}
          >
            Start Council Vote
          </Button>
          <span className="h-5 w-px bg-border/60" aria-hidden />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const params = new URLSearchParams();
              if (goalFocus.organizationId ?? activeOrganizationId) params.set("org", goalFocus.organizationId ?? activeOrganizationId);
              if (goalFocus.id) params.set("goal", goalFocus.id);
              router.push(`/boards?${params.toString()}`);
            }}
          >
            View in Boards
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const params = new URLSearchParams();
              if (goalFocus.organizationId ?? activeOrganizationId) params.set("org", goalFocus.organizationId ?? activeOrganizationId);
              if (goalFocus.id) params.set("goal", goalFocus.id);
              router.push(`/workflows?${params.toString()}`);
            }}
          >
            View in Workflows
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => router.push(`/hierarchy/goal/${goalFocus.id}`)}
          >
            Open Detail
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => goalsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            Goals Panel
          </Button>
        </div>
      </div>

      <div className="mb-4 grid gap-3 lg:grid-cols-[1.2fr_1fr]">
        <div className="rounded-lg border border-border/70 bg-background/60 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Work Object
              </div>
              <div className="text-xs text-muted-foreground">
                Canonical owner for linked tasks, workflows, documents, blockers, and decisions.
              </div>
            </div>
            {workObject ? <Badge variant="secondary" className="text-[10px]">{workObject.status}</Badge> : null}
          </div>
          {workObject ? (
            <div className="grid gap-2 sm:grid-cols-4">
              <MetricPill label="Tasks" value={workObject.linkedTaskIds.length} />
              <MetricPill label="Workflows" value={workObject.linkedWorkflowIds.length} />
              <MetricPill label="Docs" value={workObject.linkedDocumentIds.length} />
              <MetricPill label="Blockers" value={workObject.blockers.length} warn={workObject.blockers.length > 0} />
              <div className="sm:col-span-4 flex flex-wrap gap-1.5 pt-1">
                <Badge variant="outline" className="text-[10px]">priority: {workObject.priority}</Badge>
                <Badge variant={workObject.riskLevel === "high" ? "destructive" : "outline"} className="text-[10px]">
                  risk: {workObject.riskLevel}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  owner: {roles.find((role) => role.agentId === workObject.ownerAgentId)?.agentName || "unassigned"}
                </Badge>
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              No root work object is linked yet. Newly-created goals are indexed automatically.
            </div>
          )}
        </div>

        <div className="rounded-lg border border-border/70 bg-background/60 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Projects
              </div>
              <div className="text-xs text-muted-foreground">Project/workspace layer under this goal.</div>
            </div>
            <Badge variant="outline" className="text-[10px]">{projects.length}</Badge>
          </div>
          {projects.length > 0 ? (
            <div className="space-y-1.5">
              {projects.slice(0, 4).map((project) => (
                <div key={project.id} className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{project.name}</div>
                    <div className="text-[10px] text-muted-foreground">
                      workspace: {project.primaryWorkspaceId ? "primary set" : "not set"}
                    </div>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">{project.status}</Badge>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              No projects yet. Use the projects API or template flow to separate goals from execution work.
            </div>
          )}
        </div>
      </div>

      {assignAllOpen && (
        <div className="mb-4 rounded-lg border border-terminal-red/30 bg-terminal-red/5 p-4 space-y-3">
          <div className="text-[10px] font-mono uppercase tracking-widest text-terminal-red">
            Assign Goal to All Active Org Members
          </div>
          <p className="text-xs text-muted-foreground">
            Creates one task per active agent in this org, all linked to{" "}
            <span className="font-semibold text-foreground">{goalFocus.name}</span>.
            {" "}{roles.filter((r) => r.agentActive).length} agent(s) will receive a task.
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="space-y-2">
              <Input
                placeholder="Task title (default: Work on: [goal name])"
                value={assignAllTitle}
                onChange={(e) => onAssignAllTitleChange(e.target.value)}
                className="h-8 text-sm"
              />
              <Input
                placeholder="Description (optional)"
                value={assignAllDesc}
                onChange={(e) => onAssignAllDescChange(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="flex flex-col gap-2">
              <select
                className="h-8 rounded border border-border bg-background px-2 text-sm"
                value={assignAllPriority}
                onChange={(e) => onAssignAllPriorityChange(e.target.value as "low" | "medium" | "high")}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
              <Button
                size="sm"
                disabled={assignAllSaving || roles.filter((r) => r.agentActive).length === 0}
                onClick={() => onAssignGoalToAllAgents()}
                className="bg-terminal-red text-white hover:bg-terminal-red/80"
              >
                {assignAllSaving
                  ? `Creating ${assignAllProgress}/${roles.filter((r) => r.agentActive).length}…`
                  : `Create ${roles.filter((r) => r.agentActive).length} Tasks`}
              </Button>
            </div>
          </div>
          {assignAllSaving && (
            <div className="w-full rounded-full bg-terminal-red/10 h-1.5 overflow-hidden">
              <div
                className="h-full bg-terminal-red/60 transition-all duration-200"
                style={{ width: `${Math.round((assignAllProgress / Math.max(roles.filter((r) => r.agentActive).length, 1)) * 100)}%` }}
              />
            </div>
          )}
          {assignAllResult && (
            <div className="space-y-1">
              <p className="text-xs text-green-400">
                Created {assignAllResult.created}/{assignAllResult.total} tasks successfully.
              </p>
              {assignAllResult.agentNames.length > 0 && (
                <p className="text-[10px] text-muted-foreground font-mono">
                  {assignAllResult.agentNames.slice(0, 5).join(", ")}
                  {assignAllResult.agentNames.length > 5 && ` +${assignAllResult.agentNames.length - 5} more`}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="space-y-3 rounded-xl border border-terminal-red/20 bg-background/70 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {inlineEditGoal?.id === goalFocus.id && inlineEditGoal.field === "name" ? (
                <input
                  autoFocus
                  className="text-base font-semibold bg-transparent border-b border-terminal-red/60 outline-none w-full max-w-sm"
                  value={inlineEditGoal.value}
                  disabled={inlineEditSaving}
                  onChange={(e) => onStartInlineEdit(goalFocus.id, "name", e.target.value)}
                  onBlur={() => onSaveInlineEdit()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSaveInlineEdit();
                    if (e.key === "Escape") onCancelInlineEdit();
                  }}
                />
              ) : (
                <div
                  className="text-base font-semibold cursor-text hover:text-terminal-red/80 transition-colors"
                  title="Click to edit name"
                  onClick={() => onStartInlineEdit(goalFocus.id, "name", goalFocus.name)}
                >
                  {goalFocus.name}
                </div>
              )}
              <Badge variant="secondary" className="text-[10px] font-mono uppercase tracking-wide">
                {goalFocus.organizationName || "Unscoped"}
              </Badge>
              <select
                className={`border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide bg-background cursor-pointer focus:outline-none ${
                  goalFocus.status === "active" ? "border-green-500/50 text-green-400" :
                  goalFocus.status === "blocked" ? "border-terminal-red text-terminal-red" :
                  goalFocus.status === "done" ? "border-muted text-muted-foreground" :
                  "border-yellow-500/50 text-yellow-400"
                } disabled:opacity-40`}
                value={goalFocus.status}
                disabled={updatingGoalField === `${goalFocus.id}:status`}
                onChange={(e) => onUpdateGoalField(goalFocus.id, "status", e.target.value)}
              >
                <option value="planned">PLANNED</option>
                <option value="active">ACTIVE</option>
                <option value="blocked">BLOCKED</option>
                <option value="done">DONE</option>
              </select>
              <select
                className="border border-blue-500/30 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide bg-background text-blue-400/80 cursor-pointer focus:outline-none disabled:opacity-40"
                value={goalFocus.level ?? ""}
                disabled={updatingGoalField === `${goalFocus.id}:level`}
                onChange={(e) => onUpdateGoalField(goalFocus.id, "level", e.target.value)}
              >
                <option value="">— LEVEL —</option>
                <option value="vision">VISION</option>
                <option value="mission">MISSION</option>
                <option value="objective">OBJECTIVE</option>
                <option value="key_result">KEY RESULT</option>
              </select>
              {goalFocus.parentGoalName ? (
                <Badge variant="outline" className="text-[10px]">
                  child goal
                </Badge>
              ) : null}
            </div>
            {inlineEditGoal?.id === goalFocus.id && inlineEditGoal.field === "description" ? (
              <textarea
                autoFocus
                rows={3}
                className="w-full max-w-3xl text-sm bg-transparent border border-terminal-red/40 rounded p-1 outline-none resize-none text-muted-foreground"
                value={inlineEditGoal.value}
                disabled={inlineEditSaving}
                onChange={(e) => onStartInlineEdit(goalFocus.id, "description", e.target.value)}
                onBlur={() => onSaveInlineEdit()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") onCancelInlineEdit();
                }}
              />
            ) : (
              <p
                className="max-w-3xl text-sm text-muted-foreground cursor-text hover:text-foreground/70 transition-colors"
                title="Click to edit description"
                onClick={() => onStartInlineEdit(goalFocus.id, "description", goalFocus.description ?? "")}
              >
                {goalFocus.description || <span className="italic opacity-50">Click to add description…</span>}
              </p>
            )}
            {subGoals.length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                  Sub-Goals ({subGoals.length})
                </div>
                {subGoals.map((sub) => (
                  <button
                    key={sub.id}
                    type="button"
                    className="flex items-center gap-2 w-full text-left px-2 py-1 rounded border border-border/50 hover:border-terminal-red/40 transition-colors"
                    onClick={() => onSelectGoal(sub.id)}
                  >
                    <span className="text-xs font-medium flex-1 truncate">{sub.name}</span>
                    <Badge variant="outline" className={`shrink-0 text-[9px] font-mono uppercase ${
                      sub.status === "active" ? "border-green-500/50 text-green-400" :
                      sub.status === "blocked" ? "border-terminal-red text-terminal-red" :
                      sub.status === "done" ? "border-muted text-muted-foreground" :
                      "border-yellow-500/50 text-yellow-400"
                    }`}>
                      {sub.status}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {goalSourcePackItems.length > 0 && (
          <div className="border-t border-dashed border-border pt-3">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">
              Source Pack ({goalSourcePackItems.length} items)
            </div>
            <div className="space-y-2">
              {goalSourcePackItems.map((item) => (
                <div key={item.key} className="rounded border border-border/60 bg-muted/10 p-2 flex flex-wrap items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{item.label}</div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {item.sourceType && (
                        <Badge variant="outline" className="text-[9px]">
                          {item.sourceType}
                        </Badge>
                      )}
                      {item.taskCount > 0 && (
                        <Badge variant="secondary" className="text-[9px]">
                          {item.taskCount} tasks
                        </Badge>
                      )}
                      {item.workflowCount > 0 && (
                        <Badge variant="secondary" className="text-[9px]">
                          {item.workflowCount} workflows
                        </Badge>
                      )}
                    </div>
                    {item.document && (
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {item.document.excerpt.slice(0, 120)}
                      </div>
                    )}
                  </div>
                  {item.document && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[10px]"
                      onClick={() => router.push(`/documents?documentId=${encodeURIComponent(item.document!.id)}`)}
                    >
                      Open
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {displayedDocuments.length > 0 && (
          <div className="border-t border-dashed border-border pt-3">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">
              Attachments ({displayedDocuments.length})
            </div>
            <div className="space-y-1.5">
              {displayedDocuments.map((doc) => (
                <div key={doc.id} className="rounded border border-border/70 bg-muted/10 p-2 flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate">{doc.name}</div>
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      <Badge variant="outline" className="text-[9px]">{doc.sourceType}</Badge>
                      {doc.mimeType && <Badge variant="outline" className="text-[9px]">{doc.mimeType}</Badge>}
                      {doc.sizeBytes != null && <span className="text-[9px] text-muted-foreground">{formatSourceSize(doc.sizeBytes)}</span>}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[10px]"
                    onClick={() => router.push(`/documents?documentId=${encodeURIComponent(doc.id)}`)}
                  >
                    Open
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricPill({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={`rounded-md border px-2 py-1.5 ${warn ? "border-amber-500/30 bg-amber-500/5" : "border-border/60 bg-card"}`}>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}
