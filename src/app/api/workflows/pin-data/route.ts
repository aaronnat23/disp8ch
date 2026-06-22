import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { initializeDatabase } from "@/lib/db";
import { deletePinnedData, disablePinnedData, listPinnedData, upsertPinnedData } from "@/lib/workflows/pin-data";
import { requireOperatorAccess } from "@/lib/security/admin";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";
import { sanitizeStructuredJson } from "@/lib/security/json";

const pinDataSchema = z.object({
  workflowId: z.string().min(1).max(128),
  nodeId: z.string().min(1).max(128),
  data: z.unknown(),
});

const pinUpdateSchema = z.object({
  workflowId: z.string().min(1).max(128),
  nodeId: z.string().min(1).max(128),
  enabled: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    initializeDatabase();
    const workflowId = new URL(request.url).searchParams.get("workflowId") || "";
    if (!workflowId) {
      return NextResponse.json({ success: false, error: "Missing workflowId" }, { status: 400 });
    }
    return NextResponse.json({ success: true, data: listPinnedData(workflowId) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    initializeDatabase();
    const body = await readCappedJson<unknown>(request, 128 * 1024);
    const parsed = pinDataSchema.parse(sanitizeStructuredJson(body));
    const data = upsertPinnedData(parsed.workflowId, parsed.nodeId, parsed.data);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    initializeDatabase();
    const body = await readCappedJson<unknown>(request, 32 * 1024);
    const parsed = pinUpdateSchema.parse(sanitizeStructuredJson(body));
    if (parsed.enabled === false) {
      disablePinnedData(parsed.workflowId, parsed.nodeId);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    initializeDatabase();
    const params = new URL(request.url).searchParams;
    const workflowId = params.get("workflowId") || "";
    const nodeId = params.get("nodeId") || "";
    if (!workflowId || !nodeId) {
      return NextResponse.json({ success: false, error: "Missing workflowId or nodeId" }, { status: 400 });
    }
    deletePinnedData(workflowId, nodeId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
