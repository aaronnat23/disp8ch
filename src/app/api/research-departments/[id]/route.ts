import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getDepartmentDetail, updateDepartmentFields } from "@/lib/research-department/store";
import { deleteResearchDepartment, setDepartmentPaused } from "@/lib/research-department/setup";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const detail = getDepartmentDetail(id);
    if (!detail) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
    return NextResponse.json({ success: true, data: detail });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const detail = getDepartmentDetail(id);
    if (!detail) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
    const body = await request.json();

    if (typeof body.paused === "boolean") {
      setDepartmentPaused(id, body.paused);
    }
    if (body.name || body.focusArea || body.sources || body.delivery || body.safety || body.keywords) {
      updateDepartmentFields(id, {
        name: body.name,
        focusArea: body.focusArea,
        sourceConfig: body.sources,
        deliveryConfig: body.delivery,
        safetyConfig: body.safety,
        keywords: body.keywords,
      });
    }
    return NextResponse.json({ success: true, data: getDepartmentDetail(id) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const deleteVault = searchParams.get("deleteVault") === "1" || searchParams.get("deleteVault") === "true";
    deleteResearchDepartment(id, { deleteVault });
    return NextResponse.json({ success: true, data: { deleted: id, vaultRemoved: deleteVault } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
