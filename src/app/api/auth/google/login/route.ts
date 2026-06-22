import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { generatePkce } from "@/lib/google-oauth";

/**
 * GET /api/auth/google/login
 * Initiates the Google OAuth2 flow for SSO.
 */
export async function GET() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "GOOGLE_CLIENT_ID not configured" },
      { status: 500 }
    );
  }

  // Generate PKCE
  const { verifier, challenge, state } = generatePkce();

  // Store verifier and state in cookies for callback validation
  // expires in 10 minutes
  const expiry = new Date(Date.now() + 10 * 60 * 1000);
  cookies().set("google_oauth_verifier", verifier, { 
    httpOnly: true, 
    secure: process.env.NODE_ENV === "production", 
    sameSite: "lax", 
    expires: expiry 
  });
  cookies().set("google_oauth_state", state, { 
    httpOnly: true, 
    secure: process.env.NODE_ENV === "production", 
    sameSite: "lax", 
    expires: expiry 
  });

  const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
  const host = process.env.NEXT_PUBLIC_APP_URL || "localhost:3100";
  const redirectUri = `${protocol}://${host}/api/auth/google/callback`;

  // Build the Google OAuth URL
  const scopes = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/userinfo.email",
  ];

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "online",
    prompt: "select_account",
  });

  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  return NextResponse.redirect(url);
}
