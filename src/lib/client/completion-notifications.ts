"use client";

// Opt-in browser notifications for long WebChat responses / background
// delegations that finish while the page is hidden. Per-browser preference
// (localStorage), default OFF. Deduplicated by run/session key. Notifications
// never carry sensitive content — only a short title + neutral body.

const PREF_KEY = "disp8ch.completionNotifications";
const notified = new Set<string>();

export function isCompletionNotificationsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(PREF_KEY) === "1";
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** Enable/disable. Enabling requests permission (must be from a user gesture). */
export async function setCompletionNotificationsEnabled(enabled: boolean): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!enabled) {
    window.localStorage.setItem(PREF_KEY, "0");
    return false;
  }
  if (typeof Notification === "undefined") return false;
  let perm = Notification.permission;
  if (perm === "default") {
    perm = await Notification.requestPermission();
  }
  const granted = perm === "granted";
  window.localStorage.setItem(PREF_KEY, granted ? "1" : "0");
  return granted;
}

export interface CompletionNotice {
  /** Stable run/session id used to dedupe — notify at most once per key. */
  key: string;
  title: string;
  body?: string;
  /** WebChat session to open when the notification is clicked. */
  sessionId?: string;
  /** Captured by the caller across the full run, including tab hide/resume. */
  wasHiddenDuringRun?: boolean;
}

/**
 * Fire a completion notification IF: enabled, permission granted, the page was
 * hidden during the run, and this key hasn't already been notified. No-op
 * otherwise (e.g. a response the user watched to completion).
 */
export function notifyCompletion(notice: CompletionNotice): boolean {
  if (typeof window === "undefined" || typeof Notification === "undefined") return false;
  if (!isCompletionNotificationsEnabled()) return false;
  if (Notification.permission !== "granted") return false;
  if (!notice.wasHiddenDuringRun && !document.hidden) return false;
  if (notified.has(notice.key)) return false;
  notified.add(notice.key);
  try {
    const n = new Notification(notice.title, { body: notice.body, tag: notice.key });
    n.onclick = () => {
      window.focus();
      if (notice.sessionId) {
        window.location.href = `/chat?sessionId=${encodeURIComponent(notice.sessionId)}`;
      }
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
