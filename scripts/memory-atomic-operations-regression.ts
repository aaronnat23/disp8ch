/**
 * Atomic memory operations regression (temp DB + temp memory dir, no model).
 *
 * Guards the all-or-nothing memory batch: mixed add/replace/remove, validation
 * (invalid/secret/conflict → zero mutations), scope ownership, requestId
 * idempotency, and recall after a batch.
 *
 * Run: pnpm exec tsx scripts/memory-atomic-operations-regression.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), `disp8ch_mem_atomic_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(tmp, "mem.db");
process.env.MEMORY_PATH = process.env.MEMORY_PATH || path.join(tmp, "memories");

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

async function main() {
  const { applyMemoryOperations, MemoryBatchValidationError } = await import("../src/lib/memory/atomic-operations");
  const { createMemoryProvider } = await import("../src/lib/memory/provider");
  const provider = createMemoryProvider(undefined, "default");
  const count = async () => (await provider.getAll()).length;

  console.log("\nMixed add/replace/remove atomic batch");
  const r1 = await applyMemoryOperations([
    { op: "add", content: "The deploy command is pnpm run build then dpc start." },
    { op: "add", content: "The user prefers concise answers." },
  ]);
  check("two adds succeed", r1.added.length === 2, JSON.stringify(r1));
  const firstId = r1.added[0];
  const r2 = await applyMemoryOperations([
    { op: "replace", id: firstId, content: "The deploy command is: pnpm.cmd run build." },
    { op: "add", content: "Server runs on port 3100." },
    { op: "remove", id: r1.added[1] },
  ]);
  check("mixed replace+add+remove succeeds", r2.replaced.length === 1 && r2.added.length === 1 && r2.removed.length === 1, JSON.stringify(r2));

  console.log("\nValidation → zero mutations");
  {
    const before = await count();
    let threw = false;
    try {
      await applyMemoryOperations([{ op: "add", content: "valid" }, { op: "bogus" } as never]);
    } catch (e) {
      threw = e instanceof MemoryBatchValidationError;
    }
    check("unknown op rejected", threw);
    check("unknown op caused zero mutations", (await count()) === before);
  }
  {
    const before = await count();
    let threw = false;
    try {
      const secretShapedValue = ["sk", "abcdef0123456789abcdef0123"].join("-");
      await applyMemoryOperations([{ op: "add", content: `here is a key ${secretShapedValue} do not store` }]);
    } catch (e) {
      threw = e instanceof MemoryBatchValidationError;
    }
    check("secret content rejected", threw);
    check("secret rejection caused zero mutations", (await count()) === before);
  }
  {
    const before = await count();
    let threw = false;
    try {
      await applyMemoryOperations([{ op: "replace", id: firstId, content: "a" }, { op: "remove", id: firstId }]);
    } catch (e) {
      threw = e instanceof MemoryBatchValidationError;
    }
    check("conflicting ops on same id rejected", threw);
    check("conflict caused zero mutations", (await count()) === before);
  }

  console.log("\nScope ownership");
  {
    const other = createMemoryProvider(undefined, "other-agent");
    const otherEntry = await other.store({ content: "secret of another agent" } as never);
    const before = await count();
    let threw = false;
    try {
      await applyMemoryOperations([{ op: "remove", id: otherEntry.id }], { agentId: "default" });
    } catch (e) {
      threw = e instanceof MemoryBatchValidationError;
    }
    check("cross-agent id rejected", threw);
    check("cross-agent rejection caused zero mutations to caller scope", (await count()) === before);
  }
  {
    let threw = false;
    try {
      await applyMemoryOperations([{ op: "remove", id: "mem_does_not_exist" }]);
    } catch (e) {
      threw = e instanceof MemoryBatchValidationError;
    }
    check("missing id rejected", threw);
  }

  console.log("\nRequest id idempotency");
  {
    const rid = `req-${Date.now()}`;
    const a = await applyMemoryOperations([{ op: "add", content: "idempotency probe entry" }], { requestId: rid });
    const countAfterFirst = await count();
    const b = await applyMemoryOperations([{ op: "add", content: "idempotency probe entry" }], { requestId: rid });
    check("duplicate requestId replays prior result", b.idempotentReplay === true && b.added[0] === a.added[0], JSON.stringify(b));
    check("duplicate requestId does not double-apply", (await count()) === countAfterFirst);
    let mismatchRejected = false;
    try {
      await applyMemoryOperations([{ op: "add", content: "different payload" }], { requestId: rid });
    } catch (error) {
      mismatchRejected = error instanceof MemoryBatchValidationError;
    }
    check("requestId cannot be reused for a different payload", mismatchRejected);
  }

  console.log("\nMid-commit failure rollback");
  {
    const anchor = await provider.store({
      content: "rollback anchor original",
      type: "decision",
      tags: ["release", "atomic"],
      source: "regression",
      confidence: 0.91,
      metadata: { owner: "qa", nested: { version: 1 } },
    } as never);
    const before = await provider.get(anchor.id);
    const beforeCount = await count();
    let failedAsExpected = false;
    try {
      await applyMemoryOperations(
        [
          { op: "replace", id: anchor.id, content: "rollback anchor changed", metadata: { owner: "mutated" } },
          { op: "add", content: "must not survive injected failure" },
        ],
        { faultInjector: (point) => { if (point === "after-file-swap") throw new Error("injected swap failure"); } },
      );
    } catch (error) {
      failedAsExpected = /zero committed mutations/i.test(String(error));
    }
    const after = await provider.get(anchor.id);
    check("injected file-swap failure is surfaced", failedAsExpected);
    check("rollback restores the full entry, including metadata", JSON.stringify(after) === JSON.stringify(before), `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    check("rollback removes staged additions", (await count()) === beforeCount);
    check(
      "rollback leaves no transaction directories or lock",
      fs.readdirSync(process.env.MEMORY_PATH!).every((name) => !name.startsWith(".atomic-batch-") && name !== ".atomic-batch.lock"),
    );
  }

  console.log("\nConcurrent idempotent retries");
  {
    const rid = `concurrent-${Date.now()}`;
    const before = await count();
    const [left, right] = await Promise.all([
      applyMemoryOperations([{ op: "add", content: "concurrent idempotency probe" }], { requestId: rid }),
      applyMemoryOperations([{ op: "add", content: "concurrent idempotency probe" }], { requestId: rid }),
    ]);
    check("concurrent retries return the same added id", left.added[0] === right.added[0]);
    check("exactly one concurrent mutation commits", (await count()) === before + 1);
    check("one concurrent result is marked as a replay", left.idempotentReplay !== right.idempotentReplay);
  }

  console.log("\nRecall after batch");
  {
    await applyMemoryOperations([{ op: "add", content: "The capital of memory testing is Springfield." }]);
    const hits = await provider.search("Springfield", 5);
    check("batch-stored entry is recallable", hits.some((h) => h.content.includes("Springfield")), `hits=${hits.length}`);
  }
}

main()
  .then(() => {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`memory-atomic-operations-regression: ${passed} passed, ${failed} failed`);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (failed > 0) {
      console.error("Failed cases:", failures.join(", "));
      process.exit(1);
    }
    console.log("All atomic memory operations tests passed.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
  });
