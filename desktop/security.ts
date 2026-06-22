/**
 * Pure, testable helpers for Electron desktop hardening (Phase 0).
 *
 * These functions contain no Electron imports so they can be unit-tested by
 * `scripts/desktop-hardening-regression.ts` without spawning a browser window.
 * The Electron wiring in main.ts / window.ts / preload.ts delegates the actual
 * decisions to the classifiers here.
 */

/** Canonical IPC channels (without prefix). */
export const DESKTOP_IPC_ACTIONS = [
  "get-health",
  "run-doctor",
  "check-updates",
  "download-update",
  "restart-runtime",
  "import-database",
  "open-data-dir",
  "open-logs-dir",
  "notify",
  "set-attention",
  "open-session-window",
] as const;

export type DesktopIpcAction = (typeof DESKTOP_IPC_ACTIONS)[number];

/** New canonical channel name, e.g. `disp8ch:get-health`. */
export function canonicalChannel(action: DesktopIpcAction): string {
  return `disp8ch:${action}`;
}

/**
 * Resolve a desktop environment variable from the canonical disp8ch prefixes.
 * `name` is the suffix without prefix, e.g. "APP_ROOT" or "UPDATE_URL".
 */
export function resolveDesktopEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const candidates = [
    `DISP8CH_DESKTOP_${name}`,
    `DISP8CH_${name}`,
  ];
  for (const key of candidates) {
    const value = env[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

export type NavigationDecision = "allow" | "external" | "deny";

/**
 * Classify a page-initiated navigation (will-navigate / window.open).
 * - same-origin http(s) as the local runtime  -> allow in-app
 * - any other http(s) / mailto                 -> open externally in the OS browser
 * - everything else (file:, data:, javascript:, custom protocols) -> deny
 *
 * Programmatic main-process loadURL calls (loading/failure data: screens) do not
 * trigger navigation events, so denying `data:` here is safe and blocks XSS-style
 * in-page redirects.
 */
export function classifyNavigation(
  targetUrl: string,
  runtimeOrigin: string | null,
): NavigationDecision {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return "deny";
  }
  const protocol = target.protocol;
  if (runtimeOrigin && (protocol === "http:" || protocol === "https:")) {
    try {
      const origin = new URL(runtimeOrigin);
      if (target.protocol === origin.protocol && target.host === origin.host) {
        return "allow";
      }
    } catch {
      // fall through
    }
  }
  if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
    return "external";
  }
  return "deny";
}

/**
 * Validate that an IPC message originated from the trusted local runtime origin.
 * IPC handlers must reject any sender that is not the same http(s) origin as the
 * managed runtime.
 */
export function isTrustedIpcSender(
  senderUrl: string,
  runtimeOrigin: string | null,
): boolean {
  if (!senderUrl || !runtimeOrigin) return false;
  let sender: URL;
  let origin: URL;
  try {
    sender = new URL(senderUrl);
    origin = new URL(runtimeOrigin);
  } catch {
    return false;
  }
  if (sender.protocol !== "http:" && sender.protocol !== "https:") return false;
  return sender.protocol === origin.protocol && sender.host === origin.host;
}

/**
 * Restrictive Content-Security-Policy for the desktop shell. The Next.js app is
 * served from the local runtime origin, so only same-origin resources plus the
 * websocket runtime connection are permitted.
 */
export function desktopContentSecurityPolicy(runtimeOrigin: string | null): string {
  const wsOrigin = runtimeOrigin
    ? runtimeOrigin.replace(/^http(s?):/, (_, s) => (s ? "wss:" : "ws:"))
    : "";
  const connect = ["'self'", runtimeOrigin, wsOrigin].filter(Boolean).join(" ");
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
