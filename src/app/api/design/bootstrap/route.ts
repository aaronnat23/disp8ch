import { NextRequest } from "next/server";
import { getDesignBootstrap } from "@/lib/design-studio/store";
import { jsonError, jsonOk, prepareDesignApi } from "@/lib/design-studio/api";

export async function GET(req: NextRequest) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    return jsonOk(getDesignBootstrap());
  } catch (error) {
    return jsonError(error, 500);
  }
}
