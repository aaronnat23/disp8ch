/**
 * Board human-in-the-loop block UI smoke (static source assertion, no browser).
 *
 * Verifies the Boards client renders the typed-block recovery surface required
 * by Phase 5: block kind badge, recurrence count, blocked age, reason, recovery
 * actions, and the "Needs human" quick filter. This is a deterministic
 * source-presence check so it runs in the release suite without a dev server;
 * the live Windows run exercises the actual rendering.
 *
 * Run: pnpm exec tsx scripts/board-block-human-loop-ui-smoke.ts
 */
import fs from "node:fs";
import path from "node:path";

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

const clientPath = path.join(process.cwd(), "src/app/(operator)/boards/client-page.tsx");
const src = fs.readFileSync(clientPath, "utf8");

console.log("\n[1] Typed block panel + badges");
check("renders block kind label map", src.includes("BLOCK_KIND_LABEL"));
check("shows recurrence count badge", src.includes("blockRecurrenceCount"));
check("shows blocked age", src.includes("formatBlockedAge"));
check("shows triage/attention escalation states", src.includes('"triage"') && src.includes('"attention"'));
check("shows dependency list count", src.includes("task.blockedBy.length"));

console.log("\n[2] Recovery actions on blocked cards");
check("Resolve action", src.includes("resolveTaskBlock"));
check("Ask human action", src.includes("Ask human"));
check("Convert to approval action", src.includes("To approval"));
check("Create unblock task action", src.includes("createUnblockTask"));
check("Retry once action", src.includes("Retry once"));

console.log("\n[3] Needs human filter");
check("needs_human quick filter type", src.includes('"needs_human"'));
check("needs human pill label", src.includes("Needs human"));

console.log(`\nboard-block-human-loop-ui-smoke: ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.error(`Failures: ${failures.join(", ")}`);
  process.exit(1);
}
