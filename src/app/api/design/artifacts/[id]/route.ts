import { NextRequest } from "next/server";
import { getDesignArtifactById } from "@/lib/design-studio/store";
import { jsonError, jsonOk, prepareDesignApi, safeDesignIdFromParams } from "@/lib/design-studio/api";

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const artifact = getDesignArtifactById(safeDesignIdFromParams(ctx.params));
    if (!artifact) return jsonError("Design artifact not found", 404);
    return jsonOk(artifact);
  } catch (error) {
    return jsonError(error, 400);
  }
}
