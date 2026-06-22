import { NextRequest } from "next/server";
import { runLightweightPreviewCheck, runPlaywrightPreviewCheck } from "@/lib/design-studio/preview-checker";
import { getDesignArtifactById, listDesignValidationReports, recordDesignValidationReport } from "@/lib/design-studio/store";
import { jsonError, jsonOk, prepareDesignApi, safeDesignIdFromParams } from "@/lib/design-studio/api";

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const artifact = getDesignArtifactById(safeDesignIdFromParams(ctx.params));
    if (!artifact) return jsonError("Design artifact not found", 404);
    const body = await req.json().catch(() => ({}));
    const visual = body.visual !== false;
    const report = visual
      ? await runPlaywrightPreviewCheck(artifact.currentSource)
      : runLightweightPreviewCheck(artifact.currentSource);
    const stored = artifact.currentVersionId
      ? recordDesignValidationReport({ artifactId: artifact.id, versionId: artifact.currentVersionId, report })
      : null;
    return jsonOk({ ...report, reportId: stored ? (stored as { id?: string }).id : null });
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const denied = await prepareDesignApi(req);
  if (denied) return denied;
  try {
    const artifactId = safeDesignIdFromParams(ctx.params);
    return jsonOk({ reports: listDesignValidationReports(artifactId) });
  } catch (error) {
    return jsonError(error, 400);
  }
}
