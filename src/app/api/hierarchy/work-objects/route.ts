import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createWorkObject,
  getRootWorkObjectForGoal,
  getWorkObjectById,
  linkWorkObject,
  listWorkObjects,
  updateWorkObject,
  type WorkObjectStatus,
  type WorkObjectType,
  type WorkObject,
} from "@/lib/hierarchy/work-objects";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const TypeSchema = z.enum(["goal", "project", "task", "workflow", "decision", "document", "incident"]);
const StatusSchema = z.enum(["planned", "ready", "in_progress", "blocked", "review", "done", "cancelled"]);
const PrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
const RiskSchema = z.enum(["low", "medium", "high"]);

const CreateSchema = z.object({
  organizationId: z.string().min(1).optional().nullable(),
  goalId: z.string().min(1).optional().nullable(),
  parentWorkObjectId: z.string().min(1).optional().nullable(),
  type: TypeSchema,
  title: z.string().min(1).max(180),
  description: z.string().max(2000).optional().nullable(),
  ownerAgentId: z.string().min(1).optional().nullable(),
  status: StatusSchema.optional().nullable(),
  priority: PrioritySchema.optional().nullable(),
  linkedTaskIds: z.array(z.string().min(1)).optional(),
  linkedWorkflowIds: z.array(z.string().min(1)).optional(),
  linkedDocumentIds: z.array(z.string().min(1)).optional(),
  linkedCouncilSessionIds: z.array(z.string().min(1)).optional(),
  linkedExecutionIds: z.array(z.string().min(1)).optional(),
  decisionIds: z.array(z.string().min(1)).optional(),
  deliverables: z.array(z.string().min(1)).optional(),
  blockers: z.array(z.string().min(1)).optional(),
  riskLevel: RiskSchema.optional().nullable(),
  dueAt: z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.partial().extend({
  id: z.string().min(1),
});

const LinkSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  documentId: z.string().min(1).optional(),
  councilSessionId: z.string().min(1).optional(),
  executionId: z.string().min(1).optional(),
  decisionId: z.string().min(1).optional(),
});

function errorStatus(error: unknown): number {
  const message = String(error);
  if (message.includes("not found")) return 404;
  return 500;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (id) {
      const data = getWorkObjectById(id);
      if (!data) return NextResponse.json({ success: false, error: `Work object not found: ${id}` }, { status: 404 });
      return NextResponse.json({ success: true, data });
    }
    const rootGoalId = searchParams.get("rootGoalId");
    if (rootGoalId) {
      return NextResponse.json({ success: true, data: getRootWorkObjectForGoal(rootGoalId) });
    }
    const status = searchParams.get("status");
    const type = searchParams.get("type");
    const parsedStatus = StatusSchema.safeParse(status);
    const parsedType = TypeSchema.safeParse(type);
    return NextResponse.json({
      success: true,
      data: listWorkObjects({
        organizationId: searchParams.get("organizationId") || undefined,
        goalId: searchParams.get("goalId") || undefined,
        status: parsedStatus.success ? (parsedStatus.data as WorkObjectStatus) : undefined,
        type: parsedType.success ? (parsedType.data as WorkObjectType) : undefined,
      }),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const parsed = CreateSchema.parse(await request.json());
    return NextResponse.json({ success: true, data: createWorkObject(parsed) }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    return NextResponse.json({ success: false, error: String(error) }, { status: errorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    if (body?.action === "link") {
      const parsed = LinkSchema.parse(body);
      const { id, ...link } = parsed;
      return NextResponse.json({ success: true, data: linkWorkObject(id, link) });
    }
    const parsed = UpdateSchema.parse(body);
    const { id, ...updates } = parsed;
    const cleanUpdates: Partial<Omit<WorkObject, "id" | "createdAt" | "updatedAt">> = {};
    if (updates.organizationId !== undefined) cleanUpdates.organizationId = updates.organizationId;
    if (updates.goalId !== undefined) cleanUpdates.goalId = updates.goalId;
    if (updates.parentWorkObjectId !== undefined) cleanUpdates.parentWorkObjectId = updates.parentWorkObjectId;
    if (updates.type !== undefined) cleanUpdates.type = updates.type;
    if (updates.title !== undefined) cleanUpdates.title = updates.title;
    if (updates.description !== undefined) cleanUpdates.description = updates.description;
    if (updates.ownerAgentId !== undefined) cleanUpdates.ownerAgentId = updates.ownerAgentId;
    if (updates.status != null) cleanUpdates.status = updates.status;
    if (updates.priority != null) cleanUpdates.priority = updates.priority;
    if (updates.linkedTaskIds !== undefined) cleanUpdates.linkedTaskIds = updates.linkedTaskIds;
    if (updates.linkedWorkflowIds !== undefined) cleanUpdates.linkedWorkflowIds = updates.linkedWorkflowIds;
    if (updates.linkedDocumentIds !== undefined) cleanUpdates.linkedDocumentIds = updates.linkedDocumentIds;
    if (updates.linkedCouncilSessionIds !== undefined) cleanUpdates.linkedCouncilSessionIds = updates.linkedCouncilSessionIds;
    if (updates.linkedExecutionIds !== undefined) cleanUpdates.linkedExecutionIds = updates.linkedExecutionIds;
    if (updates.decisionIds !== undefined) cleanUpdates.decisionIds = updates.decisionIds;
    if (updates.deliverables !== undefined) cleanUpdates.deliverables = updates.deliverables;
    if (updates.blockers !== undefined) cleanUpdates.blockers = updates.blockers;
    if (updates.riskLevel != null) cleanUpdates.riskLevel = updates.riskLevel;
    if (updates.dueAt !== undefined) cleanUpdates.dueAt = updates.dueAt;
    return NextResponse.json({ success: true, data: updateWorkObject(id, cleanUpdates) });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    return NextResponse.json({ success: false, error: String(error) }, { status: errorStatus(error) });
  }
}
