function normalizeLoopbackHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized === "[::1]" || normalized === "::1" || normalized === "127.0.0.1") {
    return "localhost";
  }
  return normalized;
}

function hostnameFromOrigin(value: string): string | null {
  try {
    return normalizeLoopbackHostname(new URL(value).hostname);
  } catch {
    return null;
  }
}

export function parseAllowedOriginHostnames(values: Iterable<string>): Set<string> {
  const allowed = new Set<string>(["localhost"]);
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const hostname =
      hostnameFromOrigin(trimmed) ??
      normalizeLoopbackHostname(trimmed.replace(/^https?:\/\//i, "").split("/")[0] || trimmed);
    if (hostname) allowed.add(hostname);
  }
  return allowed;
}

export function getConfiguredAllowedOriginHostnames(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return parseAllowedOriginHostnames(
    [env.DISP8CH_ALLOWED_ORIGINS ?? "", env.WS_ALLOWED_ORIGINS ?? ""]
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function isAllowedBrowserOrigin(params: {
  origin: string | null | undefined;
  requestHost: string | null | undefined;
  allowedOriginHostnames?: Set<string>;
}): boolean {
  const origin = params.origin?.trim();
  if (!origin) return true;

  const originHost = hostnameFromOrigin(origin);
  if (!originHost) return false;

  const requestHost = normalizeLoopbackHostname(String(params.requestHost ?? "").split(":")[0] || "");
  if (originHost === requestHost) return true;

  const allowedHostnames = params.allowedOriginHostnames ?? getConfiguredAllowedOriginHostnames();
  return allowedHostnames.has(originHost);
}

export function isCrossSiteBrowserWriteRequest(headers: Headers): boolean {
  const secFetchSite = String(headers.get("sec-fetch-site") || "").trim().toLowerCase();
  if (secFetchSite === "cross-site") return true;
  const origin = headers.get("origin");
  return Boolean(origin);
}
