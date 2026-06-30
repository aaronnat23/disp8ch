/**
 * Computer-use session store regression (temp DB, no driver).
 *
 * Proves Phase 4 session auditing: sessions start active, record an action
 * timeline, capture last screenshot/active app, pause, resume, and stop with an
 * end timestamp.
 *
 * Run: pnpm exec tsx scripts/computer-use-session-store-regression.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), `disp8ch_cu_session_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, "cu.db");
process.env.MEMORY_PATH = path.join(tmp, "memories");
process.env.WORKSPACE_PATH = path.join(tmp, "workspace");

let passed = 0,
  failed = 0;
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

async function main() {
  const { initializeDatabase } = await import("../src/lib/db");
  const {
    createSessionRecord,
    getSessionRecord,
    listSessionRecords,
    setSessionStatus,
    recordSessionAction,
    listSessionActions,
  } = await import("../src/lib/computer-use/session-store");

  initializeDatabase();

  console.log("\n[1] Start session");
  const session = createSessionRecord({ label: "Notepad test", driver: "/usr/bin/cua-driver" });
  check("session active", session.status === "active");
  check("session listed", listSessionRecords().some((s) => s.id === session.id));

  console.log("\n[2] Record action timeline");
  recordSessionAction({ sessionId: session.id, kind: "observe", risk: "read", detail: "saw desktop", activeApp: "Notepad", screenshotPath: "/tmp/shot1.png" });
  recordSessionAction({ sessionId: session.id, kind: "type", risk: "moderate", requiresApproval: false, approved: true, detail: "typed hello" });
  const actions = listSessionActions(session.id);
  check("two actions recorded", actions.length === 2, `got ${actions.length}`);
  check("actions in order", actions[0].kind === "observe" && actions[1].kind === "type");
  const updated = getSessionRecord(session.id)!;
  check("last screenshot captured", updated.lastScreenshotPath === "/tmp/shot1.png");
  check("active app captured", updated.activeApp === "Notepad");

  console.log("\n[3] Pause + resume");
  check("pause works", setSessionStatus(session.id, "paused").status === "paused");
  check("resume works", setSessionStatus(session.id, "active").status === "active");

  console.log("\n[4] Stop sets end timestamp");
  const stopped = setSessionStatus(session.id, "stopped");
  check("stopped status", stopped.status === "stopped");
  check("end timestamp set", Boolean(stopped.endedAt));

  console.log(`\ncomputer-use-session-store: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
