import { NextRequest } from "next/server";
import { listDesignArtifactVersions } from "@/lib/design-studio/store";
import { jsonError, jsonOk, prepareDesignApi, safeDesignIdFromParams } from "@/lib/design-studio/api";

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    return jsonOk(listDesignArtifactVersions(safeDesignIdFromParams(ctx.params)));
  } catch (error) {
    return jsonError(error, 400);
  }
}
