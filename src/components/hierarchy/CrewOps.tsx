"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MemberRoster } from "@/components/hierarchy/MemberRoster";

type CrewOpsMemberSummary = {
  agentId: string;
  name: string;
  roleType: string;
  roleTitle: string;
  agentActive: boolean;
  inboxUnread: number;
  assignedOpenTasks: number;
  checkedOutTasks: number;
  blockedTasks: number;
  pendingApprovals: number;
  pendingToolApprovals: number;
  queuedWakeups: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastRunStatus: string | null;
  lastError: string | null;
  updatedAt: string | null;
};

type CrewOpsSummary = {
  organization: {
    id: string;
    name: string;
    mission: string | null;
    memberCount: number;
  };
  goal: {
    id: string;
    name: string;
    scopeSize: number;
  } | null;
  summary: {
    totalMembers: number;
    activeMembers: number;
    scopedTasks: number;
    blockedTasks: number;
    pendingTaskApprovals: number;
    pendingToolApprovals: number;
    queuedWakeups: number;
    runningExecutions: number;
    activeWorktrees: number;
    codingSessions: number;
    inboxUnread: number;
    budgetSpendUsd: number;
    failedMembers: number;
  };
  members: CrewOpsMemberSummary[];
  blockedTaskSamples: Array<{
    id: string;
    title: string;
    assignedAgentName?: string | null;
    checkedOutByAgentName?: string | null;
    blockedBy: string[];
  }>;
  pendingApprovalSamples: Array<{
    id: string;
    taskId: string;
    comments?: Array<{ id: string; comment: string; createdAt: string }>;
  }>;
  queuedWakeupSamples: Array<{
    id: string;
    agentId: string;
    source: string;
    coalescedCount: number;
  }>;
};

type BoardTask = {
  id: string;
  title: string;
  status: string;
  goalId?: string | null;
};

export type CrewOpsProps = {
  crewOps: CrewOpsSummary | null;
  crewOpsLoading: boolean;
  goalId: string;
  scopedGoalTasks: BoardTask[];
};

export function CrewOps({ crewOps, crewOpsLoading, goalId, scopedGoalTasks }: CrewOpsProps) {
  const router = useRouter();

  return (
    <div className="mt-4 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Crew Ops</div>
          <div className="text-xs text-muted-foreground">
            Approval gates, blocked work, wakeups, and live runtime signals for this goal scope.
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => router.push("/approvals")}>
            Approvals
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => router.push("/boards")}>
            Boards
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => router.push("/workflows")}>
            Workflows
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => router.push("/council")}>
            Council
          </Button>
        </div>
      </div>
      {crewOpsLoading ? (
        <p className="mt-3 text-xs text-muted-foreground">Loading crew operations...</p>
      ) : !crewOps ? (
        <p className="mt-3 text-xs text-muted-foreground">Crew operations are not available for the current scope yet.</p>
      ) : (
        <div className="mt-3 space-y-3" data-testid="hierarchy-crew-ops">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
            {[
              { label: "Pending Approvals", value: crewOps.summary.pendingTaskApprovals + crewOps.summary.pendingToolApprovals },
              { label: "Blocked Tasks", value: crewOps.summary.blockedTasks },
              { label: "Queued Wakeups", value: crewOps.summary.queuedWakeups },
              { label: "Inbox Unread", value: crewOps.summary.inboxUnread },
              { label: "Running", value: crewOps.summary.runningExecutions },
              { label: "Worktrees", value: crewOps.summary.activeWorktrees },
            ].map((item) => (
              <div key={`${goalId}-${item.label}`} className="rounded-lg border border-border bg-card p-3">
                <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{item.label}</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">{item.value}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <MemberRoster
              members={crewOps.members}
              totalActive={crewOps.summary.activeMembers}
              totalMembers={crewOps.summary.totalMembers}
              goalId={goalId}
            />

            <div className="space-y-2 rounded-md border border-border/70 px-3 py-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Hotspots</div>
              <div className="space-y-2 text-[11px]">
                <div>
                  <div className="mb-1 text-muted-foreground">Blocked work</div>
                  <div className="flex flex-wrap gap-2">
                    {crewOps.blockedTaskSamples.length === 0 ? (
                      <span className="text-xs text-muted-foreground">No blocked tasks.</span>
                    ) : (
                      crewOps.blockedTaskSamples.slice(0, 4).map((task) => (
                        <Badge key={`${goalId}-blocked-${task.id}`} variant="outline" className="max-w-full truncate text-[10px]">
                          {task.title}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-muted-foreground">Pending plan gates</div>
                  <div className="flex flex-wrap gap-2">
                    {crewOps.pendingApprovalSamples.length === 0 ? (
                      <span className="text-xs text-muted-foreground">No pending task approvals.</span>
                    ) : (
                      crewOps.pendingApprovalSamples.slice(0, 4).map((approval) => (
                        <Badge key={`${goalId}-approval-${approval.id}`} variant="secondary" className="text-[10px]">
                          {scopedGoalTasks.find((task) => task.id === approval.taskId)?.title || approval.taskId}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-muted-foreground">Wakeups</div>
                  <div className="flex flex-wrap gap-2">
                    {crewOps.queuedWakeupSamples.length === 0 ? (
                      <span className="text-xs text-muted-foreground">No queued wakeups.</span>
                    ) : (
                      crewOps.queuedWakeupSamples.slice(0, 4).map((wakeup) => (
                        <Badge key={`${goalId}-wakeup-${wakeup.id}`} variant="outline" className="text-[10px]">
                          {wakeup.agentId} · {wakeup.source}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
