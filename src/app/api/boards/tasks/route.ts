import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  claimBoardTask,
  createBoardTask,
  deleteBoardTask,
  listBoardTasks,
  releaseBoardTask,
  updateBoardTask,
} from "@/lib/boards/manager";
import { logActivity } from "@/lib/governance/activity-log";
import { requireOperatorAccess } from "@/lib/security/admin";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";
const log = logger.child("api:boards:tasks");

const StatusSchema = z.enum(["inbox", "in_progress", "review", "done", "blocked"]);
const PrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

const CreateTaskSchema = z.object({
  boardId: z.string().min(1),
  organizationId: z.string().min(1).max(120).optional().nullable(),
  goalId: z.string().min(1).max(120).optional().nullable(),
  title: z.string().min(1).max(240),
  description: z.string().max(2000).optional().nullable(),
  workflowTemplateKey: z.string().min(1).max(120).optional().nullable(),
  workflowId: z.string().min(1).max(120).optional().nullable(),
  sourceType: z.string().min(1).max(120).optional().nullable(),
  sourceRef: z.string().min(1).max(240).optional().nullable(),
  linkedDocumentIds: z.array(z.string().min(1).max(240)).max(24).optional().nullable(),
  deliverables: z.array(z.string().min(1).max(400)).max(24).optional().nullable(),
  status: StatusSchema.optional(),
  priority: PrioritySchema.optional(),
  assignedAgentId: z.string().min(1).nullable().optional(),
  requesterAgentId: z.string().min(1).nullable().optional(),
  parentId: z.string().min(1).max(128).nullable().optional(),
  requestDepth: z.number().int().min(0).max(10).optional(),
  blockedBy: z.array(z.string().min(1).max(128)).max(20).optional().nullable(),
  tagIds: z.array(z.string().min(1)).max(20).optional(),
});

const UpdateTaskSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1).max(120).optional().nullable(),
  goalId: z.string().min(1).max(120).optional().nullable(),
  title: z.string().min(1).max(240).optional(),
  description: z.string().max(2000).optional().nullable(),
  workflowTemplateKey: z.string().min(1).max(120).optional().nullable(),
  workflowId: z.string().min(1).max(120).optional().nullable(),
  sourceType: z.string().min(1).max(120).optional().nullable(),
  sourceRef: z.string().min(1).max(240).optional().nullable(),
  linkedDocumentIds: z.array(z.string().min(1).max(240)).max(24).optional().nullable(),
  deliverables: z.array(z.string().min(1).max(400)).max(24).optional().nullable(),
  status: StatusSchema.optional(),
  priority: PrioritySchema.optional(),
  assignedAgentId: z.string().min(1).nullable().optional(),
  requesterAgentId: z.string().min(1).nullable().optional(),
  checkedOutByAgentId: z.string().min(1).nullable().optional(),
  checkedOutAt: z.string().nullable().optional(),
  parentId: z.string().min(1).max(128).nullable().optional(),
  blockedBy: z.array(z.string().min(1).max(128)).max(20).optional().nullable(),
  tagIds: z.array(z.string().min(1)).max(20).optional(),
});

function mapErrorStatus(error: unknown): number {
  const message = String(error);
  if (message.includes("not found")) return 404;
  if (message.includes("required")) return 400;
  if (message.includes("outside manager subtree") || message.includes("already checked out")) return 400;
  return 500;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const boardId = searchParams.get("boardId") || undefined;
    const organizationId = searchParams.get("organizationId") || undefined;
    const goalId = searchParams.get("goalId") || undefined;
    const assignedAgentId = searchParams.get("assignedAgentId") || undefined;
    const checkedOutByAgentId = searchParams.get("checkedOutByAgentId") || undefined;
    const tasks = listBoardTasks(boardId, {
      organizationId,
      goalId,
      assignedAgentId,
      checkedOutByAgentId,
    });
    return NextResponse.json({ success: true, data: tasks });
  } catch (error) {
    log.error("GET /api/boards/tasks failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = CreateTaskSchema.parse(body);
    const task = createBoardTask(parsed);
    logActivity({ actorType: "user", action: "task.created", entityType: "board_task", entityId: task.id, details: { title: task.title, boardId: parsed.boardId } });
    return NextResponse.json({ success: true, data: task }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    log.error("POST /api/boards/tasks failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const action = String(body?.action || "").trim().toLowerCase();
    let task;
    if (action === "claim") {
      const parsed = z.object({
        id: z.string().min(1),
        agentId: z.string().min(1),
      }).parse(body);
      task = claimBoardTask(parsed.id, parsed.agentId);
      logActivity({ actorType: "agent", actorId: parsed.agentId, action: "task.claimed", entityType: "board_task", entityId: parsed.id });
    } else if (action === "release") {
      const parsed = z.object({
        id: z.string().min(1),
        agentId: z.string().min(1).optional().nullable(),
      }).parse(body);
      task = releaseBoardTask(parsed.id, parsed.agentId || undefined);
      logActivity({ actorType: "user", action: "task.released", entityType: "board_task", entityId: parsed.id });
    } else {
      const parsed = UpdateTaskSchema.parse(body);
      const { id, ...updates } = parsed;
      task = updateBoardTask(id, updates);
      logActivity({ actorType: "user", action: "task.updated", entityType: "board_task", entityId: id, details: { updatedFields: Object.keys(updates) } });
    }
    return NextResponse.json({ success: true, data: task });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, error: "Missing id" }, { status: 400 });
    }
    deleteBoardTask(id);
    logActivity({ actorType: "user", action: "task.deleted", entityType: "board_task", entityId: id });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}
