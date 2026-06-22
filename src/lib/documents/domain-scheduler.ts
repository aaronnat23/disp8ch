type DomainState = {
  lastRequestMs: number;
  concurrency: number;
  backoffUntilMs: number;
  consecutive429s: number;
};

const domainStates = new Map<string, DomainState>();

type CrawlPolitenessOptions = {
  respectRobotsTxt: boolean;
  defaultDelayMs: number;
  maxDelayMs: number;
  perDomainConcurrency: number;
  allowRobotsOverride: boolean;
};

const DEFAULT_POLITENESS: CrawlPolitenessOptions = {
  respectRobotsTxt: true,
  defaultDelayMs: 3000,
  maxDelayMs: 30000,
  perDomainConcurrency: 1,
  allowRobotsOverride: false,
};

export function getDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

export async function acquireDomainSlot(hostname: string, delayMs: number): Promise<{ acquired: boolean; waitMs: number }> {
  const domain = getDomain(hostname);
  const state = domainStates.get(domain);
  const now = Date.now();

  if (!state) {
    domainStates.set(domain, {
      lastRequestMs: now,
      concurrency: 1,
      backoffUntilMs: 0,
      consecutive429s: 0,
    });
    return { acquired: true, waitMs: 0 };
  }

  if (state.backoffUntilMs > now) {
    const remainingMs = state.backoffUntilMs - now;
    return { acquired: false, waitMs: Math.min(remainingMs, DEFAULT_POLITENESS.maxDelayMs) };
  }

  const elapsed = now - state.lastRequestMs;
  if (elapsed < delayMs) {
    const waitMs = delayMs - elapsed;
    return { acquired: false, waitMs };
  }

  state.lastRequestMs = now;
  state.concurrency = 1;
  return { acquired: true, waitMs: 0 };
}

export function releaseDomainSlot(hostname: string): void {
  const domain = getDomain(hostname);
  const state = domainStates.get(domain);
  if (state) {
    state.concurrency = Math.max(0, state.concurrency - 1);
  }
}

export function handleRateLimit(hostname: string, retryAfterSeconds?: number): void {
  const domain = getDomain(hostname);
  const state = domainStates.get(domain) ?? {
    lastRequestMs: 0,
    concurrency: 0,
    backoffUntilMs: 0,
    consecutive429s: 0,
  };

  state.consecutive429s += 1;
  const delay = retryAfterSeconds
    ? retryAfterSeconds * 1000
    : Math.min(DEFAULT_POLITENESS.defaultDelayMs * Math.pow(2, Math.min(state.consecutive429s, 5)), DEFAULT_POLITENESS.maxDelayMs);
  state.backoffUntilMs = Date.now() + delay;
  domainStates.set(domain, state);
}

export function clearDomainState(hostname: string): void {
  domainStates.delete(getDomain(hostname));
}

export function getDomainStates(): Map<string, DomainState> {
  return new Map(domainStates);
}

export function getPolitenessOptions(): CrawlPolitenessOptions {
  return { ...DEFAULT_POLITENESS };
}
