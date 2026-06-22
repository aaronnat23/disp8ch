import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logActivity, listActivityLog } from "@/lib/governance/activity-log";
import { recordConfigRevision, listConfigRevisions, getConfigRevision } from "@/lib/governance/config-revisions";
import { listTaskLabels, createTaskLabel, deleteTaskLabel, assignLabelToTask, removeLabelFromTask, getLabelsForTask } from "@/lib/governance/task-labels";
import { createTaskApproval, resolveTaskApproval, listTaskApprovals, getTaskApprovalGate } from "@/lib/governance/task-approvals";
import { enqueueWakeup, claimWakeup, finishWakeup, listWakeupRequests } from "@/lib/governance/wakeup-queue";
import { addApprovalComment, listApprovalComments } from "@/lib/governance/approval-comments";
import { listHeartbeatJobs, listHeartbeatRuns, listHeartbeatRunEvents } from "@/lib/governance/heartbeat";
import { exportCompanyPackage, importCompanyPackage, listBuiltinPackages, getBuiltinPackage } from "@/lib/governance/company-packages";
import { getSpendByGoal } from "@/lib/agents/budgets";
import { getAgentRuntimeState, listAgentRuntimeStates } from "@/lib/governance/agent-runtime";
import type { CompanyPackage } from "@/lib/governance/company-packages";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

/* ─── Schemas ─── */

const ActivityLogQuerySchema = z.object({
  entityType: z.string().max(64).optional(),
  entityId: z.string().max(128).optional(),
  actorType: z.enum(["user", "agent", "system"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const LogActivitySchema = z.object({
  actorType: z.enum(["user", "agent", "system"]),
  actorId: z.string().max(128).nullable().optional(),
  activityAction: z.string().min(1).max(128),
  entityType: z.string().min(1).max(64),
  entityId: z.string().max(128).nullable().optional(),
  details: z.record(z.unknown()).nullable().optional(),
});

const CreateLabelSchema = z.object({
  name: z.string().min(1).max(64),
  color: z.string().max(20).optional(),
  scope: z.string().max(64).optional(),
});

const AssignLabelSchema = z.object({
  taskId: z.string().min(1).max(128),
  labelId: z.string().min(1).max(128),
});

const CreateTaskApprovalSchema = z.object({
  taskId: z.string().min(1).max(128),
  approverType: z.enum(["user", "agent"]).optional(),
  approverId: z.string().max(128).nullable().optional(),
});

const ResolveTaskApprovalSchema = z.object({
  id: z.string().min(1).max(128),
  decision: z.enum(["approved", "rejected", "revision_requested"]),
  decisionNote: z.string().max(1024).optional(),
});

const EnqueueWakeupSchema = z.object({
  agentId: z.string().min(1).max(128),
  source: z.string().min(1).max(128),
  triggerDetail: z.string().max(512).optional(),
  payload: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().max(128).optional(),
});

const AddCommentSchema = z.object({
  approvalId: z.string().min(1).max(128),
  authorType: z.enum(["user", "agent", "system"]).optional(),
  authorId: z.string().max(128).nullable().optional(),
  comment: z.string().min(1).max(2048),
  decision: z.string().max(64).nullable().optional(),
});

/* ─── GET ─── */

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");

    switch (action) {
      case "activity-log": {
        const params = ActivityLogQuerySchema.parse({
          entityType: searchParams.get("entityType") ?? undefined,
          entityId: searchParams.get("entityId") ?? undefined,
          actorType: searchParams.get("actorType") ?? undefined,
          limit: searchParams.get("limit") ?? undefined,
        });
        return NextResponse.json({ success: true, data: listActivityLog(params) });
      }

      case "config-revisions": {
        const agentId = searchParams.get("agentId");
        if (!agentId) return NextResponse.json({ success: false, error: "Missing agentId" }, { status: 400 });
        const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;
        return NextResponse.json({ success: true, data: listConfigRevisions(agentId, limit) });
      }

      case "config-revision": {
        const revisionId = searchParams.get("revisionId");
        if (!revisionId) return NextResponse.json({ success: false, error: "Missing revisionId" }, { status: 400 });
        const rev = getConfigRevision(revisionId);
        if (!rev) return NextResponse.json({ success: false, error: "Revision not found" }, { status: 404 });
        return NextResponse.json({ success: true, data: rev });
      }

      case "task-labels": {
        return NextResponse.json({ success: true, data: listTaskLabels() });
      }

      case "task-label-assignments": {
        const taskId = searchParams.get("taskId");
        if (!taskId) return NextResponse.json({ success: false, error: "Missing taskId" }, { status: 400 });
        return NextResponse.json({ success: true, data: getLabelsForTask(taskId) });
      }

      case "task-approvals": {
        const taskId = searchParams.get("taskId") ?? undefined;
        const status = searchParams.get("status") ?? undefined;
        const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;
        return NextResponse.json({ success: true, data: listTaskApprovals({ taskId, status: status as "pending" | "approved" | "rejected" | "revision_requested" | undefined, limit }) });
      }

      case "task-approval-gate": {
        const taskId = searchParams.get("taskId");
        if (!taskId) return NextResponse.json({ success: false, error: "Missing taskId" }, { status: 400 });
        return NextResponse.json({ success: true, data: getTaskApprovalGate(taskId) });
      }

      case "wakeup-requests": {
        const agentId = searchParams.get("agentId") ?? undefined;
        const status = searchParams.get("status") ?? undefined;
        const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;
        return NextResponse.json({ success: true, data: listWakeupRequests({ agentId, status: status as "queued" | "claimed" | "finished" | undefined, limit }) });
      }

      case "approval-comments": {
        const approvalId = searchParams.get("approvalId");
        if (!approvalId) return NextResponse.json({ success: false, error: "Missing approvalId" }, { status: 400 });
        return NextResponse.json({ success: true, data: listApprovalComments(approvalId) });
      }

      case "heartbeat-jobs": {
        return NextResponse.json({ success: true, data: listHeartbeatJobs() });
      }

      case "heartbeat-runs": {
        const agentId = searchParams.get("agentId");
        if (!agentId) return NextResponse.json({ success: false, error: "Missing agentId" }, { status: 400 });
        const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : 20;
        return NextResponse.json({ success: true, data: listHeartbeatRuns(agentId, limit) });
      }

      case "spend-by-goal": {
        const goalId = searchParams.get("goalId");
        if (!goalId) return NextResponse.json({ success: false, error: "Missing goalId" }, { status: 400 });
        const windowDays = searchParams.get("windowDays") ? Number(searchParams.get("windowDays")) : 30;
        return NextResponse.json({ success: true, data: getSpendByGoal(goalId, windowDays) });
      }

      case "company-packages": {
        return NextResponse.json({ success: true, data: listBuiltinPackages() });
      }

      case "company-package": {
        const key = searchParams.get("key");
        if (!key) return NextResponse.json({ success: false, error: "Missing key" }, { status: 400 });
        const pkg = getBuiltinPackage(key);
        if (!pkg) return NextResponse.json({ success: false, error: "Package not found" }, { status: 404 });
        return NextResponse.json({ success: true, data: pkg });
      }

      case "agent-runtime-state": {
        const agentId = searchParams.get("agentId");
        if (!agentId) return NextResponse.json({ success: false, error: "Missing agentId" }, { status: 400 });
        const state = getAgentRuntimeState(agentId);
        return NextResponse.json({ success: true, data: state });
      }

      case "agent-runtime-states": {
        const agentIds = (searchParams.get("agentIds") ?? "").split(",").filter(Boolean);
        if (agentIds.length === 0) return NextResponse.json({ success: false, error: "Missing agentIds" }, { status: 400 });
        return NextResponse.json({ success: true, data: listAgentRuntimeStates(agentIds) });
      }

      case "heartbeat-run-events": {
        const runId = searchParams.get("runId");
        if (!runId) return NextResponse.json({ success: false, error: "Missing runId" }, { status: 400 });
        return NextResponse.json({ success: true, data: listHeartbeatRunEvents(runId) });
      }

      default:
        return NextResponse.json({
          success: true,
          data: {
            actions: [
              "activity-log", "config-revisions", "config-revision",
              "task-labels", "task-label-assignments",
              "task-approvals", "task-approval-gate",
              "wakeup-requests", "approval-comments",
              "heartbeat-jobs", "heartbeat-runs", "heartbeat-run-events",
              "spend-by-goal",
              "company-packages", "company-package",
              "agent-runtime-state", "agent-runtime-states",
            ],
          },
        });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

/* ─── POST ─── */

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const action = body.action as string | undefined;

    switch (action) {
      case "log-activity": {
        const parsed = LogActivitySchema.parse(body);
        const entry = logActivity({ ...parsed, action: parsed.activityAction });
        return NextResponse.json({ success: true, data: entry }, { status: 201 });
      }

      case "create-label": {
        const parsed = CreateLabelSchema.parse(body);
        const label = createTaskLabel(parsed);
        return NextResponse.json({ success: true, data: label }, { status: 201 });
      }

      case "assign-label": {
        const parsed = AssignLabelSchema.parse(body);
        assignLabelToTask(parsed.taskId, parsed.labelId);
        return NextResponse.json({ success: true });
      }

      case "remove-label": {
        const parsed = AssignLabelSchema.parse(body);
        removeLabelFromTask(parsed.taskId, parsed.labelId);
        return NextResponse.json({ success: true });
      }

      case "create-task-approval": {
        const parsed = CreateTaskApprovalSchema.parse(body);
        const approval = createTaskApproval(parsed);
        return NextResponse.json({ success: true, data: approval }, { status: 201 });
      }

      case "resolve-task-approval": {
        const parsed = ResolveTaskApprovalSchema.parse(body);
        const resolved = resolveTaskApproval(parsed);
        return NextResponse.json({ success: true, data: resolved });
      }

      case "enqueue-wakeup": {
        const parsed = EnqueueWakeupSchema.parse(body);
        const req = enqueueWakeup(parsed);
        return NextResponse.json({ success: true, data: req }, { status: 201 });
      }

      case "claim-wakeup": {
        const id = z.string().min(1).parse(body.id);
        const claimed = claimWakeup(id);
        if (!claimed) return NextResponse.json({ success: false, error: "Cannot claim: not queued or not found" }, { status: 409 });
        return NextResponse.json({ success: true, data: claimed });
      }

      case "finish-wakeup": {
        const id = z.string().min(1).parse(body.id);
        finishWakeup(id);
        return NextResponse.json({ success: true });
      }

      case "add-approval-comment": {
        const parsed = AddCommentSchema.parse(body);
        const comment = addApprovalComment(parsed);
        return NextResponse.json({ success: true, data: comment }, { status: 201 });
      }

      case "update-agent-runtime-state": {
        const parsed = z
          .object({
            agentId: z.string().min(1).max(128),
            sessionId: z.string().max(256).nullable().optional(),
            stateJson: z.record(z.unknown()).nullable().optional(),
            deltaInputTokens: z.number().int().optional(),
            deltaOutputTokens: z.number().int().optional(),
            deltaCachedTokens: z.number().int().optional(),
            deltaCostUsd: z.number().optional(),
            lastRunId: z.string().max(128).nullable().optional(),
            lastRunStatus: z.string().max(64).nullable().optional(),
            lastError: z.string().max(1024).nullable().optional(),
          })
          .parse(body);
        const { upsertAgentRuntimeState } = await import("@/lib/governance/agent-runtime");
        upsertAgentRuntimeState(parsed);
        return NextResponse.json({ success: true });
      }

      case "export-company": {
        const orgId = z.string().min(1).parse(body.organizationId);
        const pkg = exportCompanyPackage(orgId);
        return NextResponse.json({ success: true, data: pkg });
      }

      case "import-company": {
        const pkg = body.package as CompanyPackage;
        if (!pkg || pkg.version !== 1) return NextResponse.json({ success: false, error: "Invalid package" }, { status: 400 });
        const result = importCompanyPackage(pkg, { activate: body.activate ?? false });
        return NextResponse.json({ success: true, data: result }, { status: 201 });
      }

      default:
        return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

/* ─── DELETE ─── */

export async function DELETE(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");

    switch (action) {
      case "delete-label": {
        const labelId = searchParams.get("labelId");
        if (!labelId) return NextResponse.json({ success: false, error: "Missing labelId" }, { status: 400 });
        deleteTaskLabel(labelId);
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
