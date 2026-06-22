import { NextRequest } from "next/server";
import { createDesignSystem, listDesignSystems } from "@/lib/design-studio/store";
import { jsonError, jsonOk, prepareDesignApi } from "@/lib/design-studio/api";

export async function GET(req: NextRequest) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  return jsonOk({ systems: listDesignSystems() });
}

export async function POST(req: NextRequest) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    const system = createDesignSystem({
      name: String(body.name || ""),
      category: body.category == null ? null : String(body.category),
      description: body.description == null ? null : String(body.description),
      designMd: String(body.designMd || body.design_md || ""),
      tokensCss: body.tokensCss == null ? body.tokens_css ?? null : String(body.tokensCss),
      componentsHtml: body.componentsHtml == null ? body.components_html ?? null : String(body.componentsHtml),
      source: body.source ?? { mode: "manual" },
    });
    return jsonOk(system, { status: 201 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
