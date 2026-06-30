/**
 * Board block recurrence + escalation regression (temp DB, no model).
 *
 * Proves Phase 5 escalation semantics:
 *  - same kind + same normalized reason increments recurrence,
 *  - volatile numbers/dates in the reason do not create a new fingerprint,
 *  - a different reason does NOT increment the same recurrence,
 *  - capability blocks escalate immediately on the first repeat,
 *  - transient blocks escalate to triage only past the threshold,
 *  - escalated blocks surface in the Attention Center aggregate.
 *
 * Run: pnpm exec tsx scripts/board-block-recurrence-regression.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), `disp8ch_block_recur_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, "blocks.db");
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
  const { createBoard, createBoardTask, blockBoardTask, resolveBoardTaskBlock } = await import(
    "../src/lib/boards/manager"
  );
  const { getAttentionSummary } = await import("../src/lib/attention/aggregate");

  initializeDatabase();
  const board = createBoard({ name: "Recurrence board" });

  console.log("\n[1] Same kind + same normalized reason increments recurrence");
  const t1 = createBoardTask({ boardId: board.id, title: "Flaky fetch" });
  const r1 = blockBoardTask(t1.id, { kind: "transient", reason: "Network timeout after 30s" });
  check("first block recurrence = 1", r1.blockRecurrenceCount === 1, `got ${r1.blockRecurrenceCount}`);
  resolveBoardTaskBlock(t1.id);
  // Volatile number differs (45 vs 30) but should normalize to the same fingerprint.
  const r2 = blockBoardTask(t1.id, { kind: "transient", reason: "Network timeout after 45s" });
  check("re-block with volatile number increments to 2", r2.blockRecurrenceCount === 2, `got ${r2.blockRecurrenceCount}`);

  console.log("\n[2] Different reason does not increment the same recurrence");
  resolveBoardTaskBlock(t1.id);
  const r3 = blockBoardTask(t1.id, { kind: "transient", reason: "DNS resolution failed for host" });
  check("different reason resets recurrence to 1", r3.blockRecurrenceCount === 1, `got ${r3.blockRecurrenceCount}`);

  console.log("\n[3] Transient escalates to triage only past threshold");
  const t2 = createBoardTask({ boardId: board.id, title: "Repeating transient" });
  let last = blockBoardTask(t2.id, { kind: "transient", reason: "Rate limited by upstream" });
  check("transient #1 not yet triage", last.escalationStatus !== "triage", `got ${last.escalationStatus}`);
  resolveBoardTaskBlock(t2.id);
  last = blockBoardTask(t2.id, { kind: "transient", reason: "Rate limited by upstream" });
  check("transient #2 not yet triage", last.escalationStatus !== "triage", `got ${last.escalationStatus}`);
  resolveBoardTaskBlock(t2.id);
  last = blockBoardTask(t2.id, { kind: "transient", reason: "Rate limited by upstream" });
  check("transient #3 escalates to triage", last.escalationStatus === "triage", `got ${last.escalationStatus}`);

  console.log("\n[4] Capability escalates immediately on first repeat");
  const t3 = createBoardTask({ boardId: board.id, title: "Missing credential" });
  let cap = blockBoardTask(t3.id, { kind: "capability", reason: "Missing TELEGRAM_BOT_TOKEN" });
  check("capability #1 = attention", cap.escalationStatus === "attention", `got ${cap.escalationStatus}`);
  resolveBoardTaskBlock(t3.id);
  cap = blockBoardTask(t3.id, { kind: "capability", reason: "Missing TELEGRAM_BOT_TOKEN" });
  check("capability #2 escalates to triage", cap.escalationStatus === "triage", `got ${cap.escalationStatus}`);

  console.log("\n[5] Dependency blocks never escalate");
  const dep = createBoardTask({ boardId: board.id, title: "Dependent" });
  const depBlocked = blockBoardTask(dep.id, { kind: "dependency", reason: "Waiting on parent task" });
  check("dependency escalation stays none", depBlocked.escalationStatus === "none", `got ${depBlocked.escalationStatus}`);

  console.log("\n[6] Escalated blocks surface in Attention Center");
  const summary = getAttentionSummary();
  const blockItems = summary.items.filter((i) => i.sourceType === "board-block");
  check("attention center includes escalated blocks", blockItems.length >= 2, `got ${blockItems.length}`);
  check("triage block is critical severity", blockItems.some((i) => i.severity === "critical"));

  console.log(`\nboard-block-recurrence: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
