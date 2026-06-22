import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleAcpIngress } from "@/lib/acp/ingress";
import { getConfiguredIngressProvenanceMode } from "@/lib/provenance";
import { getConfiguredAcpAuthMode, getConfiguredAcpAuthSecretName, isAcpAuthConfigured, validateAcpBearerToken } from "@/lib/acp/auth";
import { findAcpSessionByLabel, getAcpSession, listAcpSessions, resetAcpSession } from "@/lib/acp/registry";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";

export const dynamic = "force-dynamic";

const AcpIngressSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
  sessionLabel: z.string().optional(),
  traceId: z.string().optional(),
  actor: z.string().optional(),
  client: z.string().optional(),
  originSessionId: z.string().optional(),
  originTraceId: z.string().optional(),
  provenanceMode: z.enum(["off", "meta", "meta+receipt"]).optional(),
  requireExisting: z.boolean().optional(),
  resetSession: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const AcpResetSchema = z.object({
  action: z.literal("reset-session"),
  sessionId: z.string().optional(),
  sessionLabel: z.string().optional(),
});

function requireAcpAuth(request: NextRequest): NextResponse | null {
  const mode = getConfiguredAcpAuthMode();
  if (mode === "off") return null;
  const authHeader = request.headers.get("authorization");
  if (!validateAcpBearerToken(authHeader)) {
    return NextResponse.json({ success: false, error: "ACP bearer auth required" }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") || "status";

  if (action === "sessions" || action === "session") {
    const denied = requireAcpAuth(request);
    if (denied) return denied;
  }

  if (action === "sessions") {
    const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit") || 50)));
    return NextResponse.json({ success: true, data: listAcpSessions(limit) });
  }

  if (action === "session") {
    const sessionId = String(searchParams.get("sessionId") || "").trim();
    if (!sessionId) {
      return NextResponse.json({ success: false, error: "Missing sessionId" }, { status: 400 });
    }
    const session = getAcpSession(sessionId);
    if (!session) {
      return NextResponse.json({ success: false, error: "ACP session not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: session });
  }

  return NextResponse.json({
    success: true,
    data: {
      endpoint: "/api/acp",
      transport: "http-json",
      provenanceMode: getConfiguredIngressProvenanceMode(),
      authMode: getConfiguredAcpAuthMode(),
      authConfigured: isAcpAuthConfigured(),
      authSecretName: getConfiguredAcpAuthSecretName(),
      notes: [
        "POST JSON with message, sessionId/sessionLabel, traceId, actor, and client.",
        "Use provenanceMode to override off/meta/meta+receipt per request.",
        "GET ?action=sessions lists ACP session bindings when auth is satisfied.",
      ],
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const denied = requireAcpAuth(request);
    if (denied) return denied;
    const body = await readCappedJson<Record<string, unknown>>(request, 128 * 1024);
    if (body?.action === "reset-session") {
      const parsedReset = AcpResetSchema.parse(body);
      const reset = resetAcpSession(parsedReset);
      if (!reset) {
        return NextResponse.json({ success: false, error: "ACP session not found" }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: reset });
    }
    const parsed = AcpIngressSchema.parse(body);
    const rebound = !parsed.sessionId && parsed.sessionLabel
      ? findAcpSessionByLabel(parsed.sessionLabel)
      : null;
    const result = await handleAcpIngress({
      ...parsed,
      sessionId: parsed.sessionId ?? rebound?.sessionId,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 400 });
  }
}
