#!/usr/bin/env tsx

/**
 * Windows-native live acceptance for workflow approvals and memory scope.
 * Requires a running app and a configured DeepSeek model. No credential is
 * read or printed by this script.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const BASE_URL = String(process.env.BASE_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 180_000);
const SCREENSHOT_DIR = path.resolve(process.env.SCREENSHOT_DIR || "screenshot/workflow-trust-ui");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS ${name}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function request(path: string, method = "GET", body?: unknown, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: Record<string, any> = {};
    try { json = JSON.parse(text) as Record<string, any>; } catch { /* preserve text */ }
    return { status: response.status, ms: Date.now() - started, text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function createWorkflow(name: string, nodes: unknown[], edges: unknown[]) {
  const created = await request("/api/workflows", "POST", { name, nodes, edges });
  return { ...created, id: String(created.json.data?.id || "") };
}

async function main() {
  const stamp = Date.now();
  const marker = `WORKFLOW-SCOPE-LIVE-${stamp}`;
  const agentMarker = `AGENT-SCOPE-LIVE-${stamp}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  const health = await request("/api/health");
  const modelCheck = (health.json.checks || []).find((entry: { name?: string }) => entry.name === "models");
  check("DeepSeek V4 Flash is the active live model", /deepseek-v4-flash/i.test(String(modelCheck?.details || "")), String(modelCheck?.details || ""));

  const sanity = await request("/api/channels", "POST", {
    action: "chat",
    sessionId: `workflow-scope-sanity-${stamp}`,
    message: "Reply with exactly READY",
  });
  const sanityText = String(sanity.json.data?.response || sanity.json.response || "");
  check("DeepSeek answers a real WebChat turn", /READY/i.test(sanityText), `${sanity.ms}ms ${sanityText.slice(0, 80)}`);

  const trigger = { id: "trigger", type: "manual-trigger", position: { x: 0, y: 0 }, data: { label: "Start" } };
  const storeAgent = {
    id: "store-agent",
    type: "claude-agent",
    position: { x: 240, y: 0 },
    data: {
      label: "Store workflow memory",
      systemPrompt: `Call memory_store exactly once with content ${marker}, type fact. After the tool succeeds, reply exactly STORED.`,
      enabledTools: ["memory_store"],
      maxToolCalls: 3,
      maxTokens: 300,
      temperature: 0,
      memoryAccess: "workflow",
      approvalMode: "human",
      execSecurity: "deny",
    },
  };
  const edge = { id: "edge", source: "trigger", target: "store-agent" };
  const workflowA = await createWorkflow(`Live scope A ${stamp}`, [trigger, storeAgent], [edge]);
  check("workflow A created", workflowA.status === 200 && Boolean(workflowA.id), workflowA.text.slice(0, 160));

  const workflowB = await createWorkflow(`Live scope B ${stamp}`, [trigger], []);
  check("workflow B created", workflowB.status === 200 && Boolean(workflowB.id), workflowB.text.slice(0, 160));

  const agents = await request("/api/agents");
  const defaultAgentId = String(agents.json.data?.defaultId || "default");
  const isolatedWorkspace = path.resolve(process.env.TEST_WORKSPACE_PATH || "data/live-workflow-trust-ui/workspace");
  const defaultWorkspace = await request("/api/agents", "PATCH", {
    id: defaultAgentId,
    workspacePath: isolatedWorkspace,
  });
  check("default agent uses isolated live-test workspace", defaultWorkspace.status === 200, defaultWorkspace.text.slice(0, 160));
  const secondAgentId = `scope-peer-${stamp}`;
  const secondAgent = await request("/api/agents", "POST", {
    id: secondAgentId,
    name: `Scope peer ${stamp}`,
    workspacePath: path.join(isolatedWorkspace, secondAgentId),
    isDefault: false,
  });
  check("second agent created for cross-agent isolation", secondAgent.status === 201, secondAgent.text.slice(0, 160));

  const listed = await request("/api/workflows");
  const savedA = (listed.json.data || []).find((workflow: { id?: string }) => workflow.id === workflowA.id);
  check("new workflow persists balanced approval policy", savedA?.policy?.approval?.mode === "balanced", JSON.stringify(savedA?.policy || null));
  check("new agent persists workflow-private memory", savedA?.nodes?.find((node: { id?: string }) => node.id === "store-agent")?.data?.memoryAccess === "workflow");

  await page.goto(`${BASE_URL}/workflows/${workflowA.id}`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-id="store-agent"]').click();
  const memoryControl = page.getByTestId("workflow-memory-access");
  await memoryControl.waitFor({ state: "visible", timeout: 30_000 });
  const memoryText = await memoryControl.innerText();
  check("workflow editor exposes memory visibility", /Memory visibility/i.test(memoryText));
  check("workflow editor explains workflow isolation", /Other workflows.*MEMORY\.md stay hidden/i.test(memoryText), memoryText.replace(/\s+/g, " "));
  await memoryControl.getByRole("combobox").click();
  const optionText = await page.getByRole("option").allInnerTexts();
  check("AI Agent offers run-only, workflow-private, and agent-wide choices",
    ["No durable memory", "This workflow", "This agent"].every((choice) => optionText.includes(choice)),
    optionText.join(" | "));
  await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "workflow-memory-scope.png"), fullPage: true });

  const run = await request("/api/execute", "POST", {
    workflowId: workflowA.id,
    triggerType: "manual",
    triggerData: { message: "Store the requested marker" },
  });
  const agentResult = run.json.data?.nodeResults?.["store-agent"]?.output || {};
  check("DeepSeek workflow run completes", run.json.success === true && run.json.data?.status === "completed", `${run.ms}ms status=${run.json.data?.status || run.status}`);
  check("workflow uses DeepSeek V4 Flash", /deepseek-v4-flash/i.test(String(agentResult.model || "")), String(agentResult.model || ""));

  const query = encodeURIComponent(marker);
  const own = await request(`/api/memory?action=search&query=${query}&limit=5&memoryAccess=workflow&workflowId=${encodeURIComponent(workflowA.id)}`);
  const ownRows = Array.isArray(own.json.data) ? own.json.data : [];
  check("workflow A can recall its private marker", ownRows.some((row: { content?: string }) => String(row.content || "").includes(marker)), own.text.slice(0, 220));

  const foreign = await request(`/api/memory?action=search&query=${query}&limit=5&memoryAccess=workflow&workflowId=${encodeURIComponent(workflowB.id)}`);
  check("workflow B cannot recall workflow A marker", Array.isArray(foreign.json.data) && foreign.json.data.length === 0, foreign.text.slice(0, 220));

  const sameWorkflowOtherAgent = await request(`/api/memory?action=search&query=${query}&limit=5&memoryAccess=workflow&workflowId=${encodeURIComponent(workflowA.id)}&agentId=${encodeURIComponent(secondAgentId)}`);
  check("same workflow id cannot cross agent ownership", Array.isArray(sameWorkflowOtherAgent.json.data) && sameWorkflowOtherAgent.json.data.length === 0, sameWorkflowOtherAgent.text.slice(0, 220));

  const none = await request(`/api/memory?action=search&query=${query}&limit=5&memoryAccess=none&workflowId=${encodeURIComponent(workflowA.id)}`);
  check("no-durable scope returns no memory", none.status === 200 && Array.isArray(none.json.data) && none.json.data.length === 0, none.text.slice(0, 220));

  const agentWrite = await request("/api/memory", "POST", {
    agentId: defaultAgentId,
    memoryAccess: "agent",
    content: agentMarker,
    type: "fact",
    source: "workflow-scope-live",
  });
  check("agent-wide memory can be stored explicitly", agentWrite.status === 200 && agentWrite.json.success === true, agentWrite.text.slice(0, 180));
  const agentQuery = encodeURIComponent(agentMarker);
  const ownAgent = await request(`/api/memory?action=search&query=${agentQuery}&limit=5&memoryAccess=agent&agentId=${encodeURIComponent(defaultAgentId)}`);
  check("selected agent can recall its shared memory", Array.isArray(ownAgent.json.data) && ownAgent.json.data.some((row: { content?: string }) => String(row.content || "").includes(agentMarker)), ownAgent.text.slice(0, 220));
  const workflowCannotReadAgent = await request(`/api/memory?action=search&query=${agentQuery}&limit=5&memoryAccess=workflow&workflowId=${encodeURIComponent(workflowA.id)}&agentId=${encodeURIComponent(defaultAgentId)}`);
  check("workflow-private scope excludes agent-wide memory",
    Array.isArray(workflowCannotReadAgent.json.data) && !workflowCannotReadAgent.json.data.some((row: { content?: string }) => String(row.content || "").includes(agentMarker)),
    workflowCannotReadAgent.text.slice(0, 220));
  const otherAgent = await request(`/api/memory?action=search&query=${agentQuery}&limit=5&memoryAccess=agent&agentId=${encodeURIComponent(secondAgentId)}`);
  check("another agent cannot recall agent-wide memory", Array.isArray(otherAgent.json.data) && otherAgent.json.data.length === 0, otherAgent.text.slice(0, 220));

  const ownPath = String(ownRows[0]?.path || "");
  if (ownPath) {
    const foreignGet = await request(`/api/memory?action=get&path=${encodeURIComponent(ownPath)}&memoryAccess=workflow&workflowId=${encodeURIComponent(workflowB.id)}`);
    check("direct memory_get cannot bypass workflow scope", foreignGet.status === 403, `${foreignGet.status} ${foreignGet.text.slice(0, 160)}`);
  } else {
    check("direct memory_get cannot bypass workflow scope", false, "no workflow memory path was returned");
  }

  const sendNode = {
    id: "send",
    type: "send-webchat",
    position: { x: 240, y: 0 },
    data: { label: "Approval-gated send", message: `approved-${stamp}` },
  };
  const approvalWorkflow = await createWorkflow(
    `Live approval ${stamp}`,
    [trigger, sendNode],
    [{ id: "send-edge", source: "trigger", target: "send" }],
  );
  check("approval workflow created", approvalWorkflow.status === 200 && Boolean(approvalWorkflow.id));

  const executePromise = request("/api/execute", "POST", {
    workflowId: approvalWorkflow.id,
    triggerType: "manual",
    triggerData: { message: `runtime-payload-${stamp}` },
  }, 30_000);

  let pending: Record<string, any> | null = null;
  for (let attempt = 0; attempt < 40 && !pending; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const approvals = await request("/api/workflow-approvals");
    pending = (approvals.json.data || []).find((entry: { workflowId?: string }) => entry.workflowId === approvalWorkflow.id) || null;
  }
  check("external send pauses before execution", Boolean(pending?.id), pending ? String(pending.id) : "no pending approval");
  if (pending?.id) {
    await page.goto(`${BASE_URL}/approvals`, { waitUntil: "domcontentloaded" });
    await page.getByText(`Live approval ${stamp}`, { exact: false }).waitFor({ state: "visible", timeout: 30_000 });
    const approvalText = await page.locator("body").innerText();
    check("approval UI names the workflow and step", approvalText.includes(`Live approval ${stamp}`) && approvalText.includes("Approval-gated send"));
    check("approval UI explains deterministic pre-execution check", /checked before it runs/i.test(approvalText));
    check("approval UI shows the exact bound payload", approvalText.includes(`runtime-payload-${stamp}`));
    check("approval UI exposes one-time allow and deny", /ALLOW ONCE/i.test(approvalText) && /DENY/i.test(approvalText));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "workflow-approval-pending.png"), fullPage: true });
    await page.getByRole("button", { name: "Allow Once" }).first().click();
    await page.getByText("Exact action preview with secrets redacted", { exact: true }).waitFor({ state: "hidden", timeout: 30_000 });
    check("operator approval accepted through UI", true);
  }
  const approvedRun = await executePromise;
  check("approved send completes exactly through the guarded run", approvedRun.json.success === true && approvedRun.json.data?.status === "completed", approvedRun.text.slice(0, 220));

  const dryRun = await request("/api/workflows/dry-run", "POST", {
    workflowId: approvalWorkflow.id,
    nodes: [trigger, sendNode],
    edges: [{ id: "send-edge", source: "trigger", target: "send" }],
    triggerType: "manual",
  });
  check("dry-run reports one approval-gated effect", dryRun.json.data?.effectSummary?.needsApproval === 1, JSON.stringify(dryRun.json.data?.effectSummary || null));

  const toolMarker = `NESTED-POST-${stamp}`;
  const toolAgent = {
    id: "tool-agent",
    type: "claude-agent",
    position: { x: 240, y: 0 },
    data: {
      label: "Approval-gated HTTP agent",
      systemPrompt: `Call http_request exactly once using POST to https://example.com/disp8ch-live-check with body ${toolMarker}. Do not replace it with a read request.`,
      enabledTools: ["http_request"],
      maxToolCalls: 2,
      maxTokens: 350,
      temperature: 0,
      memoryAccess: "none",
      approvalMode: "off",
      execSecurity: "deny",
    },
  };
  const nestedWorkflow = await createWorkflow(
    `Nested tool approval ${stamp}`,
    [trigger, toolAgent],
    [{ id: "tool-edge", source: "trigger", target: "tool-agent" }],
  );
  check("nested-tool workflow created", nestedWorkflow.status === 200 && Boolean(nestedWorkflow.id));
  const nestedRunPromise = request("/api/execute", "POST", {
    workflowId: nestedWorkflow.id,
    triggerType: "manual",
    triggerData: { message: "Perform the exact POST now" },
  });
  let toolPending: Record<string, any> | null = null;
  for (let attempt = 0; attempt < 120 && !toolPending; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const approvals = await request("/api/tool-approvals");
    toolPending = (approvals.json.data || []).find((entry: { name?: string; args?: { body?: string } }) =>
      entry.name === "http_request" && String(entry.args?.body || "").includes(toolMarker)) || null;
  }
  check("DeepSeek nested HTTP POST is stopped before execution", Boolean(toolPending?.id), toolPending ? String(toolPending.id) : "no pending tool approval");
  if (toolPending?.id) {
    check("nested approval retains exact non-secret action", String(toolPending.args?.body || "").includes(toolMarker));
    await page.goto(`${BASE_URL}/approvals`, { waitUntil: "domcontentloaded" });
    await page.getByText("http_request", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    const toolApprovalText = await page.locator("body").innerText();
    check("tool approval UI explains external effect", /External action needs approval|Effect: external_write/i.test(toolApprovalText));
    check("tool approval UI shows the requested method and body", toolApprovalText.includes("POST") && toolApprovalText.includes(toolMarker));
    check("tool approval UI offers only one-time authorization", !/Always Allow/i.test(toolApprovalText));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "nested-tool-approval-pending.png"), fullPage: true });
    await page.getByRole("button", { name: "Deny" }).last().click();
  }
  const nestedRun = await nestedRunPromise;
  check("denied nested action never becomes an HTTP result", !JSON.stringify(nestedRun.json).includes("Example Domain"), nestedRun.text.slice(0, 180));

  await browser.close();

  console.log(`\nworkflow-approval-memory-deepseek-live: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
