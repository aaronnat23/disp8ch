import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getArtifactDeployments, listProviderStatus, publishArtifact } from "@/lib/publishing/service";

export const dynamic = "force-dynamic";

const PublishSchema = z.object({
  artifactId: z.string().min(1).max(160),
  versionId: z.string().min(1).max(160),
  providerId: z.string().min(1).max(80),
  visibility: z.enum(["public", "protected"]),
  expiresAt: z.string().datetime().nullable().optional(),
  workTrailId: z.string().max(200).nullable().optional(),
  supervisedRunId: z.string().max(200).nullable().optional(),
  confirmed: z.literal(true),
});

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  const artifactId = new URL(request.url).searchParams.get("artifactId");
  return NextResponse.json({ success: true, data: { providers: await listProviderStatus(), deployments: artifactId ? getArtifactDeployments(artifactId) : [] } });
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const input = PublishSchema.parse(await request.json());
    const deployment = await publishArtifact(input);
    return NextResponse.json({ success: true, data: deployment }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof z.ZodError ? error.flatten() : String(error) }, { status: 400 });
  }
}
