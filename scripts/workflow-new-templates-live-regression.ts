#!/usr/bin/env tsx
/**
 * Windows-native live regression for the two general-purpose workflow templates.
 * Requires a running app and one active model. Test workflows are deleted on exit.
 *
 * Run:
 *   set BASE_URL=http://127.0.0.1:3100&& pnpm.cmd exec tsx scripts\workflow-new-templates-live-regression.ts
 */

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Json = Record<string, unknown>;
type WorkflowNode = { id: string; type: string; data?: Record<string, unknown> };
type Workflow = { id: string; nodes: WorkflowNode[]; edges: unknown[] };
type Execution = { status: string; nodeResults?: Record<string, { output?: Record<string, unknown> }> };

let passed = 0;
let failed = 0;
const failures: string[] = [];
const createdWorkflowIds: string[] = [];

function check(name: string, ok: unknown, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS ${name}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ""}`);
    console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function request(path: string, method = "GET", body?: unknown): Promise<{ status: number; payload: Json }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Json;
  return { status: response.status, payload };
}

function workflowFrom(payload: Json): Workflow | null {
  const data = payload.data;
  return data && typeof data === "object" && Array.isArray((data as Workflow).nodes)
    ? (data as Workflow)
    : null;
}

function nodeByLabel(workflow: Workflow, label: string): WorkflowNode | undefined {
  return workflow.nodes.find((node) => String(node.data?.label ?? "") === label);
}

async function createTemplate(template: string): Promise<Workflow | null> {
  const response = await request("/api/workflows", "POST", {
    name: `live-template-${template}-${RUN_ID}`,
    template,
  });
  const workflow = workflowFrom(response.payload);
  check(`${template} creates`, response.status === 200 && Boolean(workflow), `status=${response.status}`);
  if (workflow?.id) createdWorkflowIds.push(workflow.id);
  return workflow;
}

async function execute(workflowId: string, body: Json): Promise<Execution | null> {
  const response = await request("/api/execute", "POST", { workflowId, triggerType: "manual", ...body });
  const data = response.payload.data;
  const execution = data && typeof data === "object" ? (data as Execution) : null;
  check(`execution ${workflowId} completes`, response.status === 200 && execution?.status === "completed", `status=${response.status} execution=${execution?.status ?? "missing"}`);
  return execution;
}

function responseOf(execution: Execution | null, node: WorkflowNode | undefined): string {
  if (!execution || !node) return "";
  const output = execution.nodeResults?.[node.id]?.output ?? {};
  return String(output.response ?? output.content ?? "");
}

async function main() {
  try {
    const health = await request("/api/health");
    check("server is healthy", health.status === 200 && health.payload.success === true, `status=${health.status}`);
    const healthData = health.payload.data as Json | undefined;
    const checks = Array.isArray(healthData?.checks) ? healthData.checks : [];
    check("active model is available", checks.some((entry) => String((entry as Json).name) === "models" && String((entry as Json).status) === "ok"));

    const strategy = await createTemplate("strategy-hardening-loop");
    if (strategy) {
      const labels = new Set(strategy.nodes.map((node) => String(node.data?.label ?? "")));
      const agentNodes = strategy.nodes.filter((node) => node.type === "claude-agent");
      check("strategy loop has four review stages", ["Research Evidence", "Draft Strategy", "Adversarial Review", "Revised Strategy"].every((label) => labels.has(label)));
      check("strategy loop inherits the active model", agentNodes.length === 4 && agentNodes.every((node) => node.data?.model === ""), `agents=${agentNodes.length}`);

      const revised = nodeByLabel(strategy, "Revised Strategy");
      const execution = revised
        ? await execute(strategy.id, {
            executionMode: "partial",
            targetNodeId: revised.id,
            triggerData: {
              message: "Create a practical rollout strategy for a small local community newsletter.",
              sessionId: `strategy-template-${RUN_ID}`,
            },
          })
        : null;
      const output = responseOf(execution, revised);
      check("strategy loop returns a decision-ready review", /recommendation/i.test(output) && /approval decision/i.test(output), output.slice(0, 240));
    }

    const support = await createTemplate("support-signal-triage");
    if (support) {
      const types = new Set(support.nodes.map((node) => node.type));
      const agentNodes = support.nodes.filter((node) => node.type === "claude-agent");
      check("support triage avoids external-send nodes", !types.has("send-email") && !types.has("send-telegram") && !types.has("send-whatsapp"));
      check("support triage inherits the active model", agentNodes.length === 2 && agentNodes.every((node) => node.data?.model === ""), `agents=${agentNodes.length}`);

      const draft = nodeByLabel(support, "Draft Human Review Reply");
      const execution = await execute(support.id, {
        triggerData: {
          message: "I was charged twice for this month. Please confirm what happened and whether I will receive a refund.",
          channel: "webchat",
          sessionId: `support-template-${RUN_ID}`,
        },
      });
      const output = responseOf(execution, draft);
      check("support triage returns a review-only draft", /draft\s*-?\s*human review required/i.test(output), output.slice(0, 240));
      check(
        "support triage does not imply an external action occurred",
        !/has been flagged|i(?:'|’)ve noted|will follow up|a team member/i.test(output),
        output.slice(0, 240),
      );
    }
  } finally {
    for (const workflowId of createdWorkflowIds) {
      const response = await request(`/api/workflows?id=${encodeURIComponent(workflowId)}`, "DELETE");
      check(`cleanup ${workflowId}`, response.status === 200, `status=${response.status}`);
    }
  }

  console.log(`\nworkflow-new-templates-live-regression: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
