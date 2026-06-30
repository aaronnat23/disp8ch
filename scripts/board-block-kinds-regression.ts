/**
 * Board typed-block-kind regression (temp DB, no model).
 *
 * Proves Phase 5 of the Kanban gap plan:
 *  - blocks of each typed kind persist with a human-readable reason,
 *  - dependency blocks auto-resume when the parent task completes,
 *  - non-dependency blocks stay blocked until explicitly resolved,
 *  - resolveBoardTaskBlock clears the typed block state.
 *
 * Run: pnpm exec tsx scripts/board-block-kinds-regression.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), `disp8ch_block_kinds_${Date.now()}`);
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
  const {
    createBoard,
    createBoardTask,
    updateBoardTask,
    getBoardTask,
    blockBoardTask,
    resolveBoardTaskBlock,
    listTaskBlockEvents,
  } = await import("../src/lib/boards/manager");

  initializeDatabase();
  const board = createBoard({ name: "Block kinds board" });

  console.log("\n[1] Each typed block kind persists with its reason");
  const kinds = ["needs_input", "capability", "transient", "approval", "external", "unknown"] as const;
  for (const kind of kinds) {
    const t = createBoardTask({ boardId: board.id, title: `Task ${kind}` });
    const blocked = blockBoardTask(t.id, { kind, reason: `Reason for ${kind} block` });
    check(`${kind}: status blocked`, blocked.status === "blocked");
    check(`${kind}: kind recorded`, blocked.blockKind === kind, `got ${blocked.blockKind}`);
    check(`${kind}: reason recorded`, blocked.blockReason === `Reason for ${kind} block`);
  }

  console.log("\n[2] Dependency block auto-resumes when parent completes");
  const parent = createBoardTask({ boardId: board.id, title: "Parent" });
  const child = createBoardTask({ boardId: board.id, title: "Child", blockedBy: [parent.id] });
  check("child is blocked", child.status === "blocked");
  check("child block kind is dependency", child.blockKind === "dependency", `got ${child.blockKind}`);
  updateBoardTask(parent.id, { status: "done" });
  const childAfter = getBoardTask(child.id)!;
  check("child auto-resumed to inbox", childAfter.status === "inbox", `got ${childAfter.status}`);
  check("child dependency block cleared", childAfter.blockKind === null, `got ${childAfter.blockKind}`);

  console.log("\n[3] Non-dependency block stays blocked until resolved");
  const stuck = createBoardTask({ boardId: board.id, title: "Stuck" });
  blockBoardTask(stuck.id, { kind: "needs_input", reason: "Need API base URL from user" });
  const other = createBoardTask({ boardId: board.id, title: "Unrelated done" });
  updateBoardTask(other.id, { status: "done" });
  const stuckAfter = getBoardTask(stuck.id)!;
  check("needs_input task still blocked after unrelated completion", stuckAfter.status === "blocked");

  console.log("\n[4] Resolve clears block state");
  const resolved = resolveBoardTaskBlock(stuck.id, { status: "inbox" });
  check("resolved status moved to inbox", resolved.status === "inbox");
  check("resolved escalation marked resolved", resolved.escalationStatus === "resolved");
  check("resolved block kind cleared", resolved.blockKind === null);

  console.log("\n[5] Block events are recorded for audit");
  const events = listTaskBlockEvents(stuck.id);
  check("block + resolve events recorded", events.length >= 2, `got ${events.length}`);
  check("a resolution event exists", events.some((e) => e.kind === "resolved"));

  console.log("\n[6] Missing reason is rejected");
  const noReason = createBoardTask({ boardId: board.id, title: "No reason" });
  let rejected = false;
  try {
    blockBoardTask(noReason.id, { kind: "transient", reason: "   " });
  } catch {
    rejected = true;
  }
  check("empty reason rejected", rejected);

  console.log(`\nboard-block-kinds: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
