/**
 * `disp8ch://` deep-link parsing (Phase 7). Pure + testable; the main process
 * maps the result to a window navigation or watch-window open. Only same-app
 * routes and session ids are honored — never arbitrary URLs.
 */

export const DEEPLINK_PROTOCOL = "disp8ch";

export type DeepLinkAction =
  | { action: "open-session"; sessionId: string }
  | { action: "navigate"; route: string }
  | { action: "ignore"; reason: string };

function sanitizeRoute(input: string): string {
  // Keep a leading slash, strip protocol-relative or absolute external attempts.
  let route = input.trim();
  if (!route) return "/";
  route = route.replace(/^\/+/, "/");
  if (!route.startsWith("/")) route = `/${route}`;
  // Disallow protocol/host injection.
  if (/^\/\//.test(route) || /[a-z]+:/i.test(route)) return "/";
  return route;
}

export function parseDeepLink(rawUrl: string): DeepLinkAction {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { action: "ignore", reason: "invalid-url" };
  }
  if (url.protocol !== `${DEEPLINK_PROTOCOL}:`) {
    return { action: "ignore", reason: "wrong-protocol" };
  }
  // disp8ch://session/<id>
  const host = url.hostname;
  const segments = url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));

  if (host === "session") {
    const sessionId = segments[0] || url.searchParams.get("id") || "";
    if (!sessionId) return { action: "ignore", reason: "missing-session" };
    return { action: "open-session", sessionId };
  }

  if (host === "open" || host === "route") {
    const route = sanitizeRoute(segments.join("/") || url.searchParams.get("path") || "/");
    return { action: "navigate", route };
  }

  return { action: "ignore", reason: "unknown-host" };
}

/** Extract the first disp8ch:// arg from a process argv (Windows protocol launch). */
export function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${DEEPLINK_PROTOCOL}://`)) ?? null;
}
