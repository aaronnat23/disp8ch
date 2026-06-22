import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import {
  askNotebook,
  createNotebookNote,
  createNotebookOutput,
  deleteNotebook,
  getNotebookBundle,
  removeNotebookDocument,
  runNotebookTransformation,
  setNotebookDocument,
  updateNotebook,
} from "@/lib/notebooks/store";

export const dynamic = "force-dynamic";

function badRequest(message: string) {
  return NextResponse.json({ success: false, error: message }, { status: 400 });
}

export async function GET(request: NextRequest, context: { params: { id: string } }) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const data = getNotebookBundle(context.params.id);
    if (!data) return NextResponse.json({ success: false, error: "Notebook not found" }, { status: 404 });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: { params: { id: string } }) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const data = updateNotebook(context.params.id, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" || body.description === null ? body.description as string | null : undefined,
      settings: body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
        ? body.settings as Record<string, unknown>
        : undefined,
    });
    if (!data) return NextResponse.json({ success: false, error: "Notebook not found" }, { status: 404 });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: { params: { id: string } }) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const ok = deleteNotebook(context.params.id);
    if (!ok) return NextResponse.json({ success: false, error: "Notebook not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: { id: string } }) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || "").trim().toLowerCase();
    const notebookId = context.params.id;

    if (action === "add-document" || action === "set-document" || action === "add_document") {
      const documentId = String(body.documentId || "").trim();
      if (!documentId) return badRequest("documentId is required");
      const data = setNotebookDocument({
        notebookId,
        documentId,
        contextMode: body.contextMode as any,
      });
      return NextResponse.json({ success: true, data });
    }

    if (action === "remove-document" || action === "remove_document") {
      const documentId = String(body.documentId || "").trim();
      if (!documentId) return badRequest("documentId is required");
      return NextResponse.json({ success: true, data: { removed: removeNotebookDocument(notebookId, documentId) } });
    }

    if (action === "note" || action === "create-note" || action === "create_note") {
      const contentMd = String(body.contentMd || body.content || "").trim();
      if (!contentMd) return badRequest("contentMd is required");
      const data = createNotebookNote({
        notebookId,
        title: String(body.title || "Notebook Note"),
        contentMd,
        origin: body.origin as any,
      });
      return NextResponse.json({ success: true, data }, { status: 201 });
    }

    if (action === "ask") {
      const query = String(body.query || "").trim();
      if (!query) return badRequest("query is required");
      const data = await askNotebook({ notebookId, query, limit: Number(body.limit) || 6 });
      return NextResponse.json({ success: true, data });
    }

    if (action === "transform" || action === "run-transformation") {
      const documentId = String(body.documentId || "").trim();
      const transformationId = String(body.transformationId || "").trim();
      if (!documentId || !transformationId) return badRequest("documentId and transformationId are required");
      const data = runNotebookTransformation({ notebookId, documentId, transformationId });
      return NextResponse.json({ success: true, data }, { status: 201 });
    }

    if (action === "output" || action === "create-output" || action === "generate-output") {
      const type = String(body.type || "mind_map") as any;
      const data = await createNotebookOutput({
        notebookId,
        type,
        title: typeof body.title === "string" ? body.title : undefined,
        query: typeof body.query === "string" ? body.query : undefined,
      });
      return NextResponse.json({ success: true, data }, { status: 201 });
    }

    return badRequest("Unknown notebook action");
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

