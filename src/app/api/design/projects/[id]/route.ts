import { NextRequest } from "next/server";
import { getDesignProject } from "@/lib/design-studio/store";
import { jsonError, jsonOk, prepareDesignApi, safeDesignIdFromParams } from "@/lib/design-studio/api";

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const project = getDesignProject(safeDesignIdFromParams(ctx.params));
    if (!project) return jsonError("Design project not found", 404);
    return jsonOk(project);
  } catch (error) {
    return jsonError(error, 400);
  }
}
