"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";

const ROLE_TYPE_LABELS: Record<string, string> = {
  orchestrator: "Orchestrator",
  operations: "Operations Lead",
  specialist: "Specialist",
  worker: "Worker",
  support: "Support",
};

type MemberInfo = {
  agentId: string;
  name: string;
  roleType: string;
  agentActive: boolean;
  lastRunStatus: string | null;
  lastError: string | null;
  assignedOpenTasks: number;
  pendingApprovals: number;
  pendingToolApprovals: number;
  queuedWakeups: number;
  inboxUnread: number;
  totalCostUsd: number;
};

export type MemberRosterProps = {
  members: MemberInfo[];
  totalActive: number;
  totalMembers: number;
  goalId: string;
};

export function MemberRoster({ members, totalActive, totalMembers, goalId }: MemberRosterProps) {
  return (
    <div className="space-y-2 rounded-md border border-border/70 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Crew Members</div>
        <Badge variant="outline" className="text-[10px]">
          {totalActive}/{totalMembers} active
        </Badge>
      </div>
      <div className="space-y-2">
        {members.slice(0, 6).map((member) => (
          <div key={`${goalId}-crew-member-${member.agentId}`} className="rounded-md border border-border/60 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{member.name}</span>
              <Badge variant="outline" className="text-[10px]">
                {ROLE_TYPE_LABELS[member.roleType] || member.roleType}
              </Badge>
              {!member.agentActive ? <Badge variant="destructive" className="text-[10px]">inactive</Badge> : null}
              {member.lastRunStatus === "failed" || member.lastError ? (
                <Badge variant="destructive" className="text-[10px]">failed</Badge>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>{member.assignedOpenTasks} open tasks</span>
              <span>{member.pendingApprovals + member.pendingToolApprovals} approvals</span>
              <span>{member.queuedWakeups} wakeups</span>
              <span>{member.inboxUnread} inbox</span>
              <span>${member.totalCostUsd.toFixed(4)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
