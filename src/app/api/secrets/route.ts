import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteSecret,
  getSecretsStatus,
  listSecretsMeta,
  upsertSecret,
} from "@/lib/secrets/store";
import { logger } from "@/lib/utils/logger";
import { requireAdminAccess } from "@/lib/security/admin";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";

const log = logger.child("api:secrets");

const UpsertSchema = z.object({
  name: z.string().min(2).max(64),
  value: z.string().min(1).max(16384),
  source: z.string().max(64).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const denied = await requireAdminAccess(request);
    if (denied) return denied;
    const status = getSecretsStatus();
    const secrets = listSecretsMeta();
    return NextResponse.json({
      success: true,
      data: {
        ...status,
        secrets,
      },
    });
  } catch (error) {
    log.error("GET /api/secrets failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const denied = await requireAdminAccess(req);
    if (denied) return denied;
    const body = await readCappedJson<unknown>(req, 32 * 1024);
    const parsed = UpsertSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.message }, { status: 400 });
    }
    const saved = upsertSecret(parsed.data);
    return NextResponse.json({ success: true, data: saved });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    log.error("POST /api/secrets failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const denied = await requireAdminAccess(req);
    if (denied) return denied;
    const { searchParams } = new URL(req.url);
    const name = searchParams.get("name");
    if (!name) {
      return NextResponse.json({ success: false, error: "Missing secret name" }, { status: 400 });
    }
    const removed = deleteSecret(name);
    if (!removed) {
      return NextResponse.json({ success: false, error: "Secret not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    log.error("DELETE /api/secrets failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
