import { NextRequest } from "next/server";
import { listDesignRecipes } from "@/lib/design-studio/recipes";
import { jsonOk, prepareDesignApi } from "@/lib/design-studio/api";

export async function GET(req: NextRequest) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  return jsonOk({ recipes: listDesignRecipes() });
}
