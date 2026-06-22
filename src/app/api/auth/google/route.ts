import { NextResponse } from "next/server";
import {
  getStoredToken,
  getValidAccessToken,
  deleteToken,
  revokeToken,
} from "@/lib/google-oauth";
import { requireOperatorAccess } from "@/lib/security/admin";

/**
 * GET /api/auth/google — Check OAuth status
 */
export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const stored = getStoredToken();
    if (!stored) {
      return NextResponse.json({
        success: true,
        data: { configured: false, email: null, expiresAt: null, scopes: null },
      });
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const expired = stored.expires_at ? stored.expires_at < nowSec : true;

    return NextResponse.json({
      success: true,
      data: {
        configured: true,
        email: stored.email,
        expiresAt: stored.expires_at,
        expired,
        scopes: typeof stored.scopes === "string" ? stored.scopes.split(" ").filter(Boolean) : (stored.scopes ?? []),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/auth/google — Force-refresh the access token
 */
export async function POST(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const token = await getValidAccessToken();
    if (!token) {
      return NextResponse.json(
        { success: false, error: "No valid token available. Run 'dpc auth google' to authenticate." },
        { status: 400 },
      );
    }

    const stored = getStoredToken();
    return NextResponse.json({
      success: true,
      data: {
        expiresAt: stored?.expires_at,
        email: stored?.email,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/auth/google — Revoke and delete stored token
 */
export async function DELETE(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const stored = getStoredToken();
    if (stored?.access_token) {
      try {
        await revokeToken(stored.access_token);
      } catch {
        // Best-effort revocation — token may already be invalid
      }
    }
    deleteToken();
    return NextResponse.json({ success: true, data: { message: "Google OAuth token deleted" } });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 },
    );
  }
}
