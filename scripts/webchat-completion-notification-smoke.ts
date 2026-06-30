/**
 * WebChat completion-notification logic smoke (mocked browser globals).
 *
 * The real notification is browser-side; this verifies the decision logic:
 * default-off, only-when-hidden, dedup by key, permission gating, and the
 * enable/permission flow — without needing a live browser.
 *
 * Run: pnpm exec tsx scripts/webchat-completion-notification-smoke.ts
 */
let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Mock browser globals BEFORE importing the module ──
const store: Record<string, string> = {};
const notifications: Array<{ title: string; tag?: string }> = [];
class MockNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = async (): Promise<NotificationPermission> => MockNotification.permission;
  onclick: (() => void) | null = null;
  constructor(public title: string, public options?: { tag?: string }) {
    notifications.push({ title, tag: options?.tag });
  }
  close() {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.window = { localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } }, focus: () => {}, location: { href: "" } };
g.document = { hidden: true };
g.Notification = MockNotification;
g.localStorage = (g.window as { localStorage: unknown }).localStorage;

async function main() {
  const mod = await import("../src/lib/client/completion-notifications");

  console.log("\nDefault off");
  check("disabled by default", mod.isCompletionNotificationsEnabled() === false);
  check("notify is a no-op when disabled", mod.notifyCompletion({ key: "k0", title: "t" }) === false && notifications.length === 0);

  console.log("\nEnable flow");
  const granted = await mod.setCompletionNotificationsEnabled(true);
  check("enabling with granted permission returns true", granted === true);
  check("now enabled", mod.isCompletionNotificationsEnabled() === true);

  console.log("\nOnly when hidden");
  (g.document as { hidden: boolean }).hidden = true;
  check("notifies once when page hidden", mod.notifyCompletion({ key: "k1", title: "ready", body: "b", sessionId: "s1" }) === true && notifications.length === 1);
  check("dedupes the same key", mod.notifyCompletion({ key: "k1", title: "ready again" }) === false && notifications.length === 1);
  (g.document as { hidden: boolean }).hidden = false;
  check("does NOT notify when page visible", mod.notifyCompletion({ key: "k2", title: "visible" }) === false && notifications.length === 1);
  check(
    "notifies after a hidden run even if visible at completion",
    mod.notifyCompletion({ key: "k2-hidden", title: "ready", wasHiddenDuringRun: true }) === true && notifications.length === 2,
  );

  console.log("\nPermission gating");
  MockNotification.permission = "denied";
  (g.document as { hidden: boolean }).hidden = true;
  check("does NOT notify when permission denied", mod.notifyCompletion({ key: "k3", title: "denied" }) === false && notifications.length === 2);
  MockNotification.permission = "granted";

  console.log("\nDisable");
  const off = await mod.setCompletionNotificationsEnabled(false);
  check("disabling returns false and persists", off === false && mod.isCompletionNotificationsEnabled() === false);
  check("notify is a no-op after disable", mod.notifyCompletion({ key: "k4", title: "off" }) === false && notifications.length === 2);
}

main()
  .then(() => {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`webchat-completion-notification-smoke: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("Failed cases:", failures.join(", "));
      process.exit(1);
    }
    console.log("All completion-notification logic tests passed.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
  });
