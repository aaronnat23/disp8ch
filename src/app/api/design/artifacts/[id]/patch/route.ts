import { NextRequest } from "next/server";
import { applyDesignPatch, type DesignPatch } from "@/lib/design-studio/patches";
import { getDesignArtifactById, recordDesignPatch, saveDesignArtifactVersion } from "@/lib/design-studio/store";
import { jsonError, jsonOk, prepareDesignApi, safeDesignIdFromParams } from "@/lib/design-studio/api";

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const artifactId = safeDesignIdFromParams(ctx.params);
    const artifact = getDesignArtifactById(artifactId);
    if (!artifact) return jsonError("Design artifact not found", 404);
    const body = await req.json();
    const patch = body.patch as DesignPatch;
    const html = applyDesignPatch(artifact.currentSource, patch);
    const updated = saveDesignArtifactVersion({
      artifactId,
      html,
      summary: body.summary == null ? `Applied patch: ${patch.kind}` : String(body.summary),
      createdBy: "patch",
    });
    const record = recordDesignPatch({
      artifactId,
      versionBeforeId: artifact.currentVersionId,
      versionAfterId: updated.currentVersionId,
      patchKind: patch.kind,
      label: body.summary == null ? `Applied patch: ${patch.kind}` : String(body.summary),
      patch,
      source: body.source == null ? "manual" : String(body.source),
      sessionId: body.sessionId == null ? null : String(body.sessionId),
    });
    return jsonOk({ artifact: updated, patch, record });
  } catch (error) {
    return jsonError(error, 400);
  }
}
