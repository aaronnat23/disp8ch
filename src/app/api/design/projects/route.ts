import { NextRequest } from "next/server";
import { createDesignProject, listDesignProjects } from "@/lib/design-studio/store";
import { jsonError, jsonOk, prepareDesignApi } from "@/lib/design-studio/api";

export async function GET(req: NextRequest) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    return jsonOk(listDesignProjects());
  } catch (error) {
    return jsonError(error, 500);
  }
}

export async function POST(req: NextRequest) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    return jsonOk(createDesignProject({
      name: String(body.name || ""),
      description: body.description == null ? null : String(body.description),
      organizationId: body.organizationId == null ? null : String(body.organizationId),
      goalId: body.goalId == null ? null : String(body.goalId),
      sourceSessionId: body.sourceSessionId == null ? null : String(body.sourceSessionId),
    }));
  } catch (error) {
    return jsonError(error, 400);
  }
}
