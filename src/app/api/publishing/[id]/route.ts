import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { revokeArtifactDeployment, updateArtifactDeployment } from "@/lib/publishing/service";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update"), confirmed: z.literal(true), supervisedRunId: z.string().nullable().optional() }),
  z.object({ action: z.literal("revoke"), confirmed: z.literal(true) }),
]);

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const input = ActionSchema.parse(await request.json());
    const deployment = input.action === "revoke"
      ? await revokeArtifactDeployment(params.id)
      : await updateArtifactDeployment({ deploymentId: params.id, versionId: "current-project-output", action: "update", supervisedRunId: input.supervisedRunId });
    return NextResponse.json({ success: true, data: deployment });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof z.ZodError ? error.flatten() : String(error) }, { status: 400 });
  }
}
