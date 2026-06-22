import { NextRequest, NextResponse } from "next/server";
import { buildSandboxedPreviewHtml } from "@/lib/design-studio/html";
import { getDesignArtifactById } from "@/lib/design-studio/store";
import { jsonError, prepareDesignApi, safeDesignIdFromParams } from "@/lib/design-studio/api";

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const artifact = getDesignArtifactById(safeDesignIdFromParams(ctx.params));
    if (!artifact) return jsonError("Design artifact not found", 404);
    return new NextResponse(buildSandboxedPreviewHtml(artifact.currentSource), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return jsonError(error, 400);
  }
}
