import { getSqlite, initializeDatabase } from "@/lib/db";

export type WebsitePolicyMode = "off" | "blocklist" | "allowlist";
export type WebsitePolicySurface = "browser" | "search" | "http" | "document_ingest";

export type WebsitePolicy = {
  mode: WebsitePolicyMode;
  domains: string[];
};

function normalizeHostname(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/\.+$/, "");
}

export function normalizeWebsitePolicyDomains(raw: string): string[] {
  return Array.from(
    new Set(
      String(raw || "")
        .split(/[\n,\s]+/)
        .map((value) => normalizeHostname(value))
        .filter(Boolean),
    ),
  ).sort();
}

export function getWebsitePolicy(): WebsitePolicy {
  try {
    initializeDatabase();
    const row = getSqlite()
      .prepare("SELECT website_policy_mode, website_policy_domains FROM app_config WHERE id = 'default'")
      .get() as { website_policy_mode?: string | null; website_policy_domains?: string | null } | undefined;
    const mode = String(row?.website_policy_mode || "off").trim().toLowerCase();
    return {
      mode: mode === "blocklist" || mode === "allowlist" ? (mode as WebsitePolicyMode) : "off",
      domains: normalizeWebsitePolicyDomains(String(row?.website_policy_domains || "")),
    };
  } catch {
    return { mode: "off", domains: [] };
  }
}

function hostnameMatches(hostname: string, blockedDomain: string): boolean {
  return hostname === blockedDomain || hostname.endsWith(`.${blockedDomain}`);
}

export function isBlockedWebsiteHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;
  const policy = getWebsitePolicy();
  if (policy.mode === "blocklist") {
    return policy.domains.some((blockedDomain) => hostnameMatches(normalized, blockedDomain));
  }
  if (policy.mode === "allowlist") {
    if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") return false;
    return !policy.domains.some((allowedDomain) => hostnameMatches(normalized, allowedDomain));
  }
  return false;
}

export function assertAllowedWebsiteUrl(rawUrl: string, surface: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("Invalid URL");
  }
  const hostname = normalizeHostname(parsed.hostname);
  if (hostname && isBlockedWebsiteHostname(hostname)) {
    const policy = getWebsitePolicy();
    const modeLabel = policy.mode === "allowlist" ? "allowlist" : "blocklist";
    throw new Error(`${surface} blocked by website policy (${modeLabel}) for host "${hostname}"`);
  }
  return parsed.toString();
}

export function extractBlockedSearchTargets(query: string): string[] {
  const policy = getWebsitePolicy();
  if (policy.mode === "off" || policy.domains.length === 0) return [];
  const value = String(query || "");
  const targets = new Set<string>();
  const siteMatches = value.match(/site:([a-z0-9.-]+\.[a-z]{2,})/gi) ?? [];
  for (const match of siteMatches) {
    const host = normalizeHostname(match.replace(/^site:/i, ""));
    if (host) targets.add(host);
  }
  const urlMatches = value.match(/https?:\/\/[^\s/$.?#].[^\s]*/gi) ?? [];
  for (const match of urlMatches) {
    try {
      const host = normalizeHostname(new URL(match).hostname);
      if (host) targets.add(host);
    } catch {
      // ignore malformed url-like text
    }
  }
  const found = Array.from(targets);
  if (policy.mode === "blocklist") {
    return found.filter((host) => policy.domains.some((blocked) => hostnameMatches(host, blocked)));
  }
  if (found.length === 0) {
    return ["(explicit site: filter or URL required in allowlist mode)"];
  }
  return found.filter((host) => !policy.domains.some((allowed) => hostnameMatches(host, allowed)));
}
