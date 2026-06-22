import { NextRequest } from "next/server";
import { getDesignArtifactById, saveDesignArtifactVersion } from "@/lib/design-studio/store";
import { jsonError, jsonOk, prepareDesignApi, safeDesignIdFromParams } from "@/lib/design-studio/api";

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const artifact = getDesignArtifactById(safeDesignIdFromParams(ctx.params));
    if (!artifact) return jsonError("Design artifact not found", 404);
    return jsonOk({ artifact, source: artifact.currentSource, validation: artifact.validation });
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function PUT(req: NextRequest, ctx: { params: { id: string } }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    const artifact = saveDesignArtifactVersion({
      artifactId: safeDesignIdFromParams(ctx.params),
      html: String(body.html || ""),
      summary: body.summary == null ? "Manual source save" : String(body.summary),
      createdBy: "user",
    });
    return jsonOk(artifact);
  } catch (error) {
    return jsonError(error, 400);
  }
}
