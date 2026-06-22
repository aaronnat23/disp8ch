#!/usr/bin/env tsx
/**
 * Phase 3 Work Monitor regression. Seeds background jobs + workflow executions
 * and asserts the read-only presentation snapshot (state mapping, ordering,
 * cancel eligibility) against a temp SQLite database.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-workmon-"));
  process.env.DATABASE_PATH = path.join(tempRoot, "wm.db");

  const { getSqlite, initializeDatabase } = await import("@/lib/db");
  const { getWorkMonitorSnapshot, jobToWorkItem } = await import("@/lib/work-monitor/aggregate");
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 30000).toISOString();

  // --- pure job mapper (DB-seeded running jobs get reconciled to failed, so map directly) ---
  const runningJob = jobToWorkItem({
    id: "job-1",
    status: "running",
    toolName: "sessions_spawn",
    commandPreview: "refactor module",
    startedAt: earlier,
    sessionId: "sess-1",
    metadata: { model: "deepseek-v4-flash" },
  });
  check("wm.runningState", runningJob.state === "running");
  check("wm.backgroundAgentTitle", runningJob.title === "Background agent");
  check("wm.jobModel", runningJob.model === "deepseek-v4-flash");
  check("wm.runningJobCancellable", runningJob.canCancel === true);
  check("wm.sessionHref", runningJob.href === "/chat?sessionId=sess-1");
  check("wm.elapsedComputed", runningJob.elapsedMs >= 25000);

  const doneJob = jobToWorkItem({ id: "job-2", status: "completed", toolName: "shell", commandPreview: "ls -la", startedAt: earlier, completedAt: now });
  check("wm.completedJobNotCancellable", doneJob.state === "completed" && doneJob.canCancel === false);

  // --- workflow execution integration ---
  db.prepare(
    "INSERT OR REPLACE INTO workflows (id, name, description, nodes, edges, is_active, created_at, updated_at) VALUES (?, ?, '', '[]', '[]', 1, ?, ?)",
  ).run("wf-1", "Nightly Digest", now, now);
  db.prepare(
    "INSERT INTO executions (id, workflow_id, status, trigger_type, started_at) VALUES (?, 'wf-1', 'running', 'cron', ?)",
  ).run("ex-1", earlier);

  const snapshot = getWorkMonitorSnapshot();
  const wf = snapshot.items.find((i) => i.id === "workflow:ex-1");
  check("wm.workflowRunning", wf?.state === "running" && wf?.workflowId === "wf-1");
  check("wm.runningSortedFirst", snapshot.items[0]?.state === "running");
  check("wm.snapshotCounts", snapshot.counts.running >= 1 && typeof snapshot.counts.completed === "number");

  try {
    db.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\nwork-monitor-regression: ${results.length - failed.length}/${results.length} passed`);
    if (failed.length > 0) {
      console.error("Failed:", failed.map((r) => r.name).join(", "));
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
