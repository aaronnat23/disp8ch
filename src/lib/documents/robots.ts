import fs from "node:fs";
import path from "node:path";
import { guardedFetch } from "@/lib/documents/fetch-policy";
import { logger } from "@/lib/utils/logger";

const log = logger.child("documents:robots");

const ROBOTS_CACHE_DIR = path.resolve("./data/documents/robots-cache");
const ROBOTS_CACHE_TTL_MS = 3600_000;
const DEFAULT_CRAWL_DELAY_MS = 3000;

type RobotsEntry = {
  disallowed: string[];
  crawlDelay?: number;
  cachedAt: number;
};

const robotsCache = new Map<string, RobotsEntry>();

function ensureRobotsCacheDir(): void {
  fs.mkdirSync(ROBOTS_CACHE_DIR, { recursive: true });
}

function parseRobotsTxt(text: string): { disallowed: string[]; crawlDelay?: number } {
  const disallowed: string[] = [];
  let crawlDelay: number | undefined;
  let isUserAgentMatch = false;

  for (const line of text.split("\n")) {
    const trimmed = line.split("#")[0].trim();
    if (!trimmed) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex < 0) continue;

    const key = trimmed.slice(0, colonIndex).trim().toLowerCase();
    const value = trimmed.slice(colonIndex + 1).trim();

    if (key === "user-agent") {
      isUserAgentMatch = value === "*" || /disp8ch/i.test(value) || /bot/i.test(value);
      continue;
    }

    if (!isUserAgentMatch) continue;

    if (key === "disallow") {
      if (value) disallowed.push(value);
    }

    if (key === "crawl-delay") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        crawlDelay = Math.min(parsed, 30);
      }
    }
  }

  return { disallowed, crawlDelay };
}

async function fetchRobotsTxt(origin: string): Promise<string | null> {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const guarded = await guardedFetch({
      url: robotsUrl,
      init: {
        method: "GET",
        headers: { "User-Agent": "disp8ch-doc-crawler/1.1" },
      },
      maxRedirects: 3,
      timeoutMs: 10_000,
    });
    try {
      if (!guarded.response.ok) return null;
      return await guarded.response.text();
    } finally {
      await guarded.release();
    }
  } catch {
    return null;
  }
}

function getCacheFile(origin: string): string {
  ensureRobotsCacheDir();
  const safeName = origin.replace(/[^a-zA-Z0-9.-]+/g, "_").slice(0, 120);
  return path.join(ROBOTS_CACHE_DIR, `${safeName}.txt`);
}

function loadFromFile(origin: string): RobotsEntry | null {
  try {
    const filePath = getCacheFile(origin);
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs > ROBOTS_CACHE_TTL_MS) return null;
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseRobotsTxt(content);
    return {
      disallowed: parsed.disallowed,
      crawlDelay: parsed.crawlDelay ?? DEFAULT_CRAWL_DELAY_MS,
      cachedAt: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

function saveToFile(origin: string, text: string): void {
  try {
    ensureRobotsCacheDir();
    fs.writeFileSync(getCacheFile(origin), text, "utf-8");
  } catch {
    // Non-critical; robots cache is a best-effort optimization.
  }
}

export async function getRobotsPolicy(origin: string): Promise<RobotsEntry> {
  const existing = robotsCache.get(origin) ?? loadFromFile(origin);
  if (existing && Date.now() - existing.cachedAt < ROBOTS_CACHE_TTL_MS) {
    return existing;
  }

  const text = await fetchRobotsTxt(origin);
  if (text) {
    saveToFile(origin, text);
    const parsed = parseRobotsTxt(text);
    const entry: RobotsEntry = {
      disallowed: parsed.disallowed,
      crawlDelay: parsed.crawlDelay ?? DEFAULT_CRAWL_DELAY_MS,
      cachedAt: Date.now(),
    };
    robotsCache.set(origin, entry);
    return entry;
  }

  const defaultEntry: RobotsEntry = {
    disallowed: [],
    crawlDelay: DEFAULT_CRAWL_DELAY_MS,
    cachedAt: Date.now(),
  };
  robotsCache.set(origin, defaultEntry);
  return defaultEntry;
}

export function isPathDisallowed(disallowed: string[], pathname: string): boolean {
  for (const pattern of disallowed) {
    if (!pattern) continue;
    if (pattern === "/") return true;
    if (pattern.endsWith("/") && (pathname + "/").startsWith(pattern)) return true;
    if (pathname.startsWith(pattern)) return true;
  }
  return false;
}

export function getOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "";
  }
}

export async function shouldAllowScrape(url: string, overrideRobots: boolean): Promise<{ allowed: boolean; reason: string; crawlDelayMs: number }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "invalid URL", crawlDelayMs: 0 };
  }

  const origin = getOrigin(url);
  const policy = await getRobotsPolicy(origin);

  const delayMs = policy.crawlDelay ?? DEFAULT_CRAWL_DELAY_MS;

  if (overrideRobots) {
    return { allowed: true, reason: "robots override enabled", crawlDelayMs: delayMs };
  }

  if (isPathDisallowed(policy.disallowed, parsed.pathname)) {
    return { allowed: false, reason: `robots.txt disallows path: ${parsed.pathname}`, crawlDelayMs: 0 };
  }

  return { allowed: true, reason: "robots.txt allows", crawlDelayMs: delayMs };
}

export async function clearRobotsCache(): Promise<void> {
  robotsCache.clear();
  try {
    ensureRobotsCacheDir();
    for (const file of fs.readdirSync(ROBOTS_CACHE_DIR)) {
      if (file.endsWith(".txt")) {
        fs.unlinkSync(path.join(ROBOTS_CACHE_DIR, file));
      }
    }
  } catch {
    // Non-critical
  }
}
