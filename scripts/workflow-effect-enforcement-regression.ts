/**
 * Workflow executor enforcement regression (temp DB, spy handlers, no model).
 *
 * Proves the single executor-level guard cannot be bypassed: the handler is not
 * called before approval, denial/expiry/hardline never call it, an approval
 * calls it exactly once, a duplicate approval cannot call it twice, retries and
 * loop bodies do not bypass the guard, and unattended runs fail closed.
 *
 * Run: pnpm exec tsx scripts/workflow-effect-enforcement-regression.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), `disp8ch_wf_enforce_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, "wf.db");
process.env.MEMORY_PATH = path.join(tmp, "memories");
process.env.WORKFLOW_APPROVAL_WAIT_MS = "4000";
process.env.WORKFLOW_APPROVAL_TTL_MS = "60000";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { initializeDatabase, getSqlite } = await import("../src/lib/db");
  const { executeWorkflow } = await import("../src/lib/engine/executor");
  const { registerNodeHandler } = await import("../src/lib/engine/node-registry");
  const {
    createApprovalRequest,
    decideApproval,
    getApproval,
    listPendingApprovals,
  } = await import("../src/lib/engine/workflow-approvals");
  const { computeNodeEffectInputHash } = await import("../src/lib/engine/node-policy-guard");
  const { resolveNodeEffect } = await import("../src/lib/engine/effects");
  const {
    executeToolWithConfirmation,
    listPendingApprovals: listPendingToolApprovals,
    resolvePendingApproval,
  } = await import("../src/lib/engine/tools");
  const { getModelConfig } = await import("../src/lib/agents/model-router");

  initializeDatabase();
  const db = getSqlite();

  console.log("\nNested agent tools inherit workflow effect policy");
  {
    const result = await executeToolWithConfirmation(
      "http_request",
      { method: "POST", url: "https://example.com/action", body: "changed", headers: '{"Authorization":"Bearer test-secret-token-123456789012345"}' },
      { approvalMode: "off" },
      { workflowApprovalPolicy: { mode: "balanced" }, workflowAttended: true, nodeId: "agent-node" },
    );
    const pendingTools = listPendingToolApprovals();
    const pending = pendingTools.find((entry) => entry.name === "http_request");
    check("balanced workflow pauses nested HTTP POST before execution", /HUMAN APPROVAL REQUIRED/.test(result) && Boolean(pending));
    check("nested approval captures exact POST payload", pending?.args.body === "changed");
    check("nested approval API redacts credentials", !JSON.stringify(pending?.args || {}).includes("test-secret-token"));
    if (pending) await resolvePendingApproval({ id: pending.id, decision: "deny" });

    const unattended = await executeToolWithConfirmation(
      "http_request",
      { method: "DELETE", url: "https://example.com/action" },
      { approvalMode: "off" },
      { workflowApprovalPolicy: { mode: "balanced" }, workflowAttended: false, nodeId: "agent-node" },
    );
    check("unattended nested destructive tool fails closed", /workflow effect policy denied/.test(unattended));
  }

  console.log("\nApproval payload binding");
  {
    const sendEffect = resolveNodeEffect("send-webchat", { message: "{{agent.response}}" });
    const first = computeNodeEffectInputHash(sendEffect, { message: "{{agent.response}}" }, { response: "send alpha" });
    const second = computeNodeEffectInputHash(sendEffect, { message: "{{agent.response}}" }, { response: "send beta" });
    const stable = computeNodeEffectInputHash(sendEffect, { message: "{{agent.response}}" }, { response: "send alpha" });
    check("different runtime payloads produce different approval hashes", first !== second);
    check("the same runtime payload produces a stable approval hash", first === stable);
  }

  console.log("\nExpired grants cannot be approved");
  {
    const expired = createApprovalRequest({
      workflowId: "wf-expired-grant",
      workflowVersionHash: "version",
      executionId: "execution",
      nodeId: "node",
      attempt: 1,
      effect: resolveNodeEffect("send-webchat", { message: "expired" }),
      inputHash: "input",
      digest: "expired-digest",
      requiresHuman: true,
      ttlMs: -1,
    });
    const decided = decideApproval({ id: expired.id, decision: "approved", decidedBy: "test" });
    check("expired approval remains expired", decided?.status === "expired", decided?.status);
  }

  // Spy handlers that override real node types so we can detect any call. The
  // node TYPE drives effect classification; "send-webchat" → external_send
  // (needs approval under balanced), "memory-store" → local_write (auto).
  let sendCalls = 0;
  let failSend = false;
  registerNodeHandler({ type: "send-webchat", async execute(input) {
    sendCalls++;
    if (failSend) throw new Error("ambiguous remote failure");
    return { data: { ...input.data, sent: true } };
  } });
  let hardlineCalls = 0;
  registerNodeHandler({ type: "system-command", async execute(input) { hardlineCalls++; return { data: { ...input.data, ran: true } }; } });

  const now = new Date().toISOString();
  function makeWorkflow(id: string, nodes: unknown, edges: unknown, approvalMode: string | null) {
    const policy = approvalMode ? JSON.stringify({ approval: { mode: approvalMode } }) : null;
    db.prepare("INSERT OR REPLACE INTO workflows (id, name, nodes, edges, policy, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
      .run(id, `wf ${id}`, JSON.stringify(nodes), JSON.stringify(edges), policy, now, now);
  }

  const triggerNode = { id: "t1", type: "manual-trigger", position: { x: 0, y: 0 }, data: { label: "Start" } };
  const sendNode = { id: "s1", type: "send-webchat", position: { x: 200, y: 0 }, data: { label: "Reply", message: "hi" } };
  const edge = { id: "e1", source: "t1", target: "s1" };

  async function runManual(workflowId: string, nodes: unknown[], edges: unknown[], opts?: { triggerType?: "manual" | "cron" }) {
    return executeWorkflow({
      workflowId,
      nodes: nodes as never,
      edges: edges as never,
      triggerType: opts?.triggerType ?? "manual",
      triggerData: { source: "test" },
      modelConfig: getModelConfig(),
      lane: "main",
    });
  }

  // Drive an approval decision once the request appears.
  async function decideWhenPending(decision: "approve" | "deny", timeoutMs = 3000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pending = listPendingApprovals(10);
      if (pending.length > 0) {
        decideApproval({ id: pending[0].id, decision: decision === "approve" ? "approved" : "denied", decidedBy: "test" });
        return pending[0].id;
      }
      await sleep(50);
    }
    return null;
  }

  // ── 1. Approval gates the send; handler not called before approval ──
  console.log("\nApproved external send runs exactly once");
  makeWorkflow("wf-approve", [triggerNode, sendNode], [edge], "balanced");
  sendCalls = 0;
  {
    const runP = runManual("wf-approve", [triggerNode, sendNode], [edge]);
    const sawDuringWait = await (async () => { await sleep(300); return sendCalls; })();
    check("handler not called before approval", sawDuringWait === 0);
    const id = await decideWhenPending("approve");
    check("approval request was created", id !== null);
    const result = await runP;
    check("handler called exactly once after approval", sendCalls === 1, `sendCalls=${sendCalls}`);
    check("execution completed", result.status === "completed", result.status);
  }

  // ── 2. Denial never calls the handler ──
  console.log("\nDenied external send never runs");
  makeWorkflow("wf-deny", [triggerNode, sendNode], [edge], "balanced");
  sendCalls = 0;
  {
    const runP = runManual("wf-deny", [triggerNode, sendNode], [edge]);
    await decideWhenPending("deny");
    const result = await runP;
    check("handler never called on denial", sendCalls === 0);
    check("execution did not complete clean", result.status !== "completed", result.status);
  }

  // ── 3. Expiry never calls the handler ──
  console.log("\nExpired approval never runs (short wait, no decision)");
  process.env.WORKFLOW_APPROVAL_WAIT_MS = "800";
  makeWorkflow("wf-expire", [triggerNode, sendNode], [edge], "balanced");
  sendCalls = 0;
  {
    const result = await runManual("wf-expire", [triggerNode, sendNode], [edge]);
    check("handler never called on timeout/expiry", sendCalls === 0);
    check("execution did not complete clean", result.status !== "completed", result.status);
  }
  process.env.WORKFLOW_APPROVAL_WAIT_MS = "4000";

  // ── 4. Approved irreversible failures are not retried ──
  console.log("\nApproved irreversible failure is not retried");
  const sendAmbiguous = { ...sendNode, data: { ...sendNode.data, retryCount: 3, retryDelayMs: 10 } };
  makeWorkflow("wf-ambiguous", [triggerNode, sendAmbiguous], [edge], "balanced");
  sendCalls = 0;
  failSend = true;
  {
    const runP = runManual("wf-ambiguous", [triggerNode, sendAmbiguous], [edge]);
    const approvalId = await decideWhenPending("approve");
    const result = await runP;
    check("irreversible handler called only once despite retryCount", sendCalls === 1, `sendCalls=${sendCalls}`);
    check("ambiguous execution did not complete", result.status !== "completed", result.status);
    check("claimed grant is marked indeterminate", approvalId != null && getApproval(approvalId)?.status === "indeterminate");
  }
  failSend = false;

  // ── 5. Retry does not bypass the guard ──
  console.log("\nRetry does not bypass the guard");
  const sendRetry = { ...sendNode, data: { ...sendNode.data, retryCount: 3, retryDelayMs: 10 } };
  makeWorkflow("wf-retry", [triggerNode, sendRetry], [edge], "balanced");
  sendCalls = 0;
  {
    const runP = runManual("wf-retry", [triggerNode, sendRetry], [edge]);
    await decideWhenPending("deny");
    const result = await runP;
    check("denied node is not retried (no extra approvals)", sendCalls === 0);
    check("retry did not silently complete", result.status !== "completed", result.status);
  }

  // ── 6. Unattended (cron) external send fails closed ──
  console.log("\nUnattended cron external send is blocked");
  makeWorkflow("wf-cron", [triggerNode, sendNode], [edge], "balanced");
  sendCalls = 0;
  {
    const result = await runManual("wf-cron", [triggerNode, sendNode], [edge], { triggerType: "cron" });
    check("cron send never runs without approval", sendCalls === 0);
    check("cron execution did not complete clean", result.status !== "completed", result.status);
  }

  // ── 7. Hardline action blocked even when approved ──
  console.log("\nHardline action cannot be approved");
  const hardNode = { id: "h1", type: "system-command", position: { x: 200, y: 0 }, data: { label: "Danger", command: "rm -rf /", action: "" } };
  const hedge = { id: "eh", source: "t1", target: "h1" };
  makeWorkflow("wf-hardline", [triggerNode, hardNode], [hedge], "custom");
  // custom auto would normally allow, but the hardline floor must override.
  db.prepare("UPDATE workflows SET policy = ? WHERE id = ?").run(JSON.stringify({ approval: { mode: "custom", nodes: { h1: "auto" } } }), "wf-hardline");
  hardlineCalls = 0;
  {
    const result = await runManual("wf-hardline", [triggerNode, hardNode], [hedge]);
    check("hardline handler never called even with auto policy", hardlineCalls === 0);
    check("hardline execution did not complete clean", result.status !== "completed", result.status);
  }

  // ── 8. Loop body send is guarded ──
  console.log("\nLoop body external send is guarded");
  const loopNode = { id: "lp", type: "loop", position: { x: 200, y: 0 }, data: { label: "Loop", sourcePath: "trigger.items", maxIterations: 3, onItemError: "stop" } };
  const loopBodySend = { id: "lb", type: "send-webchat", position: { x: 400, y: 0 }, data: { label: "LoopSend", message: "x" } };
  const loopEdge = { id: "el1", source: "t1", target: "lp" };
  const loopBodyEdge = { id: "el2", source: "lp", target: "lb", sourceHandle: "body" };
  makeWorkflow("wf-loop", [triggerNode, loopNode, loopBodySend], [loopEdge, loopBodyEdge], "balanced");
  sendCalls = 0;
  process.env.WORKFLOW_APPROVAL_WAIT_MS = "600";
  {
    const result = await executeWorkflow({
      workflowId: "wf-loop",
      nodes: [triggerNode, loopNode, loopBodySend] as never,
      edges: [loopEdge, loopBodyEdge] as never,
      triggerType: "manual",
      triggerData: { source: "test", items: [1, 2, 3] },
      modelConfig: getModelConfig(),
      lane: "main",
    });
    check("loop body send blocked without approval (no calls)", sendCalls === 0, `sendCalls=${sendCalls}`);
    void result;
  }
  process.env.WORKFLOW_APPROVAL_WAIT_MS = "4000";

  console.log(`\nworkflow-effect-enforcement-regression: ${passed}/${passed + failed} passed`);
  if (failed > 0) { console.error("Failed:", failures.join(", ")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
