import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { initializeDatabase } from "@/lib/db";
import {
  createWorkflowCredential,
  deleteWorkflowCredential,
  listWorkflowCredentials,
  testCredential,
  toPublicWorkflowCredential,
  updateWorkflowCredential,
} from "@/lib/workflows/credentials";
import { listWorkflowCredentialAdapters } from "@/lib/workflows/credential-adapters";
import { requireOperatorAccess } from "@/lib/security/admin";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";
import { sanitizeStructuredJson } from "@/lib/security/json";

const credentialSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: z.string().min(1).max(160),
    serviceType: z.string().min(1).max(80),
    secretValue: z.string().min(1).max(16_384),
    metadataJson: z.string().max(16_384).optional().nullable(),
  }),
  z.object({
    action: z.literal("update"),
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(160).optional(),
    serviceType: z.string().min(1).max(80).optional(),
    metadataJson: z.string().max(16_384).optional().nullable(),
  }),
  z.object({
    action: z.literal("delete"),
    id: z.string().min(1).max(128),
  }),
  z.object({
    action: z.literal("test"),
    id: z.string().min(1).max(128),
  }),
]);

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    initializeDatabase();
    return NextResponse.json({
      success: true,
      data: listWorkflowCredentials().map(toPublicWorkflowCredential),
      adapters: listWorkflowCredentialAdapters(),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    initializeDatabase();
    const body = await readCappedJson<unknown>(request, 64 * 1024);
    const parsed = credentialSchema.parse(sanitizeStructuredJson(body));
    if (parsed.action === "create") {
      const credential = createWorkflowCredential({
        name: parsed.name,
        serviceType: parsed.serviceType,
        secretValue: parsed.secretValue,
        metadataJson: parsed.metadataJson ?? null,
      });
      return NextResponse.json({ success: true, data: toPublicWorkflowCredential(credential) });
    }
    if (parsed.action === "update") {
      const credential = updateWorkflowCredential(parsed.id, {
        name: parsed.name,
        serviceType: parsed.serviceType,
        metadataJson: parsed.metadataJson,
      });
      if (!credential) {
        return NextResponse.json({ success: false, error: "Credential not found" }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: toPublicWorkflowCredential(credential) });
    }
    if (parsed.action === "delete") {
      deleteWorkflowCredential(parsed.id);
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ success: true, data: await testCredential(parsed.id) });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
