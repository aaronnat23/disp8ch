import { NextRequest, NextResponse } from "next/server";
import { deleteDocument, getDocumentById } from "@/lib/documents/store";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: { id: string } },
) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const id = context.params.id;
    const record = getDocumentById(id);
    if (!record) {
      return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: record });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: { id: string } },
) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const id = context.params.id;
    const deleted = deleteDocument(id);
    if (!deleted) {
      return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
