import { lookup as dnsLookup } from "node:dns/promises";
import { lookup as dnsLookupCb, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";

const BLOCKED_HOSTNAMES = new Set(["metadata.google.internal"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);
const CROSS_ORIGIN_REDIRECT_SENSITIVE_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
];

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

export type GuardedFetchParams = {
  url: string;
  init?: RequestInit;
  maxRedirects?: number;
  timeoutMs?: number;
};

export type GuardedFetchResult = {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
};

function normalizeHostname(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

function isCanonicalDottedDecimalIpv4(hostname: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function looksLikeUnsupportedIpv4Literal(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length === 0 || parts.length > 4) return false;
  if (!parts.every((part) => /^[0-9]+$/.test(part) || /^0x[0-9a-f]+$/i.test(part))) return false;
  return !isCanonicalDottedDecimalIpv4(hostname);
}

function extractEmbeddedIpv4FromIpv6(hostname: string): string | null {
  const match = hostname.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return match?.[1] ?? null;
}

function isLoopbackIp(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (isCanonicalDottedDecimalIpv4(normalized)) return normalized.startsWith("127.");
  return normalized === "::1";
}

function isBlockedSpecialUseIpv4(hostname: string): boolean {
  if (!isCanonicalDottedDecimalIpv4(hostname)) return false;
  const [a, b, c] = hostname.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  return false;
}

function isBlockedSpecialUseIpv6(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) return true;
  if (normalized.startsWith("ff")) return true;
  const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(normalized);
  return Boolean(embeddedIpv4 && isBlockedSpecialUseIpv4(embeddedIpv4));
}

function isBlockedHostname(hostname: string): boolean {
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return false;
  return hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal");
}

function isBlockedHostOrIp(hostnameOrIp: string, allowLoopback: boolean): boolean {
  const normalized = normalizeHostname(hostnameOrIp);
  if (!normalized) return true;
  if (allowLoopback && (LOOPBACK_HOSTNAMES.has(normalized) || isLoopbackIp(normalized))) return false;
  if (isBlockedHostname(normalized)) return true;
  if (looksLikeUnsupportedIpv4Literal(normalized)) return true;
  const family = isIP(normalized);
  if (family === 4) return isBlockedSpecialUseIpv4(normalized);
  if (family === 6) return isBlockedSpecialUseIpv6(normalized);
  return false;
}

function assertAllowedHostOrIp(hostnameOrIp: string, allowLoopback: boolean): void {
  if (isBlockedHostOrIp(hostnameOrIp, allowLoopback)) {
    throw new Error("SSRF blocked: hostname or private/internal/special-use IP address");
  }
}

async function resolveAndValidateHostname(
  hostname: string,
  allowLoopback = true,
): Promise<Array<{ address: string; family: number }>> {
  const normalizedHostname = normalizeHostname(hostname);
  const hostnameAllowsLoopback =
    allowLoopback && (LOOPBACK_HOSTNAMES.has(normalizedHostname) || isLoopbackIp(normalizedHostname));
  assertAllowedHostOrIp(hostname, hostnameAllowsLoopback);
  const result = await dnsLookup(hostname, { all: true, verbatim: true });
  if (result.length === 0) {
    throw new Error(`Cannot resolve hostname: ${hostname}`);
  }

  const addresses = result.map((entry) => ({
    address: entry.address,
    family: entry.family,
  }));

  for (const entry of addresses) {
    if (hostnameAllowsLoopback && isLoopbackIp(entry.address)) continue;
    if (isBlockedHostOrIp(entry.address, false)) {
      throw new Error(`SSRF blocked: resolves to private/internal/special-use address ${entry.address}`);
    }
  }

  const seen = new Set<string>();
  return addresses.filter((entry) => {
    if (seen.has(entry.address)) return false;
    seen.add(entry.address);
    return true;
  });
}

function createPinnedLookup(hostname: string, addresses: Array<{ address: string; family: number }>): typeof dnsLookupCb {
  const normalizedHost = normalizeHostname(hostname);
  const records = addresses.map((entry) => ({
    address: entry.address,
    family: entry.family,
  }));
  let index = 0;

  return ((host: string, options?: unknown, callback?: unknown) => {
    const cb: LookupCallback =
      typeof options === "function" ? (options as LookupCallback) : (callback as LookupCallback);
    if (!cb) return;

    const normalized = normalizeHostname(host);
    if (!normalized || normalized !== normalizedHost) {
      if (typeof options === "function" || options === undefined) {
        return (dnsLookupCb as unknown as (h: string, c: LookupCallback) => void)(host, cb);
      }
      return (
        dnsLookupCb as unknown as (
          h: string,
          o: unknown,
          c: LookupCallback,
        ) => void
      )(host, options, cb);
    }

    const opts =
      typeof options === "object" && options !== null
        ? (options as { all?: boolean; family?: number })
        : {};
    const requestedFamily =
      typeof options === "number" ? options : typeof opts.family === "number" ? opts.family : 0;
    const candidates =
      requestedFamily === 4 || requestedFamily === 6
        ? records.filter((entry) => entry.family === requestedFamily)
        : records;
    const usable = candidates.length > 0 ? candidates : records;
    if (opts.all) {
      cb(null, usable as LookupAddress[]);
      return;
    }
    const chosen = usable[index % usable.length];
    index += 1;
    cb(null, chosen.address, chosen.family);
  }) as typeof dnsLookupCb;
}

function createPinnedDispatcher(hostname: string, addresses: Array<{ address: string; family: number }>): Dispatcher {
  return new Agent({
    connect: {
      lookup: createPinnedLookup(hostname, addresses),
    },
  });
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function closeDispatcher(dispatcher?: Dispatcher | null): Promise<void> {
  if (!dispatcher) return;
  try {
    await dispatcher.close();
  } catch {
    try {
      dispatcher.destroy();
    } catch {
      // Best effort.
    }
  }
}

function stripSensitiveHeadersForCrossOriginRedirect(init?: RequestInit): RequestInit | undefined {
  if (!init?.headers) return init;
  const headers = new Headers(init.headers);
  for (const header of CROSS_ORIGIN_REDIRECT_SENSITIVE_HEADERS) {
    headers.delete(header);
  }
  return { ...init, headers };
}

export function validateProtocol(rawUrl: string): { ok: true; url: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    return { ok: false, error: "Invalid URL: must be http or https" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: "Invalid URL: must be http or https" };
  }
  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    return { ok: false, error: "Invalid URL hostname" };
  }
  return { ok: true, url: parsed };
}

export async function assertAllowedFetchTarget(rawUrl: string): Promise<URL> {
  const validated = validateProtocol(rawUrl);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  await resolveAndValidateHostname(normalizeHostname(validated.url.hostname));
  return validated.url;
}

export async function guardedFetch(params: GuardedFetchParams): Promise<GuardedFetchResult> {
  const maxRedirects =
    typeof params.maxRedirects === "number" && Number.isFinite(params.maxRedirects)
      ? Math.max(0, Math.floor(params.maxRedirects))
      : 3;
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(1, Math.floor(params.timeoutMs))
      : 30_000;

  let released = false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const release = async (dispatcher?: Dispatcher | null) => {
    if (released) return;
    released = true;
    clearTimeout(timeoutId);
    await closeDispatcher(dispatcher);
  };

  const visited = new Set<string>();
  let currentUrl = params.url;
  let currentInit = params.init ? { ...params.init } : undefined;
  let redirectCount = 0;

  while (true) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      await release();
      throw new Error("Invalid URL: must be http or https");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      await release();
      throw new Error("Invalid URL: must be http or https");
    }

    const hostname = normalizeHostname(parsedUrl.hostname);
    if (!hostname) {
      await release();
      throw new Error("Invalid URL hostname");
    }

    let dispatcher: Dispatcher | null = null;
    try {
      const addresses = await resolveAndValidateHostname(hostname);
      dispatcher = createPinnedDispatcher(hostname, addresses);

      const init: RequestInit & { dispatcher?: Dispatcher } = {
        ...(currentInit ? { ...currentInit } : {}),
        redirect: "manual",
        signal: controller.signal,
        dispatcher,
      };

      const response = await fetch(parsedUrl.toString(), init);

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          await closeDispatcher(dispatcher);
          throw new Error(`Redirect missing location header (${response.status})`);
        }
        redirectCount += 1;
        if (redirectCount > maxRedirects) {
          await closeDispatcher(dispatcher);
          throw new Error("Too many redirects");
        }

        let nextUrl: string;
        try {
          nextUrl = new URL(location, parsedUrl.toString()).toString();
        } catch {
          await closeDispatcher(dispatcher);
          throw new Error("Invalid redirect location URL");
        }

        if (visited.has(normalizeUrl(nextUrl)) || visited.size > 10) {
          await closeDispatcher(dispatcher);
          throw new Error("Redirect loop detected");
        }

        const nextParsedUrl = new URL(nextUrl);
        if (nextParsedUrl.origin !== parsedUrl.origin) {
          currentInit = stripSensitiveHeadersForCrossOriginRedirect(currentInit);
        }
        visited.add(normalizeUrl(nextUrl));
        void response.body?.cancel();
        await closeDispatcher(dispatcher);
        currentUrl = nextUrl;
        continue;
      }

      return {
        response,
        finalUrl: currentUrl,
        release: () => release(dispatcher),
      };
    } catch (err) {
      await release(dispatcher);
      throw err;
    }
  }
}

function normalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return rawUrl;
  }
}
