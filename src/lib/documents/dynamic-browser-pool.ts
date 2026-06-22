import type { Browser, BrowserContext, Page } from "playwright";
import { logger } from "@/lib/utils/logger";

const log = logger.child("documents:dynamic-browser-pool");

type PooledBrowser = {
  browser: Browser;
  contexts: Set<BrowserContext>;
  activePages: number;
  lastUsedAt: number;
};

let pooledBrowser: PooledBrowser | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TTL_MS = 60_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_CONTEXTS = 8;

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function resetIdleTimer(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    closeIdleDynamicBrowsers().catch((err) => {
      log.warn("Failed to close idle dynamic browser", { error: String(err) });
    });
  }, IDLE_TTL_MS);
}

async function createBrowser(): Promise<PooledBrowser> {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({ headless: true });
  return {
    browser,
    contexts: new Set(),
    activePages: 0,
    lastUsedAt: Date.now(),
  };
}

async function isBrowserHealthy(pool: PooledBrowser): Promise<boolean> {
  try {
    await pool.browser.version();
    return true;
  } catch {
    return false;
  }
}

export async function getDynamicBrowser(): Promise<Browser> {
  if (pooledBrowser) {
    const healthy = await isBrowserHealthy(pooledBrowser);
    if (!healthy) {
      log.info("Dynamic browser unhealthy, recreating");
      await destroyPooledBrowser();
    } else {
      pooledBrowser.lastUsedAt = Date.now();
      resetIdleTimer();
      return pooledBrowser.browser;
    }
  }

  pooledBrowser = await createBrowser();
  resetIdleTimer();
  return pooledBrowser.browser;
}

export async function createBrowserContext(): Promise<BrowserContext> {
  const browser = await getDynamicBrowser();
  if (pooledBrowser && pooledBrowser.contexts.size >= MAX_CONTEXTS) {
    const oldest = Array.from(pooledBrowser.contexts)[0];
    if (oldest) {
      try {
        await oldest.close();
      } catch { /* ignore */ }
      pooledBrowser.contexts.delete(oldest);
    }
  }

  const context = await browser.newContext({
    userAgent: "disp8ch-doc-crawler/1.0",
    viewport: { width: 1440, height: 900 },
  });

  if (pooledBrowser) {
    pooledBrowser.contexts.add(context);
  }

  return context;
}

export async function createBrowserPage(): Promise<{ page: Page; context: BrowserContext }> {
  const context = await createBrowserContext();
  const page = await context.newPage();
  if (pooledBrowser) {
    pooledBrowser.activePages += 1;
  }
  return { page, context };
}

export async function releasePage(page: Page, context: BrowserContext): Promise<void> {
  try {
    await page.close();
  } catch { /* ignore */ }

  if (pooledBrowser) {
    pooledBrowser.activePages = Math.max(0, pooledBrowser.activePages - 1);
    pooledBrowser.contexts.delete(context);
  }

  try {
    await context.close();
  } catch { /* ignore */ }

  if (pooledBrowser) {
    pooledBrowser.lastUsedAt = Date.now();
    resetIdleTimer();
  }
}

export async function closeContext(context: BrowserContext): Promise<void> {
  try {
    await context.close();
  } catch { /* ignore */ }

  if (pooledBrowser) {
    pooledBrowser.contexts.delete(context);
  }
}

async function destroyPooledBrowser(): Promise<void> {
  if (!pooledBrowser) return;
  const pool = pooledBrowser;
  pooledBrowser = null;
  clearIdleTimer();

  for (const context of pool.contexts) {
    try {
      await context.close();
    } catch { /* ignore */ }
  }
  pool.contexts.clear();

  try {
    await pool.browser.close();
  } catch { /* ignore */ }
}

export async function closeIdleDynamicBrowsers(): Promise<void> {
  if (!pooledBrowser) return;
  if (pooledBrowser.activePages > 0) {
    resetIdleTimer();
    return;
  }
  await destroyPooledBrowser();
}

export async function shutdownDynamicBrowserPool(): Promise<void> {
  await destroyPooledBrowser();
}

export function getBrowserPoolStatus(): {
  hasBrowser: boolean;
  contextCount: number;
  activePages: number;
  idleMs: number;
} {
  if (!pooledBrowser) {
    return { hasBrowser: false, contextCount: 0, activePages: 0, idleMs: 0 };
  }
  return {
    hasBrowser: true,
    contextCount: pooledBrowser.contexts.size,
    activePages: pooledBrowser.activePages,
    idleMs: Date.now() - pooledBrowser.lastUsedAt,
  };
}
