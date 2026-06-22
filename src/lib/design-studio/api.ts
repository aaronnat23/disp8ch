import { NextRequest, NextResponse } from "next/server";
import { initializeDatabase } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { assertSafeDesignId } from "@/lib/design-studio/paths";

export async function prepareDesignApi(req: NextRequest): Promise<NextResponse | null> {
  const denied = await requireOperatorAccess(req);
  if (denied) return denied;
  initializeDatabase();
  return null;
}

export function jsonOk(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json({ success: true, data }, init);
}

export function jsonError(error: unknown, status = 400): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ success: false, error: message }, { status });
}

export function safeDesignIdFromParams(params: Record<string, string | string[] | undefined>, key = "id"): string {
  const value = params[key];
  return assertSafeDesignId(Array.isArray(value) ? value[0] : String(value || ""));
}
