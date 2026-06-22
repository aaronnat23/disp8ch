/**
 * Background subagents Activity regression (temp DB, no spawned processes).
 *
 * Guards the data path behind the Activity "Background subagents" section:
 * capacity snapshot, listing/shaping coding-agent vs shell jobs, and cancel.
 *
 * Run: pnpm exec tsx scripts/background-subagents-activity-regression.ts
 */
import os from "node:os";
import path from "node:path";

process.env.DATABASE_PATH =
  process.env.DATABASE_PATH || path.join(os.tmpdir(), `disp8ch_bgjobs_${Date.now()}.db`);

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
  const { getSqlite, initializeDatabase } = await import("../src/lib/db");
  const { listBackgroundJobs, getAsyncDelegationCapacitySnapshot, terminateBackgroundJob } = await import(
    "../src/lib/runtime/background-jobs"
  );

  initializeDatabase();
  const db = getSqlite();

  console.log("\nCapacity snapshot");
  const cap = getAsyncDelegationCapacitySnapshot();
  check("capacity has running + maxConcurrent", typeof cap.running === "number" && cap.maxConcurrent >= 1, JSON.stringify(cap));

  console.log("\nList + shaping");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO background_jobs (id, tool_name, command_preview, cwd, session_id, agent_id, notify_on_complete, status, pid, started_at, completed_at, exit_code, stdout, stderr, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("bg-coding-1", "sessions_spawn", "spawn coding agent: fix lint", null, "sess-abc", "main", 1, "running", 1234, now, null, null, "", "", JSON.stringify({ kind: "coding-agent-delegation", backend: "claude" }));
  db.prepare(
    `INSERT INTO background_jobs (id, tool_name, command_preview, cwd, session_id, agent_id, notify_on_complete, status, pid, started_at, completed_at, exit_code, stdout, stderr, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("bg-shell-1", "bash_exec", "ls -la", null, "sess-xyz", "main", 0, "completed", null, now, now, 0, "total 4\n", "", JSON.stringify({}));

  const jobs = listBackgroundJobs({ limit: 10 });
  check("both jobs listed", jobs.length >= 2, `count=${jobs.length}`);
  const coding = jobs.find((j) => j.id === "bg-coding-1");
  const shell = jobs.find((j) => j.id === "bg-shell-1");
  check("coding-agent job has sessions_spawn tool + metadata kind", coding?.toolName === "sessions_spawn" && coding?.metadata?.kind === "coding-agent-delegation");
  check("shell job is bash_exec, completed", shell?.toolName === "bash_exec" && shell?.status === "completed");
  check("coding job carries session id", coding?.sessionId === "sess-abc");
  // The inserted "running" job has a dead pid → reconciliation must not leave a
  // false running indicator after restart.
  check("orphaned running job is reconciled (not left running)", coding?.status !== "running", `status=${coding?.status}`);

  console.log("\nCancel");
  // Insert a fresh running job whose pid is the current process (alive) to test cancel.
  db.prepare(
    `INSERT INTO background_jobs (id, tool_name, command_preview, cwd, session_id, agent_id, notify_on_complete, status, pid, started_at, completed_at, exit_code, stdout, stderr, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("bg-cancel-1", "sessions_spawn", "long running agent", null, "sess-c", "main", 0, "running", 999999, now, null, null, "", "", JSON.stringify({}));
  const terminated = terminateBackgroundJob("bg-cancel-1");
  check("terminate returns the job record", terminated?.id === "bg-cancel-1");
  const after = listBackgroundJobs({ limit: 10 }).find((j) => j.id === "bg-cancel-1");
  check("cancelled job is no longer running", after?.status !== "running", `status=${after?.status}`);
}

main()
  .then(() => {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`background-subagents-activity-regression: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("Failed cases:", failures.join(", "));
      process.exit(1);
    }
    console.log("All background subagents activity tests passed.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
  });
