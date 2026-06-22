import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createHierarchyGoal,
  getHierarchyGoalById,
  listGoalAncestry,
  listHierarchyGoals,
  resolveHierarchyGoal,
  updateHierarchyGoal,
} from "@/lib/hierarchy/goals";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const GoalStatusSchema = z.enum(["planned", "active", "blocked", "done"]);
const GoalLevelSchema = z.enum(["vision", "mission", "objective", "key_result"]);

const CreateGoalSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(1200).optional().nullable(),
  organizationId: z.string().min(1).max(120).optional().nullable(),
  parentGoalId: z.string().min(1).max(120).optional().nullable(),
  linkedDocumentIds: z.array(z.string().min(1).max(240)).max(24).optional().nullable(),
  deliverables: z.array(z.string().min(1).max(400)).max(24).optional().nullable(),
  status: GoalStatusSchema.optional().nullable(),
  level: GoalLevelSchema.optional().nullable(),
});

const UpdateGoalSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(1200).optional().nullable(),
  organizationId: z.string().min(1).max(120).optional().nullable(),
  parentGoalId: z.string().min(1).max(120).optional().nullable(),
  linkedDocumentIds: z.array(z.string().min(1).max(240)).max(24).optional().nullable(),
  deliverables: z.array(z.string().min(1).max(400)).max(24).optional().nullable(),
  isActive: z.boolean().optional(),
  status: GoalStatusSchema.optional().nullable(),
  level: GoalLevelSchema.optional().nullable(),
});

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    const reference = searchParams.get("reference") || searchParams.get("id");
    const includeInactive = searchParams.get("includeInactive") === "1" || searchParams.get("includeInactive") === "true";
    const includeAncestry = searchParams.get("ancestry") === "1" || searchParams.get("ancestry") === "true";

    if (reference) {
      const goal =
        getHierarchyGoalById(reference) ??
        resolveHierarchyGoal(reference, organizationId || undefined);
      if (!goal) {
        return NextResponse.json({ success: false, error: `Goal not found: ${reference}` }, { status: 404 });
      }
      return NextResponse.json({
        success: true,
        data: {
          ...goal,
          ancestry: includeAncestry ? listGoalAncestry(goal.id) : undefined,
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: listHierarchyGoals({
        organizationId: organizationId || undefined,
        includeInactive,
      }),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = CreateGoalSchema.parse(body);
    const goal = createHierarchyGoal(parsed);
    return NextResponse.json({ success: true, data: goal }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    const status = String(error).includes("not found") ? 404 : 500;
    return NextResponse.json({ success: false, error: String(error) }, { status });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = UpdateGoalSchema.parse(body);
    const { id, ...updates } = parsed;
    const goal = updateHierarchyGoal(id, updates);
    return NextResponse.json({ success: true, data: goal });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    const status = String(error).includes("not found") ? 404 : 500;
    return NextResponse.json({ success: false, error: String(error) }, { status });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ success: false, error: "id required" }, { status: 400 });

    const { deleteHierarchyGoal } = await import("@/lib/hierarchy/goals");
    deleteHierarchyGoal(id);
    return NextResponse.json({ success: true, data: { deleted: id } });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
