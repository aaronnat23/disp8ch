import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import {
  createNotebook,
  createNotebookTransformation,
  listNotebookTransformations,
  listNotebooks,
} from "@/lib/notebooks/store";

export const dynamic = "force-dynamic";

function badRequest(message: string) {
  return NextResponse.json({ success: false, error: message }, { status: 400 });
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    if (searchParams.get("transformations") === "1") {
      return NextResponse.json({ success: true, data: listNotebookTransformations() });
    }
    return NextResponse.json({ success: true, data: listNotebooks() });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || "create").trim().toLowerCase();

    if (action === "create-transformation" || action === "create_transformation") {
      const name = String(body.name || "").trim();
      const prompt = String(body.prompt || "").trim();
      if (!name || !prompt) return badRequest("name and prompt are required");
      const data = createNotebookTransformation({
        name,
        prompt,
        applyOnIngest: Boolean(body.applyOnIngest),
      });
      return NextResponse.json({ success: true, data }, { status: 201 });
    }

    const name = String(body.name || "").trim();
    if (!name) return badRequest("name is required");
    const data = createNotebook({
      name,
      description: typeof body.description === "string" ? body.description : null,
      settings: body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
        ? body.settings as Record<string, unknown>
        : undefined,
    });
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

