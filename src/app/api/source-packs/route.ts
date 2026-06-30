import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { listSourcePacks } from "@/lib/source-packs/store";
import {
  buildSourcePackFromDocuments,
  buildSourcePackFromFolder,
} from "@/lib/source-packs/build";
import { resolveWorkspacePath } from "@/lib/source-packs/workspace";

export const dynamic = "force-dynamic";

const CreateFromDocsSchema = z.object({
  mode: z.literal("documents"),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional().nullable(),
  documentIds: z.array(z.string().min(1).max(240)).min(1).max(100),
  originType: z.enum(["document", "notebook", "mixed"]).optional(),
  createdBySurface: z.enum(["documents", "webchat", "skills", "design"]).optional(),
});

const CreateFromFolderSchema = z.object({
  mode: z.literal("folder"),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional().nullable(),
  folderPath: z.string().min(1).max(1024),
  createdBySurface: z.enum(["documents", "webchat", "skills", "design"]).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const limit = Number(request.nextUrl.searchParams.get("limit")) || 100;
    return NextResponse.json({ success: true, data: listSourcePacks(limit) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    if (body?.mode === "folder") {
      const parsed = CreateFromFolderSchema.parse(body);
      // Folder ingestion is bounded to configured workspace/import roots unless
      // explicitly confirmed; this prevents "learn this folder" from reaching
      // arbitrary filesystem paths.
      const resolution = resolveWorkspacePath(parsed.folderPath, body?.confirmOutsideWorkspace === true);
      if (!resolution.allowed) {
        return NextResponse.json(
          { success: false, error: resolution.reason, requiresConfirmation: resolution.requiresConfirmation },
          { status: 400 },
        );
      }
      const result = buildSourcePackFromFolder({
        name: parsed.name,
        description: parsed.description ?? null,
        folderPath: resolution.path,
        createdBySurface: parsed.createdBySurface,
      });
      return NextResponse.json({ success: true, data: result }, { status: 201 });
    }

    const parsed = CreateFromDocsSchema.parse(body);
    const result = buildSourcePackFromDocuments({
      name: parsed.name,
      description: parsed.description ?? null,
      documentIds: parsed.documentIds,
      originType: parsed.originType,
      createdBySurface: parsed.createdBySurface,
    });
    return NextResponse.json({ success: true, data: result }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
