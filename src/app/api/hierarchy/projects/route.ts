import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createHierarchyProject,
  createProjectWorkspace,
  getHierarchyProjectById,
  listHierarchyProjects,
  listProjectWorkspaces,
  setPrimaryProjectWorkspace,
  updateHierarchyProject,
} from "@/lib/hierarchy/projects";
import type { HierarchyProject } from "@/lib/hierarchy/projects";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const StatusSchema = z.enum(["planned", "in_progress", "blocked", "done", "cancelled"]);

const CreateProjectSchema = z.object({
  organizationId: z.string().min(1).optional().nullable(),
  name: z.string().min(1).max(160),
  description: z.string().max(1200).optional().nullable(),
  goalIds: z.array(z.string().min(1).max(160)).max(32).optional(),
  status: StatusSchema.optional().nullable(),
});

const UpdateProjectSchema = CreateProjectSchema.partial().extend({
  id: z.string().min(1),
  primaryWorkspaceId: z.string().min(1).optional().nullable(),
});

const CreateWorkspaceSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(120),
  cwd: z.string().max(1000).optional().nullable(),
  repoUrl: z.string().max(1000).optional().nullable(),
  repoRef: z.string().max(240).optional().nullable(),
  isPrimary: z.boolean().optional(),
});

const PrimaryWorkspaceSchema = z.object({
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
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
      const project = getHierarchyProjectById(id);
      if (!project) return NextResponse.json({ success: false, error: `Project not found: ${id}` }, { status: 404 });
      return NextResponse.json({
        success: true,
        data: {
          ...project,
          workspaces: listProjectWorkspaces(project.id),
        },
      });
    }
    const workspaceProjectId = searchParams.get("workspacesFor");
    if (workspaceProjectId) {
      return NextResponse.json({ success: true, data: listProjectWorkspaces(workspaceProjectId) });
    }
    return NextResponse.json({
      success: true,
      data: listHierarchyProjects({
        organizationId: searchParams.get("organizationId") || undefined,
        goalId: searchParams.get("goalId") || undefined,
        includeDone: searchParams.get("includeDone") === "1" || searchParams.get("includeDone") === "true",
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
    const body = await request.json();
    if (body?.action === "workspace") {
      const parsed = CreateWorkspaceSchema.parse(body);
      return NextResponse.json({ success: true, data: createProjectWorkspace(parsed) }, { status: 201 });
    }
    const parsed = CreateProjectSchema.parse(body);
    return NextResponse.json({ success: true, data: createHierarchyProject(parsed) }, { status: 201 });
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
    if (body?.action === "set-primary-workspace") {
      const parsed = PrimaryWorkspaceSchema.parse(body);
      return NextResponse.json({ success: true, data: setPrimaryProjectWorkspace(parsed.projectId, parsed.workspaceId) });
    }
    const parsed = UpdateProjectSchema.parse(body);
    const { id, ...updates } = parsed;
    const cleanUpdates: Partial<Pick<HierarchyProject, "name" | "description" | "goalIds" | "status" | "primaryWorkspaceId">> = {};
    if (updates.name !== undefined) cleanUpdates.name = updates.name;
    if (updates.description !== undefined) cleanUpdates.description = updates.description;
    if (updates.goalIds !== undefined) cleanUpdates.goalIds = updates.goalIds;
    if (updates.status != null) cleanUpdates.status = updates.status;
    if (updates.primaryWorkspaceId !== undefined) cleanUpdates.primaryWorkspaceId = updates.primaryWorkspaceId;
    return NextResponse.json({ success: true, data: updateHierarchyProject(id, cleanUpdates) });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    return NextResponse.json({ success: false, error: String(error) }, { status: errorStatus(error) });
  }
}
