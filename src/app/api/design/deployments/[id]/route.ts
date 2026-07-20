import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { configureAutoPublish, revokeArtifactDeployment, updateArtifactDeployment } from "@/lib/publishing/service";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update"), versionId: z.string().min(1), confirmed: z.literal(true), supervisedRunId: z.string().nullable().optional() }),
  z.object({ action: z.literal("rollback"), versionId: z.string().min(1), confirmed: z.literal(true) }),
  z.object({ action: z.literal("revoke"), confirmed: z.literal(true) }),
  z.object({ action: z.literal("auto_publish"), enabled: z.boolean(), confirmed: z.literal(true) }),
]);

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const input = ActionSchema.parse(await request.json());
    const deployment = input.action === "auto_publish"
      ? configureAutoPublish({ deploymentId: params.id, enabled: input.enabled, confirmed: true })
      : input.action === "revoke"
      ? await revokeArtifactDeployment(params.id)
      : await updateArtifactDeployment({ deploymentId: params.id, versionId: input.versionId, action: input.action, supervisedRunId: "supervisedRunId" in input ? input.supervisedRunId : undefined });
    return NextResponse.json({ success: true, data: deployment });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof z.ZodError ? error.flatten() : String(error) }, { status: 400 });
  }
}
