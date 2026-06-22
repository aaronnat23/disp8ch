import { NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/security/session";
import { timingSafeStringEqual } from "@/lib/security/timing-safe";
import { getClientIp } from "@/lib/utils/rate-limit";
import { getSecurityRuntimeConfig } from "@/lib/security/runtime-config";

export const ADMIN_TOKEN_HEADER = "x-disp8ch-admin-token";

function normalizeHost(raw: string | null | undefined): string {
  return String(raw || "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
}

export function isLoopbackHostname(raw: string | null | undefined): boolean {
  const host = normalizeHost(raw);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function isLoopbackRemoteAddress(raw: string | null | undefined): boolean {
  const value = String(raw || "").trim().toLowerCase();
  return (
    value === "::1" ||
    value === "::ffff:127.0.0.1" ||
    value === "127.0.0.1" ||
    value.startsWith("::ffff:127.0.0.")
  );
}

export function resolveRequestHostname(request: Request): string {
  const headerHost = request.headers.get("host");
  if (headerHost) return normalizeHost(headerHost);
  try {
    return normalizeHost(new URL(request.url).hostname);
  } catch {
    return "";
  }
}

function resolveAdminTokenCandidate(request: Request): string | null {
  const headerToken = request.headers.get(ADMIN_TOKEN_HEADER);
  if (headerToken) return headerToken.trim();

  const authHeader = request.headers.get("authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  try {
    const search = new URL(request.url).searchParams.get("adminToken");
    return search?.trim() || null;
  } catch {
    return null;
  }
}

type AccessRequirement = {
  allowLoopbackWithoutConfiguredAdminToken: boolean;
  errorMessage: string;
};

type FailedAuthState = {
  failures: number;
  blockedUntil: number;
};

const failedAuthAttempts = new Map<string, FailedAuthState>();

function getAuthBackoffKey(request: Request): string {
  return `${getClientIp(request)}:${resolveRequestHostname(request)}`;
}

function getBlockedRetryAfterMs(key: string): number {
  const state = failedAuthAttempts.get(key);
  if (!state) return 0;
  return Math.max(0, state.blockedUntil - Date.now());
}

function registerFailedAuthAttempt(key: string): number {
  const previous = failedAuthAttempts.get(key);
  const failures = (previous?.failures || 0) + 1;
  const delayMs =
    failures <= 3
      ? 0
      : failures === 4
        ? 5_000
        : failures === 5
          ? 15_000
          : Math.min(300_000, 30_000 * Math.max(1, failures - 5));
  failedAuthAttempts.set(key, {
    failures,
    blockedUntil: Date.now() + delayMs,
  });
  return delayMs;
}

function clearFailedAuthAttempt(key: string): void {
  failedAuthAttempts.delete(key);
}

async function requireAccess(
  request: Request,
  requirement: AccessRequirement,
): Promise<NextResponse | null> {
  const securityConfig = getSecurityRuntimeConfig();
  const authKey = getAuthBackoffKey(request);
  if (securityConfig.operatorAuthBackoffEnabled) {
    const retryAfterMs = getBlockedRetryAfterMs(authKey);
    if (retryAfterMs > 0) {
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      return NextResponse.json(
        {
          success: false,
          error: `Too many failed operator/admin auth attempts. Retry in ${retryAfterSeconds}s.`,
        },
        {
          status: 429,
          headers: { "retry-after": String(retryAfterSeconds) },
        },
      );
    }
  }

  const configuredAdminToken = String(process.env.DISP8CH_ADMIN_TOKEN || "").trim();
  const suppliedToken = resolveAdminTokenCandidate(request);
  if (configuredAdminToken && timingSafeStringEqual(suppliedToken, configuredAdminToken)) {
    clearFailedAuthAttempt(authKey);
    return null;
  }

  const sessionUser = await getUserFromRequest(request);
  if (sessionUser) {
    clearFailedAuthAttempt(authKey);
    return null;
  }

  if (
    requirement.allowLoopbackWithoutConfiguredAdminToken &&
    !securityConfig.disableLoopbackBypass &&
    securityConfig.installPosture !== "exposed" &&
    !configuredAdminToken &&
    isLoopbackHostname(resolveRequestHostname(request))
  ) {
    clearFailedAuthAttempt(authKey);
    return null;
  }

  if (securityConfig.operatorAuthBackoffEnabled) {
    registerFailedAuthAttempt(authKey);
  }

  return NextResponse.json(
    {
      success: false,
      error: requirement.errorMessage,
    },
    { status: 401 },
  );
}

export async function requireOperatorAccess(request: Request): Promise<NextResponse | null> {
  return requireAccess(request, {
    allowLoopbackWithoutConfiguredAdminToken: true,
    errorMessage: `Operator access required. Sign in or provide ${ADMIN_TOKEN_HEADER}.`,
  });
}

export async function requireAdminAccess(request: Request): Promise<NextResponse | null> {
  return requireAccess(request, {
    allowLoopbackWithoutConfiguredAdminToken: true,
    errorMessage: `Admin access required. Sign in or provide ${ADMIN_TOKEN_HEADER}.`,
  });
}
