import { NextRequest } from "next/server";
import { createDesignArtifact, listDesignArtifacts } from "@/lib/design-studio/store";
import { jsonError, jsonOk, prepareDesignApi, safeDesignIdFromParams } from "@/lib/design-studio/api";

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    return jsonOk(listDesignArtifacts(safeDesignIdFromParams(ctx.params)));
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    return jsonOk(createDesignArtifact({
      projectId: safeDesignIdFromParams(ctx.params),
      title: String(body.title || ""),
      html: String(body.html || ""),
      summary: body.summary == null ? null : String(body.summary),
      sourceSessionId: body.sourceSessionId == null ? null : String(body.sourceSessionId),
      createdBy: "user",
    }));
  } catch (error) {
    return jsonError(error, 400);
  }
}
