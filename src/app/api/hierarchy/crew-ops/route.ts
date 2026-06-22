import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { listBoardTasks } from "@/lib/boards/manager";
import { listAgentRuntimeStates } from "@/lib/governance/agent-runtime";
import { listApprovalComments } from "@/lib/governance/approval-comments";
import { listTaskApprovals } from "@/lib/governance/task-approvals";
import { listWakeupRequests } from "@/lib/governance/wakeup-queue";
import { getHierarchyGoalById, listHierarchyGoals, resolveHierarchyGoal } from "@/lib/hierarchy/goals";
import {
  getActiveHierarchyOrganization,
  listHierarchyOrganizationMembers,
  resolveHierarchyOrganization,
} from "@/lib/hierarchy/organizations";
import { listRunningExecutions } from "@/lib/engine/runtime-tracker";
import { listPendingApprovals } from "@/lib/engine/tools";
import { listCodingAgentSessions } from "@/lib/sessions/coding-agent-registry";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  organizationId: z.string().min(1).max(120).optional(),
  organization: z.string().min(1).max(120).optional(),
  goalId: z.string().min(1).max(120).optional(),
  goal: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

function sanitizeInboxKey(agentId: string) {
  return agentId.replace(/[^a-z0-9_\-]/gi, "_");
}

function getInboxUnreadCount(agentId: string): number {
  const inboxDir = path.join(process.cwd(), "data", "inbox", sanitizeInboxKey(agentId));
  try {
    return fs.readdirSync(inboxDir).filter((entry) => entry.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function buildGoalScopeIds(goalId: string, organizationId?: string | null): Set<string> {
  const goals = listHierarchyGoals({ organizationId: organizationId ?? null });
  const childrenByParent = new Map<string, string[]>();
  for (const goal of goals) {
    if (!goal.parentGoalId) continue;
    const siblings = childrenByParent.get(goal.parentGoalId) ?? [];
    siblings.push(goal.id);
    childrenByParent.set(goal.parentGoalId, siblings);
  }
  const scopeIds = new Set<string>();
  const visit = (id: string) => {
    if (scopeIds.has(id)) return;
    scopeIds.add(id);
    for (const childId of childrenByParent.get(id) ?? []) {
      visit(childId);
    }
  };
  visit(goalId);
  return scopeIds;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const parsed = QuerySchema.parse({
      organizationId: searchParams.get("organizationId") ?? undefined,
      organization: searchParams.get("organization") ?? undefined,
      goalId: searchParams.get("goalId") ?? undefined,
      goal: searchParams.get("goal") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });

    const organizationRef = parsed.organizationId ?? parsed.organization;
    const organization =
      (organizationRef ? resolveHierarchyOrganization(organizationRef) : null) ??
      getActiveHierarchyOrganization();
    if (!organization) {
      return NextResponse.json({ success: false, error: "Organization not found" }, { status: 404 });
    }

    const goalRef = parsed.goalId ?? parsed.goal;
    const goal =
      (goalRef ? resolveHierarchyGoal(goalRef, organization.id) : null) ??
      (goalRef ? getHierarchyGoalById(goalRef) : null);
    if (goalRef && !goal) {
      return NextResponse.json({ success: false, error: `Goal not found: ${goalRef}` }, { status: 404 });
    }

    const memberRows = listHierarchyOrganizationMembers(organization.id);
    const memberIds = new Set(memberRows.map((member) => member.agent.id));
    const goalScopeIds = goal ? buildGoalScopeIds(goal.id, organization.id) : null;
    const boardTasks = listBoardTasks(undefined, { organizationId: organization.id });
    const scopedTasks = goalScopeIds
      ? boardTasks.filter((task) => task.goalId && goalScopeIds.has(task.goalId))
      : boardTasks;
    const scopedTaskIds = new Set(scopedTasks.map((task) => task.id));
    const blockedTasks = scopedTasks.filter((task) => task.status === "blocked");
    const scopedApprovals = listTaskApprovals({ status: "pending", limit: 200 }).filter((approval) =>
      scopedTaskIds.has(approval.taskId),
    );
    const queuedWakeups = listWakeupRequests({ status: "queued", limit: 200 }).filter((wakeup) =>
      memberIds.has(wakeup.agentId),
    );
    const pendingToolApprovals = listPendingApprovals().filter((approval) =>
      approval.agentId ? memberIds.has(approval.agentId) : true,
    );
    const runtimeStates = listAgentRuntimeStates(Array.from(memberIds));
    const runtimeByAgentId = new Map(runtimeStates.map((state) => [state.agentId, state]));

    initializeDatabase();
    const db = getSqlite();
    const workflowRows = db.prepare(
      "SELECT id, name, organization_id, goal_id FROM workflows ORDER BY updated_at DESC",
    ).all() as Array<{
      id: string;
      name: string;
      organization_id: string | null;
      goal_id: string | null;
    }>;
    const scopedWorkflowRows = workflowRows.filter((workflow) => workflow.organization_id === organization.id).filter(
      (workflow) => (goalScopeIds ? Boolean(workflow.goal_id && goalScopeIds.has(workflow.goal_id)) : true),
    );
    const scopedWorkflowIds = new Set(scopedWorkflowRows.map((workflow) => workflow.id));
    const runningExecutions = listRunningExecutions().filter((execution) =>
      scopedWorkflowIds.has(execution.workflowId),
    );
    const codingSessions = listCodingAgentSessions();
    const worktreeSessions = codingSessions.filter((session) => Boolean(session.worktreePath));

    const memberSummaries = memberRows
      .map((member) => {
        const assignedTasks = scopedTasks.filter((task) => task.assignedAgentId === member.agent.id);
        const checkedOutTasks = scopedTasks.filter((task) => task.checkedOutByAgentId === member.agent.id);
        const blockedOwnedTasks = blockedTasks.filter(
          (task) => task.assignedAgentId === member.agent.id || task.checkedOutByAgentId === member.agent.id,
        );
        const pendingApprovals = scopedApprovals.filter((approval) => {
          const task = scopedTasks.find((row) => row.id === approval.taskId);
          return Boolean(
            task &&
              (task.assignedAgentId === member.agent.id ||
                task.checkedOutByAgentId === member.agent.id ||
                approval.approverId === member.agent.id),
          );
        });
        const wakeups = queuedWakeups.filter((wakeup) => wakeup.agentId === member.agent.id);
        const toolApprovals = pendingToolApprovals.filter((approval) => approval.agentId === member.agent.id);
        const runtime = runtimeByAgentId.get(member.agent.id) ?? null;
        return {
          agentId: member.agent.id,
          name: member.agent.name,
          roleType: member.role.roleType,
          roleTitle: member.role.roleTitle,
          agentActive: member.agentActive,
          inboxUnread: getInboxUnreadCount(member.agent.id),
          assignedOpenTasks: assignedTasks.filter((task) => task.status !== "done").length,
          checkedOutTasks: checkedOutTasks.length,
          blockedTasks: blockedOwnedTasks.length,
          pendingApprovals: pendingApprovals.length,
          pendingToolApprovals: toolApprovals.length,
          queuedWakeups: wakeups.length,
          totalCostUsd: runtime?.totalCostUsd ?? 0,
          totalInputTokens: runtime?.totalInputTokens ?? 0,
          totalOutputTokens: runtime?.totalOutputTokens ?? 0,
          lastRunStatus: runtime?.lastRunStatus ?? null,
          lastError: runtime?.lastError ?? null,
          updatedAt: runtime?.updatedAt ?? null,
        };
      })
      .sort((left, right) => {
        const byApprovals =
          right.pendingApprovals +
          right.pendingToolApprovals -
          (left.pendingApprovals + left.pendingToolApprovals);
        if (byApprovals !== 0) return byApprovals;
        const byBlocked = right.blockedTasks - left.blockedTasks;
        if (byBlocked !== 0) return byBlocked;
        return left.name.localeCompare(right.name);
      });

    const limit = parsed.limit ?? 8;
    return NextResponse.json({
      success: true,
      data: {
        organization: {
          id: organization.id,
          name: organization.name,
          mission: organization.mission,
          memberCount: organization.memberCount,
        },
        goal: goal
          ? {
              id: goal.id,
              name: goal.name,
              scopeSize: goalScopeIds?.size ?? 1,
            }
          : null,
        summary: {
          totalMembers: memberRows.length,
          activeMembers: memberRows.filter((member) => member.agentActive).length,
          scopedTasks: scopedTasks.length,
          blockedTasks: blockedTasks.length,
          pendingTaskApprovals: scopedApprovals.length,
          pendingToolApprovals: pendingToolApprovals.length,
          queuedWakeups: queuedWakeups.length,
          runningExecutions: runningExecutions.length,
          activeWorktrees: worktreeSessions.length,
          codingSessions: codingSessions.length,
          inboxUnread: memberSummaries.reduce((sum, member) => sum + member.inboxUnread, 0),
          budgetSpendUsd: memberSummaries.reduce((sum, member) => sum + member.totalCostUsd, 0),
          failedMembers: memberSummaries.filter((member) => member.lastRunStatus === "failed" || member.lastError).length,
        },
        members: memberSummaries.slice(0, Math.max(limit, memberSummaries.length)),
        blockedTaskSamples: blockedTasks.slice(0, limit).map((task) => ({
          id: task.id,
          title: task.title,
          goalId: task.goalId,
          goalName: task.goalName,
          assignedAgentId: task.assignedAgentId,
          assignedAgentName: task.assignedAgentName,
          checkedOutByAgentId: task.checkedOutByAgentId,
          checkedOutByAgentName: task.checkedOutByAgentName,
          blockedBy: task.blockedBy,
          updatedAt: task.updatedAt ?? null,
        })),
        pendingApprovalSamples: scopedApprovals.slice(0, limit).map((approval) => ({
          ...approval,
          comments: listApprovalComments(approval.id).slice(-2),
        })),
        queuedWakeupSamples: queuedWakeups.slice(0, limit),
        pendingToolApprovalSamples: pendingToolApprovals.slice(0, limit),
        runningExecutionSamples: runningExecutions.slice(0, limit).map((execution) => ({
          ...execution,
          workflowName:
            scopedWorkflowRows.find((workflow) => workflow.id === execution.workflowId)?.name ?? execution.workflowId,
        })),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
