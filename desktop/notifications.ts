/**
 * Pure notification gating for the desktop Attention Center (Phase 1).
 * Handles deduplication, rate-limiting, and focus suppression so the same
 * underlying source event is not surfaced repeatedly. No Electron imports.
 */

export type NotifySeverity = "info" | "warn" | "critical";

export type NotifyState = {
  seen: Map<string, number>;
  windowStart: number;
  windowCount: number;
};

export type NotifyDecision = { show: boolean; reason: string };

export type NotifyOptions = {
  id: string;
  severity: NotifySeverity;
  windowFocused: boolean;
  now: number;
  state: NotifyState;
  dedupeMs?: number;
  windowMs?: number;
  maxPerWindow?: number;
};

export function createNotifyState(): NotifyState {
  return { seen: new Map(), windowStart: 0, windowCount: 0 };
}

export function shouldNotify(options: NotifyOptions): NotifyDecision {
  const {
    id,
    severity,
    windowFocused,
    now,
    state,
    dedupeMs = 5 * 60 * 1000,
    windowMs = 60 * 1000,
    maxPerWindow = 5,
  } = options;

  // Focus suppression: when the window is focused, only critical items break through.
  if (windowFocused && severity !== "critical") {
    return { show: false, reason: "window-focused" };
  }

  // Deduplicate the same source within the dedupe window.
  const last = state.seen.get(id);
  if (last !== undefined && now - last < dedupeMs) {
    return { show: false, reason: "deduplicated" };
  }

  // Rate limit across a rolling window.
  if (now - state.windowStart >= windowMs) {
    state.windowStart = now;
    state.windowCount = 0;
  }
  if (state.windowCount >= maxPerWindow) {
    return { show: false, reason: "rate-limited" };
  }

  state.windowCount += 1;
  state.seen.set(id, now);
  // Bound the dedupe map.
  if (state.seen.size > 500) {
    const oldest = [...state.seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, 200);
    for (const [key] of oldest) state.seen.delete(key);
  }
  return { show: true, reason: "show" };
}

/** Validate a notify payload from the renderer before showing an OS notification. */
export function sanitizeNotifyPayload(input: unknown): {
  id: string;
  title: string;
  body: string;
  href: string;
  severity: NotifySeverity;
} | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const title = typeof record.title === "string" ? record.title : "";
  if (!id || !title) return null;
  const severity: NotifySeverity =
    record.severity === "critical" || record.severity === "warn" || record.severity === "info"
      ? record.severity
      : "info";
  const href = typeof record.href === "string" && record.href.startsWith("/") ? record.href : "/";
  return {
    id,
    title: title.slice(0, 120),
    body: (typeof record.body === "string" ? record.body : "").slice(0, 240),
    href,
    severity,
  };
}
