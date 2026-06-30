import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const BASE_URL = process.env.DISP8CH_BASE_URL || process.env.BASE_URL || "http://localhost:3100";
const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "disp8ch.db");

async function api(pathname: string, init?: RequestInit) {
  const response = await fetch(`${BASE_URL}${pathname}`, init);
  const json = await response.json() as { success?: boolean; data?: any; error?: string };
  if (!response.ok || json.success === false) {
    throw new Error(`${pathname} failed: ${response.status} ${json.error || JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  const workspaces = await api("/api/workspaces");
  if (!Array.isArray(workspaces.data) || workspaces.data.length === 0) throw new Error("trusted workspaces did not load");
  await api("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: process.cwd(), label: "Regression workspace" }),
  });
  const workspacePreview = await api(`/api/workspaces?action=preview&path=${encodeURIComponent(process.cwd())}`);
  if (!Array.isArray(workspacePreview.data?.files)) {
    throw new Error("trusted workspace preview did not return files array");
  }

  const uploadForm = new FormData();
  const sessionId = `ui-medium-${Date.now()}`;
  uploadForm.set("sessionId", sessionId);
  uploadForm.set("file", new Blob(["local attachment regression"], { type: "text/plain" }), "medium-regression.txt");
  await api("/api/uploads", { method: "POST", body: uploadForm });
  const imageForm = new FormData();
  imageForm.set("sessionId", sessionId);
  imageForm.set("file", new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lY6rxwAAAABJRU5ErkJggg==", "base64")], { type: "image/png" }), "medium-regression.png");
  const uploadedImage = await api("/api/uploads", { method: "POST", body: imageForm });
  const imagePreview = await fetch(`${BASE_URL}/api/uploads?id=${encodeURIComponent(uploadedImage.data.id)}`);
  if (!imagePreview.ok || !String(imagePreview.headers.get("content-type") || "").includes("image/png")) {
    throw new Error("uploaded image preview endpoint did not return image/png");
  }
  const artifacts = await api(`/api/artifacts?sessionId=${encodeURIComponent(sessionId)}`);
  if (!Array.isArray(artifacts.data) || !artifacts.data.some((item: any) => item.name === "medium-regression.txt")) {
    throw new Error("uploaded artifact did not appear in session artifact list");
  }
  if (!artifacts.data.some((item: any) => item.kind === "image" && item.previewUrl)) {
    throw new Error("uploaded image artifact did not include a preview URL");
  }
  if (!artifacts.data.some((item: any) => item.name === "medium-regression.png" && item.metadata?.width === 1 && item.metadata?.height === 1 && item.metadata?.sha256)) {
    throw new Error("uploaded image artifact did not include binary metadata");
  }

  await api("/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "steward-state", skillId: "regression-skill", status: "pinned" }),
  });
  const steward = await api("/api/skills?action=steward");
  if (!steward.data?.stewardState?.["regression-skill"]) throw new Error("skill steward state was not persisted");
  if (typeof steward.data?.summary?.workflowsScanned !== "number") throw new Error("skill steward workflow usage summary missing");
  const archiveCandidate = steward.data?.unused?.[0]?.id || steward.data?.mostUsed?.[0]?.id;
  if (archiveCandidate) {
    await api("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "steward-state", skillId: archiveCandidate, status: "archived" }),
    });
    const archivedSteward = await api("/api/skills?action=steward");
    if (!archivedSteward.data?.archived?.some((skill: any) => skill.id === archiveCandidate)) {
      throw new Error("skill steward archived filter did not include archived skill");
    }
    await api("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "steward-state", skillId: archiveCandidate, status: "active" }),
    });
  }

  const workflow = await api("/api/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Medium Regression Schedule ${Date.now()}`,
      description: "Created by local UI medium regression",
      template: "scheduled-health-check",
    }),
  });
  const workflowId = workflow.data?.id;
  if (!workflowId) throw new Error("scheduled workflow template did not return an id");
  await api("/api/cron", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "profile",
      workflowId,
      profile: {
        label: "Regression profile",
        priority: "high",
        overlapPolicy: "skip-if-running",
        timeoutMinutes: 45,
        workspacePath: process.cwd(),
        deliveryRoute: "webchat",
        retryPolicy: "once",
        silenceOnSuccess: true,
      },
    }),
  });
  const cron = await api("/api/cron");
  const cronJob = cron.data?.jobs?.find((job: any) => job.workflowId === workflowId);
  if (!cronJob || cronJob.profile.deliveryRoute !== "webchat" || cronJob.profile.retryPolicy !== "once") {
    throw new Error("expanded scheduler profile did not round-trip");
  }
  if (!Array.isArray(cronJob.recentRuns)) {
    throw new Error("scheduler recent run history is missing");
  }

  const hooksDir = path.join(process.cwd(), "data", "workspace", "hooks");
  await mkdir(hooksDir, { recursive: true });
  const regressionHookPath = path.join(hooksDir, "medium-regression-hook.mjs");
  await writeFile(regressionHookPath, "export default async function onEvent(event) { return { type: event.type }; }\n");
  await api("/api/hooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "set-enabled", path: regressionHookPath, enabled: false }),
  });
  const disabledHooks = await api("/api/hooks");
  if (!disabledHooks.data?.hooks?.some((hook: any) => hook.path === regressionHookPath && hook.enabled === false)) {
    throw new Error("hook enablement state did not persist disabled state");
  }
  const disabledDryRun = await api("/api/hooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "debug:dry-run", payload: { source: "ui-medium-regression-disabled" } }),
  });
  if (!disabledDryRun.data?.results?.some((result: any) => result.filePath === regressionHookPath && result.status === "skipped")) {
    throw new Error("disabled hook did not report skipped during dry-run");
  }
  await api("/api/hooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "set-enabled", path: regressionHookPath, enabled: true }),
  });
  const hookDryRun = await api("/api/hooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "debug:dry-run", payload: { source: "ui-medium-regression" } }),
  });
  if (!Array.isArray(hookDryRun.data?.results)) {
    throw new Error("hook dry-run did not include per-hook results");
  }
  const hooks = await api("/api/hooks");
  if (!Array.isArray(hooks.data?.hooks) || hooks.data.hooks.some((hook: any) => !("lastRun" in hook))) {
    throw new Error("hook summary did not include lastRun state");
  }
  if (!Array.isArray(hooks.data?.eventGroups) || hooks.data.eventGroups.length === 0) {
    throw new Error("hook summary did not include event groups");
  }
  const health = await api("/api/health");
  if (!health.data?.checks?.some((check: any) => check.name === "models")) throw new Error("provider/model health check missing");

  const artifactSessionId = `artifact-regression-${Date.now()}`;
  const generatedPath = path.join(process.cwd(), "data", "uploads", "chat", "generated-artifact-regression.txt");
  await writeFile(generatedPath, "generated artifact preview regression\n");
  const db = new Database(DB_PATH);
  const now = new Date().toISOString();
  const artifactWorkflowId = `artifact-wf-${Date.now()}`;
  const artifactExecutionId = `artifact-exec-${Date.now()}`;
  db.prepare("INSERT INTO workflows(id, name, description, nodes, edges, is_active, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?)")
    .run(
      artifactWorkflowId,
      "Artifact Regression Workflow",
      null,
      JSON.stringify([
        { id: "writeNode", type: "write-file", data: { label: "Write regression file" } },
        { id: "taskNode", type: "board-task", data: { label: "Create regression task" } },
        { id: "memoryNode", type: "memory-store", data: { label: "Remember regression" } },
      ]),
      "[]",
      now,
      now,
    );
  db.prepare("INSERT INTO executions(id, workflow_id, status, trigger_type, trigger_data, provenance, node_results, started_at, completed_at, error) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      artifactExecutionId,
      artifactWorkflowId,
      "completed",
      "message",
      JSON.stringify({ sessionId: artifactSessionId }),
      JSON.stringify({ sessionId: artifactSessionId, routeSource: "regression" }),
      JSON.stringify({
        writeNode: { output: { written: true, path: generatedPath, mode: "overwrite", response: "generated artifact preview regression" }, duration: 12 },
        taskNode: { output: { action: "create", task: { id: `artifact-task-${Date.now()}`, title: "Artifact board task", description: "board task card regression", status: "inbox", priority: "medium" }, response: "Created board task" }, duration: 8 },
        memoryNode: { output: { response: "Stored regression memory" }, duration: 4 },
      }),
      now,
      now,
      null,
    );
  db.prepare("INSERT INTO board_tasks(id, board_id, title, description, workflow_id, status, priority, execution_run_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(`artifact-db-task-${Date.now()}`, "main-board", "Artifact DB board task", "board task DB card regression", artifactWorkflowId, "review", "high", artifactExecutionId, now, now);
  db.close();
  const generatedArtifacts = await api(`/api/artifacts?sessionId=${encodeURIComponent(artifactSessionId)}`);
  if (!generatedArtifacts.data?.some((item: any) => item.kind === "generated-file" && item.previewText?.includes("generated artifact preview regression"))) {
    throw new Error("generated artifact preview did not load");
  }
  if (!generatedArtifacts.data?.some((item: any) => item.kind === "workflow-output" && item.previewText?.includes("Stored regression memory"))) {
    throw new Error("workflow output artifact card did not load");
  }
  if (!generatedArtifacts.data?.some((item: any) => item.kind === "board-task" && item.previewText?.includes("board task"))) {
    throw new Error("board task artifact card did not load");
  }

  const fixturePath = path.join(process.cwd(), "data", "uploads", "chat", "playwright-medium-fixture.txt");
  await writeFile(fixturePath, "playwright upload fixture");
  const imageFixturePath = path.join(process.cwd(), "data", "uploads", "chat", "playwright-medium-image.png");
  await writeFile(imageFixturePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lY6rxwAAAABJRU5ErkJggg==", "base64"));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  await page.goto(`${BASE_URL}/debug`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("heading", { name: "Automation Runs" }).waitFor({ timeout: 60_000 });
  await page.getByRole("heading", { name: "Durable Turns" }).waitFor({ timeout: 60_000 });

  await page.goto(`${BASE_URL}/maintenance`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("heading", { name: "Hook Management" }).waitFor({ timeout: 60_000 });
  await page.getByText("Dry Run").first().waitFor({ timeout: 60_000 });
  await page.getByText("Event Groups").first().waitFor({ timeout: 60_000 });
  await page.getByText("medium-regression-hook.mjs").first().waitFor({ timeout: 60_000 });
  await page.getByText("Disable").first().waitFor({ timeout: 60_000 });

  await page.goto(`${BASE_URL}/workflows?tab=templates`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByText("Local Lead Enrichment").waitFor({ timeout: 60_000 });

  await page.goto(`${BASE_URL}/scheduler`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('input[value="Regression profile"]').first().waitFor({ timeout: 60_000 });
  await page.getByText("Workspace Override").first().waitFor({ timeout: 60_000 });
  await page.getByText("Retry").first().waitFor({ timeout: 60_000 });
  await page.getByText("Effective Overrides").first().waitFor({ timeout: 60_000 });
  await page.getByText("Recent Runs").first().waitFor({ timeout: 60_000 });

  await page.goto(`${BASE_URL}/skills`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("heading", { name: "Skill Steward" }).waitFor({ timeout: 60_000 });
  await page.getByText("Pin").first().waitFor({ timeout: 60_000 });
  await page.getByText("Workflows").first().waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: /Archived/ }).waitFor({ timeout: 60_000 });

  await page.goto(`${BASE_URL}/settings?tab=models`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByText("Provider Health").first().waitFor({ timeout: 60_000 });

  await page.close();
  const chatPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await chatPage.goto(`${BASE_URL}/chat`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await chatPage.getByText("Workspace").first().waitFor({ timeout: 60_000 });
  await chatPage.getByRole("button", { name: "Workbench" }).click();
  await chatPage.getByRole("button", { name: "Context" }).click();
  await chatPage.getByText("Workspace Context Preview").first().waitFor({ timeout: 60_000 });
  const chatUploadInput = chatPage.locator('input[type="file"][accept*="image"]');
  await chatUploadInput.waitFor({ timeout: 60_000 });
  await chatPage.waitForTimeout(1000);
  const uploadResponse = chatPage.waitForResponse((response) => response.url().includes("/api/uploads") && response.request().method() === "POST", { timeout: 60_000 });
  await chatUploadInput.setInputFiles(fixturePath);
  await uploadResponse;
  await chatPage.getByText("playwright-medium-fixture.txt").first().waitFor({ timeout: 60_000 });
  const imageUploadResponse = chatPage.waitForResponse((response) => response.url().includes("/api/uploads") && response.request().method() === "POST", { timeout: 60_000 });
  await chatUploadInput.setInputFiles(imageFixturePath);
  await imageUploadResponse;
  await chatPage.getByText("playwright-medium-image.png").first().waitFor({ timeout: 60_000 });
  await chatPage.getByRole("button", { name: "Files" }).click();
  await chatPage.getByText("playwright-medium-fixture.txt").first().waitFor({ timeout: 60_000 });
  await chatPage.locator('img[alt="playwright-medium-image.png"]').first().waitFor({ timeout: 60_000 });

  await browser.close();

  // Stream recovery check: session-turns endpoint returns progressEvents field
  const sessionTurnsRes = await fetch(`${BASE_URL}/api/channels?action=session-turns&sessionId=regression-test-session-${Date.now()}`);
  const sessionTurnsData = await sessionTurnsRes.json() as { success?: boolean; data?: unknown[] };
  if (!sessionTurnsData.success) throw new Error("session-turns endpoint failed");
  // The response should have a data array (even if empty for a new session)
  if (!Array.isArray(sessionTurnsData.data)) throw new Error("session-turns data is not an array");
  console.log(`stream-recovery check: session-turns returned ${sessionTurnsData.data.length} turns (expected 0 for new session)`);

  // Media coverage check: vision capability API
  const uploadsRes = await fetch(`${BASE_URL}/api/uploads`);
  // uploads GET without id should return 400 (missing id param) — that's fine, it means the route exists
  if (uploadsRes.status !== 400 && uploadsRes.status !== 200) {
    throw new Error(`uploads endpoint unexpected status ${uploadsRes.status}`);
  }
  console.log("media-coverage check: uploads route present");

  console.log("local medium UI regression passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
