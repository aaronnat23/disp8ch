import { NextRequest, NextResponse } from "next/server";
import {
  getConfiguredAllowedOriginHostnames,
  isAllowedBrowserOrigin,
  isCrossSiteBrowserWriteRequest,
} from "@/lib/security/origin";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function applySecurityHeaders(response: NextResponse, pathname: string): NextResponse {
  const isIsolatedProjectPreview = /^\/api\/projects\/[^/]+\/preview\//.test(pathname);
  response.headers.set("X-Frame-Options", isIsolatedProjectPreview ? "SAMEORIGIN" : "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  response.headers.set(
    "Content-Security-Policy",
    isIsolatedProjectPreview
      ? "default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
      : "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );

  if (
    pathname.startsWith("/api/debug") ||
    pathname.startsWith("/api/logs") ||
    pathname.startsWith("/api/secrets") ||
    pathname.startsWith("/api/auth")
  ) {
    response.headers.set("Cache-Control", "no-store");
  }

  return response;
}

function rejectCrossSiteWrite(request: NextRequest): NextResponse | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    return null;
  }
  if (!isCrossSiteBrowserWriteRequest(request.headers)) {
    return null;
  }

  const allowedOriginHostnames = getConfiguredAllowedOriginHostnames();
  if (
    isAllowedBrowserOrigin({
      origin: request.headers.get("origin"),
      requestHost: request.headers.get("host"),
      allowedOriginHostnames,
    })
  ) {
    return null;
  }

  return NextResponse.json(
    { success: false, error: "Cross-site browser write rejected" },
    { status: 403 },
  );
}

export function middleware(request: NextRequest) {
  const rejection = rejectCrossSiteWrite(request);
  if (rejection) {
    return applySecurityHeaders(rejection, request.nextUrl.pathname);
  }

  return applySecurityHeaders(NextResponse.next(), request.nextUrl.pathname);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
