import { NextRequest } from "next/server";
import { rollbackDesignArtifactToVersion } from "@/lib/design-studio/store";
import { jsonError, jsonOk, prepareDesignApi, safeDesignIdFromParams } from "@/lib/design-studio/api";

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const artifactId = safeDesignIdFromParams(ctx.params);
    const body = await req.json().catch(() => ({}));
    const versionNumber = Number(body.versionNumber ?? body.version);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      return jsonError("versionNumber is required", 400);
    }
    const artifact = rollbackDesignArtifactToVersion(artifactId, versionNumber, "rollback");
    return jsonOk({ artifact, rolledBackTo: versionNumber });
  } catch (error) {
    return jsonError(error, 400);
  }
}
