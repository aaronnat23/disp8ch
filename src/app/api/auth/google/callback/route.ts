import { NextResponse, NextRequest } from "next/server";
import { cookies } from "next/headers";
import { exchangeCode } from "@/lib/google-oauth";
import { upsertGoogleUser, createSession } from "@/lib/auth";

/**
 * GET /api/auth/google/callback
 * Handles the redirect from Google, exchanges code for token, and logs in user.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const storedState = cookies().get("google_oauth_state")?.value;
  const verifier = cookies().get("google_oauth_verifier")?.value;

  // Cleanup temp cookies
  cookies().delete("google_oauth_state");
  cookies().delete("google_oauth_verifier");

  if (error) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error)}`, req.url));
  }

  if (!code || !state || !storedState || !verifier) {
    return NextResponse.redirect(new URL("/login?error=missing_parameters", req.url));
  }

  if (state !== storedState) {
    return NextResponse.redirect(new URL("/login?error=invalid_state", req.url));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL("/login?error=config_missing", req.url));
  }

  try {
    const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
    const host = process.env.NEXT_PUBLIC_APP_URL || "localhost:3100";
    const redirectUri = `${protocol}://${host}/api/auth/google/callback`;

    // 1. Exchange code for access token
    const tokenResponse = await exchangeCode(code, clientId, clientSecret, redirectUri, verifier);

    // 2. Fetch user info from Google
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
    });

    if (!userRes.ok) {
      throw new Error(`Failed to fetch user info: ${await userRes.text()}`);
    }

    const googleUser = await userRes.json();

    // 3. Upsert user in DB
    const user = await upsertGoogleUser({
      id: googleUser.id,
      email: googleUser.email,
      name: googleUser.name,
      picture: googleUser.picture,
    });

    // 4. Create session
    await createSession(user);

    // 5. Redirect to home
    return NextResponse.redirect(new URL("/", req.url));
  } catch (err) {
    console.error("OAuth callback error:", err);
    return NextResponse.redirect(new URL("/login?error=auth_failed", req.url));
  }
}
