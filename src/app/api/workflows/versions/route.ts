import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { initializeDatabase } from "@/lib/db";
import {
  diffWorkflowVersions,
  listWorkflowVersions,
  restoreWorkflowVersion,
  snapshotWorkflowVersion,
} from "@/lib/workflows/versions";
import { requireOperatorAccess } from "@/lib/security/admin";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";
import { sanitizeStructuredJson } from "@/lib/security/json";

const snapshotSchema = z.object({
  action: z.literal("snapshot"),
  workflowId: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  description: z.string().max(1000).optional().nullable(),
  nodes: z.array(z.any()),
  edges: z.array(z.any()),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const restoreSchema = z.object({
  action: z.literal("restore"),
  versionId: z.string().min(1).max(128),
});

const diffSchema = z.object({
  action: z.literal("diff"),
  versionIdA: z.string().min(1).max(128),
  versionIdB: z.string().min(1).max(128),
});

const bodySchema = z.discriminatedUnion("action", [snapshotSchema, restoreSchema, diffSchema]);

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    initializeDatabase();
    const workflowId = new URL(request.url).searchParams.get("workflowId") || "";
    if (!workflowId) {
      return NextResponse.json({ success: false, error: "Missing workflowId" }, { status: 400 });
    }
    return NextResponse.json({ success: true, data: listWorkflowVersions(workflowId) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    initializeDatabase();
    const body = await readCappedJson<unknown>(request, 512 * 1024);
    const parsed = bodySchema.parse(sanitizeStructuredJson(body));
    if (parsed.action === "snapshot") {
      const version = snapshotWorkflowVersion({
        workflowId: parsed.workflowId,
        name: parsed.name,
        description: parsed.description ?? null,
        nodes: parsed.nodes,
        edges: parsed.edges,
        metadata: parsed.metadata ?? null,
      });
      return NextResponse.json({ success: true, data: version });
    }
    if (parsed.action === "restore") {
      const version = restoreWorkflowVersion(parsed.versionId);
      if (!version) {
        return NextResponse.json({ success: false, error: "Version not found" }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: version });
    }
    const diff = diffWorkflowVersions(parsed.versionIdA, parsed.versionIdB);
    if (!diff) {
      return NextResponse.json({ success: false, error: "Version not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: diff });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
