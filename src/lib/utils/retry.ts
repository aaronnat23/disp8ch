import { logger } from "@/lib/utils/logger";
import { getSqlite } from "@/lib/db";

const log = logger.child("utils:retry");

export interface RetryPolicy {
  attempts: number;
  minDelayMs: number;
  maxDelayMs: number;
  jitter: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  minDelayMs: 400,
  maxDelayMs: 30000,
  jitter: 0.1,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay(baseMs: number, jitter: number): number {
  if (jitter <= 0) return Math.max(0, Math.floor(baseMs));
  const spread = baseMs * jitter;
  const delta = (Math.random() * spread * 2) - spread;
  return Math.max(0, Math.floor(baseMs + delta));
}

export function getRetryPolicy(): RetryPolicy {
  try {
    const db = getSqlite();
    const row = db
      .prepare(
        "SELECT channel_retry_attempts, channel_retry_min_delay_ms, channel_retry_max_delay_ms, channel_retry_jitter FROM app_config WHERE id = 'default'",
      )
      .get() as
      | {
          channel_retry_attempts?: number | null;
          channel_retry_min_delay_ms?: number | null;
          channel_retry_max_delay_ms?: number | null;
          channel_retry_jitter?: number | null;
        }
      | undefined;

    return {
      attempts: Math.max(1, Math.floor(row?.channel_retry_attempts ?? DEFAULT_RETRY_POLICY.attempts)),
      minDelayMs: Math.max(10, Math.floor(row?.channel_retry_min_delay_ms ?? DEFAULT_RETRY_POLICY.minDelayMs)),
      maxDelayMs: Math.max(100, Math.floor(row?.channel_retry_max_delay_ms ?? DEFAULT_RETRY_POLICY.maxDelayMs)),
      jitter: Math.max(0, Math.min(0.5, Number(row?.channel_retry_jitter ?? DEFAULT_RETRY_POLICY.jitter))),
    };
  } catch {
    return DEFAULT_RETRY_POLICY;
  }
}

export function isRetryableChannelError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("ecanceled") ||
    msg.includes("etimedout") ||
    msg.includes("temporarily unavailable") ||
    msg.includes("too many requests")
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    policy?: RetryPolicy;
    shouldRetry?: (error: unknown) => boolean;
    label?: string;
  },
): Promise<T> {
  const policy = options?.policy ?? getRetryPolicy();
  const shouldRetry = options?.shouldRetry ?? (() => true);
  const label = options?.label ?? "operation";

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastErr = error;
      const canRetry = attempt < policy.attempts && shouldRetry(error);
      if (!canRetry) break;

      const baseDelay = Math.min(policy.maxDelayMs, policy.minDelayMs * Math.pow(2, attempt - 1));
      const delay = jitteredDelay(baseDelay, policy.jitter);
      log.warn("Retrying operation after error", {
        label,
        attempt,
        attempts: policy.attempts,
        delayMs: delay,
        error: String(error),
      });
      await sleep(delay);
    }
  }

  throw lastErr;
}
