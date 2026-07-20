import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { decodeProjectArtifactId } from "@/lib/publishing/gate";
import { getArtifactDeployments, listProviderStatus, publishArtifact } from "@/lib/publishing/service";

export const dynamic = "force-dynamic";

const SourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("design"), artifactId: z.string().min(1).max(160), versionId: z.string().min(1).max(160) }),
  z.object({ type: z.literal("project"), projectId: z.string().min(1).max(160), outputPath: z.string().trim().min(1).max(500) }),
]);
const PublishSchema = z.object({
  source: SourceSchema,
  providerId: z.string().min(1).max(80),
  visibility: z.enum(["public", "protected"]).default("public"),
  expiresAt: z.string().datetime().nullable().optional(),
  workTrailId: z.string().max(200).nullable().optional(),
  supervisedRunId: z.string().max(200).nullable().optional(),
  confirmed: z.literal(true),
});

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const artifactId = url.searchParams.get("artifactId");
  const projectId = url.searchParams.get("projectId");
  const outputPath = url.searchParams.get("outputPath");
  const deployments = artifactId
    ? getArtifactDeployments(artifactId)
    : projectId && outputPath
      ? getArtifactDeployments(`project:${projectId}:${Buffer.from(outputPath, "utf8").toString("base64url")}`)
      : [];
  return NextResponse.json({ success: true, data: { providers: await listProviderStatus(), deployments } });
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const input = PublishSchema.parse(await request.json());
    if (input.source.type === "project" && decodeProjectArtifactId(`project:${input.source.projectId}:${Buffer.from(input.source.outputPath).toString("base64url")}`) === null) throw new Error("Invalid project publish source.");
    const deployment = await publishArtifact(input);
    return NextResponse.json({ success: true, data: deployment }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof z.ZodError ? error.flatten() : String(error) }, { status: 400 });
  }
}
