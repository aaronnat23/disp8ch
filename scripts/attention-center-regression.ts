#!/usr/bin/env tsx
/**
 * Phase 1 Attention Center regression.
 * - Pure desktop notification gating (focus suppression, dedupe, rate limit).
 * - Live aggregation + dismiss receipts against a seeded temp SQLite database.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createNotifyState,
  sanitizeNotifyPayload,
  shouldNotify,
} from "../desktop/notifications";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

// --- pure notification gating ---
{
  const state = createNotifyState();
  const base = { id: "a", severity: "warn" as const, windowFocused: false, now: 1000, state };
  check("notify.firstShows", shouldNotify({ ...base }).show === true);
  check("notify.dedupesWithinWindow", shouldNotify({ ...base, now: 2000 }).show === false);
  check(
    "notify.focusSuppressesNonCritical",
    shouldNotify({ id: "b", severity: "warn", windowFocused: true, now: 3000, state }).show === false,
  );
  check(
    "notify.criticalBreaksFocus",
    shouldNotify({ id: "c", severity: "critical", windowFocused: true, now: 4000, state }).show === true,
  );
}
{
  const state = createNotifyState();
  let shown = 0;
  for (let i = 0; i < 8; i += 1) {
    if (shouldNotify({ id: `rl-${i}`, severity: "info", windowFocused: false, now: 1000 + i, state, maxPerWindow: 5 }).show) {
      shown += 1;
    }
  }
  check("notify.rateLimited", shown === 5);
}
check("notify.sanitizeRejectsEmpty", sanitizeNotifyPayload({ title: "x" }) === null);
check("notify.sanitizeClampsHref", sanitizeNotifyPayload({ id: "x", title: "t", href: "http://evil" })?.href === "/");
check("notify.sanitizeKeepsRelHref", sanitizeNotifyPayload({ id: "x", title: "t", href: "/chat" })?.href === "/chat");

// --- live aggregation ---
async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-attention-"));
  process.env.DATABASE_PATH = path.join(tempRoot, "attention.db");

  const { getSqlite, initializeDatabase } = await import("@/lib/db");
  const { getAttentionSummary, dismissAttentionItem } = await import("@/lib/attention/aggregate");
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO task_approvals (id, task_id, status, created_at) VALUES (?, ?, 'pending', ?)",
  ).run("ap-1", "task-1", now);
  db.prepare(
    "INSERT OR REPLACE INTO workflows (id, name, description, nodes, edges, is_active, created_at, updated_at) VALUES (?, ?, '', '[]', '[]', 1, ?, ?)",
  ).run("wf-1", "Failing Workflow", now, now);
  db.prepare(
    "INSERT INTO executions (id, workflow_id, status, trigger_type, started_at, completed_at, error) VALUES (?, ?, 'failed', 'manual', ?, ?, ?)",
  ).run("ex-1", "wf-1", now, now, "boom");

  const summary = getAttentionSummary();
  check("aggregate.hasApproval", summary.items.some((i) => i.id === "approval:ap-1"));
  check("aggregate.hasWorkflowFailure", summary.items.some((i) => i.id === "workflow:ex-1"));
  check("aggregate.criticalSortedFirst", summary.items[0]?.severity === "critical");
  check("aggregate.countsMatch", summary.counts.total === summary.items.length && summary.counts.total >= 2);

  dismissAttentionItem("approval", "ap-1");
  const after = getAttentionSummary();
  check("aggregate.dismissHidesItem", !after.items.some((i) => i.id === "approval:ap-1"));
  check("aggregate.dismissKeepsOthers", after.items.some((i) => i.id === "workflow:ex-1"));

  try {
    db.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup; Windows may briefly hold the db handle */
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\nattention-center-regression: ${results.length - failed.length}/${results.length} passed`);
    if (failed.length > 0) {
      console.error("Failed:", failed.map((r) => r.name).join(", "));
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
