import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  applyHierarchyOrganization,
  applyIntegrationPresetToHierarchyOrganization,
  deleteHierarchyOrganization,
  getActiveHierarchyOrganization,
  getHierarchyOrganizationById,
  listHierarchyOrganizationMembers,
  listHierarchyOrganizations,
  resolveHierarchyOrganization,
  saveCurrentHierarchyOrganization,
  saveSelectedHierarchyOrganization,
  syncActiveHierarchyOrganizationSnapshot,
} from "@/lib/hierarchy/organizations";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const SaveOrganizationSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(600).optional().nullable(),
  mission: z.string().max(1200).optional().nullable(),
  activate: z.boolean().optional(),
  memberIds: z.array(z.string().min(1)).optional(),
});

const ApplyOrganizationSchema = z.object({
  organizationId: z.string().min(1).max(120).optional(),
  organizationName: z.string().min(1).max(120).optional(),
  presetId: z.string().min(1).max(120).optional(),
}).refine((value) => Boolean(value.organizationId || value.organizationName), {
  message: "organizationId or organizationName is required",
});

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    syncActiveHierarchyOrganizationSnapshot();
    const { searchParams } = new URL(request.url);
    const reference = searchParams.get("reference") || searchParams.get("id") || undefined;
    const includeMembers = searchParams.get("members") === "1" || searchParams.get("members") === "true";
    const active = getActiveHierarchyOrganization();
    if (reference) {
      const selected = getHierarchyOrganizationById(reference) ?? resolveHierarchyOrganization(reference);
      if (!selected) {
        return NextResponse.json({ success: false, error: `Organization not found: ${reference}` }, { status: 404 });
      }
      return NextResponse.json({
        success: true,
        data: includeMembers
          ? {
              ...selected,
              members: listHierarchyOrganizationMembers(selected.id),
              activeOrganizationId: active?.id ?? null,
            }
          : {
              ...selected,
              activeOrganizationId: active?.id ?? null,
            },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        organizations: listHierarchyOrganizations(),
        activeOrganizationId: active?.id ?? null,
        activeOrganization: active
          ? {
              id: active.id,
              name: active.name,
              description: active.description,
              mission: active.mission,
              memberCount: active.memberCount,
              isActive: true,
              createdAt: active.createdAt,
              updatedAt: active.updatedAt,
            }
          : null,
      },
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
    const parsed = SaveOrganizationSchema.parse(body);
    const organization = parsed.memberIds
      ? saveSelectedHierarchyOrganization({ ...parsed, memberIds: parsed.memberIds })
      : saveCurrentHierarchyOrganization(parsed);
    return NextResponse.json({ success: true, data: organization }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = ApplyOrganizationSchema.parse(body);
    const reference = parsed.organizationId || parsed.organizationName;
    if (!reference) return NextResponse.json({ success: false, error: "organizationId or organizationName is required" }, { status: 400 });
    if (parsed.presetId) {
      const result = applyIntegrationPresetToHierarchyOrganization(reference, parsed.presetId);
      return NextResponse.json({ success: true, data: result });
    }
    const organization = applyHierarchyOrganization(reference);
    return NextResponse.json({ success: true, data: organization });
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
    const reference = searchParams.get("reference") || searchParams.get("id") || searchParams.get("name");
    if (!reference) {
      return NextResponse.json({ success: false, error: "reference is required" }, { status: 400 });
    }
    deleteHierarchyOrganization(reference);
    return NextResponse.json({ success: true });
  } catch (error) {
    const status = String(error).includes("not found") ? 404 : 400;
    return NextResponse.json({ success: false, error: String(error) }, { status });
  }
}
