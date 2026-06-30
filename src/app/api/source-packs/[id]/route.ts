import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import {
  deleteSourcePack,
  getSourcePack,
  listSourcePackChunks,
  listSourcePackItems,
} from "@/lib/source-packs/store";
import { buildProvenanceSummary, checkSourcePackDrift } from "@/lib/source-packs/provenance";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { id } = await params;
    const pack = getSourcePack(id);
    if (!pack) return NextResponse.json({ success: false, error: "source pack not found" }, { status: 404 });

    const view = request.nextUrl.searchParams.get("view");
    if (view === "drift") {
      return NextResponse.json({ success: true, data: checkSourcePackDrift(id) });
    }
    return NextResponse.json({
      success: true,
      data: {
        pack,
        items: listSourcePackItems(id),
        chunkSample: listSourcePackChunks(id, 20),
        provenance: buildProvenanceSummary(id),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { id } = await params;
    deleteSourcePack(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
