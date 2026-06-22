import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { listProviderAuthConfigs } from "@/lib/agents/provider-auth-registry";
import {
  deleteProviderOAuthToken,
  listProviderOAuthTokenMeta,
  resolveProviderOAuthCredential,
  upsertProviderOAuthToken,
} from "@/lib/agents/provider-oauth";

export const dynamic = "force-dynamic";

const UpsertSchema = z.object({
  provider: z.string().min(1),
  accountLabel: z.string().nullable().optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().nullable().optional(),
  expiresAt: z.number().int().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
  scopes: z.array(z.string()).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "status";
    if (action === "registry") {
      return NextResponse.json({ success: true, data: listProviderAuthConfigs() });
    }
    if (action === "resolve") {
      const provider = searchParams.get("provider") || "";
      const resolved = resolveProviderOAuthCredential(provider);
      return NextResponse.json({
        success: true,
        data: {
          provider: resolved.provider,
          baseUrl: resolved.baseUrl ?? null,
          headers: resolved.headers,
          source: resolved.source,
          accountLabel: resolved.accountLabel ?? null,
          expiresAt: resolved.expiresAt ?? null,
          hasToken: Boolean(resolved.apiKey),
        },
      });
    }
    return NextResponse.json({
      success: true,
      data: {
        registry: listProviderAuthConfigs(),
        tokens: listProviderOAuthTokenMeta(),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const parsed = UpsertSchema.parse(body);
    const meta = upsertProviderOAuthToken(parsed);
    return NextResponse.json({ success: true, data: meta });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || "";
    const deleted = deleteProviderOAuthToken(provider);
    return NextResponse.json({ success: true, data: { deleted } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 400 });
  }
}
