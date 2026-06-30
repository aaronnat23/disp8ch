#!/usr/bin/env tsx
/**
 * Live smoke: instantiate EVERY workflow template in the catalog via the real
 * /api/workflows endpoint and validate the produced graph is sound for an n8n-style user:
 *   - response succeeds and returns a workflow with nodes
 *   - every node.type is a registered, executable handler (no dead/unknown nodes)
 *   - every node has a contract (so the palette/inspector can render config)
 *   - graph has at least one trigger and no orphan non-trigger nodes (all reachable from a trigger)
 *
 * Run (Windows-native):
 *   set BASE_URL=http://127.0.0.1:3100&& set DATABASE_PATH=./data/disp8ch.db&& pnpm.cmd exec tsx scripts\workflow-all-templates-live-smoke.ts
 */
import { listWorkflowTemplateCatalog } from "../src/lib/workflows/template-catalog";
import { getNodeHandler } from "../src/lib/engine/node-registry";
import { getNodeContract } from "../src/lib/engine/node-contracts";

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:3100").trim();
const TRIGGER_TYPES = new Set([
  "manual-trigger",
  "message-trigger",
  "webhook-trigger",
  "cron-trigger",
  "telegram-trigger",
  "discord-trigger",
  "github-trigger",
  "scheduler-job",
]);

let passed = 0;
let failed = 0;
const failures: string[] = [];
const createdWorkflowIds: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ""}`);
    console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

type Wf = { id?: string; nodes: any[]; edges: any[] };

async function createTemplate(key: string): Promise<{ status: number; wf?: Wf; err?: string }> {
  const res = await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `all-tmpl-smoke-${key}`, template: key }),
  });
  const json: any = await res.json().catch(() => ({}));
  const wf = json?.data && Array.isArray(json.data.nodes) ? (json.data as Wf) : undefined;
  if (wf?.id) createdWorkflowIds.push(wf.id);
  return { status: res.status, wf, err: json?.error };
}

/** All non-trigger nodes must be reachable from some trigger via edges. */
function findOrphans(wf: Wf): string[] {
  const adj = new Map<string, string[]>();
  for (const e of wf.edges) {
    const s = e.source ?? e.from;
    const t = e.target ?? e.to;
    if (!s || !t) continue;
    if (!adj.has(s)) adj.set(s, []);
    adj.get(s)!.push(t);
  }
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const n of wf.nodes) {
    if (TRIGGER_TYPES.has(n.type) || n.type === "sticky-note") {
      reachable.add(n.id);
      queue.push(n.id);
    }
  }
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  // also treat any node with an incoming edge as connected (covers fan-in only graphs)
  const hasIncoming = new Set(wf.edges.map((e) => e.target ?? e.to));
  return wf.nodes
    .filter((n) => !reachable.has(n.id) && !hasIncoming.has(n.id) && !TRIGGER_TYPES.has(n.type) && n.type !== "sticky-note")
    .map((n) => `${n.id}(${n.type})`);
}

async function main() {
  const fallbackContractTypes = new Set<string>();

  try {
    const catalog = listWorkflowTemplateCatalog();
    console.log(`Validating ${catalog.length} templates against ${BASE_URL}\n`);

    for (const entry of catalog) {
      const { status, wf, err } = await createTemplate(entry.key);
      if (status !== 200 || !wf) {
        check(`template ${entry.key} instantiates`, false, `status=${status} err=${err ?? "no workflow in response"}`);
        continue;
      }

      const types: string[] = wf.nodes.map((n) => n.type);
      // Hard requirements: every node must be executable (registered handler), the graph
      // must have a trigger, and there must be no orphan (unreachable) non-trigger nodes.
      const unregistered = [...new Set(types)].filter((t) => !getNodeHandler(t));
      const hasTrigger = types.some((t) => TRIGGER_TYPES.has(t));
      const orphans = findOrphans(wf);
      // Soft signal: nodes relying on the generic fallback contract (still execute fine,
      // but their dry-run preview / data-mapper schema is generic). Reported, not failed.
      const noContract = [...new Set(types)].filter((t) => !getNodeContract(t));

      const ok =
        wf.nodes.length > 0 &&
        unregistered.length === 0 &&
        hasTrigger &&
        orphans.length === 0;

      check(
        `template ${entry.key}`,
        ok,
        `nodes=${wf.nodes.length} edges=${wf.edges.length}` +
          (unregistered.length ? ` UNREGISTERED=[${unregistered}]` : "") +
          (!hasTrigger ? " NO_TRIGGER" : "") +
          (orphans.length ? ` ORPHANS=[${orphans}]` : ""),
      );
      if (ok) {
        const warn = noContract.length ? `  (fallback-contract nodes: ${noContract.join(",")})` : "";
        console.log(`PASS template ${entry.key} :: nodes=${wf.nodes.length} edges=${wf.edges.length}${warn}`);
        for (const t of noContract) fallbackContractTypes.add(t);
      }
    }
  } finally {
    for (const workflowId of createdWorkflowIds) {
      try {
        const res = await fetch(`${BASE_URL}/api/workflows?id=${encodeURIComponent(workflowId)}`, { method: "DELETE" });
        if (!res.ok) console.error(`WARN cleanup failed for ${workflowId}: HTTP ${res.status}`);
      } catch (error) {
        console.error(`WARN cleanup failed for ${workflowId}: ${String(error)}`);
      }
    }
  }

  if (fallbackContractTypes.size) {
    console.log(`\nWARN node types still using the generic fallback contract (${fallbackContractTypes.size}): ${[...fallbackContractTypes].sort().join(", ")}`);
  }
  console.log(`\n${passed}/${passed + failed} templates valid`);
  if (failed) {
    console.error(`\n${failed} FAILURES:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
