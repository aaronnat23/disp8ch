import { NextRequest } from "next/server";
import { getDesignSystem } from "@/lib/design-studio/store";
import { jsonError, jsonOk, prepareDesignApi, safeDesignIdFromParams } from "@/lib/design-studio/api";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const system = getDesignSystem(safeDesignIdFromParams(await ctx.params));
    if (!system) return jsonError("Design system not found", 404);
    return jsonOk(system);
  } catch (error) {
    return jsonError(error, 400);
  }
}
