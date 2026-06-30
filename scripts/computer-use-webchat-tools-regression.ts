#!/usr/bin/env tsx

/**
 * Computer-use WebChat/tool registry regression.
 *
 * Proves the Cua-backed computer tools are exposed through the normal agent
 * tool catalog and reuse the existing approval/effect machinery. This test
 * does not require a live Cua driver.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-computer-use-tools-"));
process.env.DATABASE_PATH = path.join(tempDir, "computer-use-tools.db");
process.env.MEMORY_VECTOR_DB_PATH = path.join(tempDir, "computer-use-vectors.db");
process.env.DISP8CH_ENABLE_COMPUTER_USE = "";
process.env.DISP8CH_CUA_DRIVER_CMD = "";

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
  const { initializeDatabase, getSqlite } = await import("../src/lib/db");
  const { COMPUTER_USE_TOOL_NAMES } = await import("../src/lib/computer-use/tools");
  const {
    TOOL_CATALOG,
    TOOL_LABELS,
    executeTool,
    executeToolWithConfirmation,
    listPendingApprovals,
    resolvePendingApproval,
    resolveAgentToolEffect,
  } = await import("../src/lib/engine/tools");
  const { executeToolForModel } = await import("../src/lib/agents/tool-caller");
  const { compactNativeObservationForModel, extractNativeWindowHint, shouldUseNativeObservationFastPath } = await import("../src/lib/channels/computer-observation-fast-path");
  const { resolveToolNamesFromToolsets } = await import("../src/lib/engine/toolsets");

  initializeDatabase();

  console.log("\n[1] Catalog and toolset exposure");
  const toolsetNames = resolveToolNamesFromToolsets(["computer_use"]);
  for (const toolName of COMPUTER_USE_TOOL_NAMES) {
    check(`${toolName} in TOOL_CATALOG`, Boolean(TOOL_CATALOG[toolName]));
    check(`${toolName} in TOOL_LABELS`, Boolean(TOOL_LABELS[toolName]));
    check(`${toolName} in computer_use toolset`, toolsetNames.includes(toolName));
  }

  console.log("\n[2] WebChat-facing allowlists");
  const sourceFiles = {
    intent: fs.readFileSync(path.join(process.cwd(), "src/lib/channels/webchat-intent.ts"), "utf8"),
    fallback: fs.readFileSync(path.join(process.cwd(), "src/lib/channels/fallback-assistant.ts"), "utf8"),
    router: fs.readFileSync(path.join(process.cwd(), "src/lib/channels/router.ts"), "utf8"),
    systemMap: fs.readFileSync(path.join(process.cwd(), "src/lib/channels/disp8ch-system-map.ts"), "utf8"),
    modelContext: fs.readFileSync(path.join(process.cwd(), "src/lib/channels/model-led-context.ts"), "utf8"),
    lanePolicy: fs.readFileSync(path.join(process.cwd(), "src/lib/channels/lane-tool-policy.ts"), "utf8"),
    toolCaller: fs.readFileSync(path.join(process.cwd(), "src/lib/agents/tool-caller.ts"), "utf8"),
    sanitizer: fs.readFileSync(path.join(process.cwd(), "src/lib/channels/final-answer-sanitizer.ts"), "utf8"),
    sideEffects: fs.readFileSync(path.join(process.cwd(), "src/lib/channels/side-effect-policy.ts"), "utf8"),
    driver: fs.readFileSync(path.join(process.cwd(), "src/lib/computer-use/cua-driver.ts"), "utf8"),
  };
  for (const toolName of COMPUTER_USE_TOOL_NAMES) {
    check(`${toolName} recognized by WebChat intent`, sourceFiles.intent.includes(`"${toolName}"`));
    check(`${toolName} recognized by WebChat router`, sourceFiles.router.includes(`"${toolName}"`));
    check(`${toolName} recognized by fallback assistant`, sourceFiles.fallback.includes(toolName));
    check(`${toolName} listed in system map`, sourceFiles.systemMap.includes(`"${toolName}"`));
  }
  for (const readOnlyTool of ["computer_observe", "computer_list_apps", "computer_zoom", "computer_wait"]) {
    check(`${readOnlyTool} is exposed to read-only model context`, sourceFiles.modelContext.includes(`"${readOnlyTool}"`));
    check(`${readOnlyTool} is exposed to universal read-only policy`, sourceFiles.lanePolicy.includes(`"${readOnlyTool}"`));
    check(`${readOnlyTool} is allowed by model tool-caller read-only guard`, sourceFiles.toolCaller.includes(`"${readOnlyTool}"`));
  }
  for (const mutationTool of ["computer_launch_app", "computer_focus_app", "computer_click", "computer_type", "computer_set_value", "computer_hotkey", "computer_scroll", "computer_drag", "computer_stop"]) {
    check(`${mutationTool} is marked mutating`, sourceFiles.sideEffects.includes(`"${mutationTool}"`));
  }
  check("computer tool traces are sanitized", /computer_\[a-z_\]\+|computer_\[a-z_\]\+/.test(sourceFiles.sanitizer) || sourceFiles.sanitizer.includes("computer_[a-z_]+"));
  check("driver uses current Cua named tool calls", sourceFiles.driver.includes('"call", tool') && sourceFiles.driver.includes('"get_window_state"') && sourceFiles.driver.includes('"list_windows"'));
  check("driver no longer uses obsolete action command", !sourceFiles.driver.includes('"action", "--json"'));
  check("click schema exposes Cua pid", Boolean((TOOL_CATALOG.computer_click.parameters as any).properties.pid));
  check("type schema exposes Cua window_id", Boolean((TOOL_CATALOG.computer_type.parameters as any).properties.window_id));
  check("scroll schema exposes Cua direction", Boolean((TOOL_CATALOG.computer_scroll.parameters as any).properties.direction));
  check("native window title is parsed generically", extractNativeWindowHint('Inspect the window titled "Quarterly Review".') === "Quarterly Review");
  check("read-only titled-window inspection uses bounded fast path", shouldUseNativeObservationFastPath({ message: 'Inspect the window titled "Quarterly Review" read-only.', mode: "computer_use", safetyBoundary: "proposal_only" }));
  check("state-changing titled-window request stays in agent loop", !shouldUseNativeObservationFastPath({ message: 'Inspect the window titled "Quarterly Review" then type hello.', mode: "computer_use", safetyBoundary: "proposal_only" }));
  const compactObservation = compactNativeObservationForModel(JSON.stringify({ success: true, status: "executed", detail: 'Window title\nStatus READY\n{"mode":"som","screenshotPath":"private-path","elements":[1,2,3]}' }));
  check("fast-path evidence keeps readable UI text", compactObservation.includes("Status READY"));
  check("fast-path evidence drops redundant structured payload", !compactObservation.includes("private-path"));

  console.log("\n[3] Effect classification");
  const observeEffect = resolveAgentToolEffect("computer_observe", {});
  check("observe is read effect", observeEffect.kind === "read", JSON.stringify(observeEffect));
  const credentialEffect = resolveAgentToolEffect("computer_type", {
    text: "my password is hunter2",
    target: "Password field",
  });
  check("credential typing is high risk", credentialEffect.risk === "high", JSON.stringify(credentialEffect));

  console.log("\n[4] Approval gate before execution");
  const approval = await executeToolWithConfirmation(
    "computer_type",
    { text: "hello", target: "" },
    { approvalMode: "human" },
    { channelSessionId: "computer-use-webchat-regression" },
  );
  check("unknown-target typing queues human approval", /HUMAN APPROVAL REQUIRED/.test(approval), approval);
  check("approval mentions computer use reason", /Computer use:/i.test(approval), approval);

  const readOnlyApproval = await executeToolForModel(
    "computer_type",
    { text: "hello", target: "Account password", app_hint: "Settings" },
    {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      apiKey: "",
      channelSessionId: "computer-use-readonly-approval",
      readOnly: true,
    },
  );
  check("read-only WebChat hands risky computer action to approval", /HUMAN APPROVAL REQUIRED/.test(readOnlyApproval), readOnlyApproval);
  const queued = listPendingApprovals();
  const queuedForSession = queued.find((item) => item.channelSessionId === "computer-use-readonly-approval");
  check("queued approval retains WebChat session", Boolean(queuedForSession));
  for (const item of queued) await resolvePendingApproval({ id: item.id, decision: "deny" });

  console.log("\n[5] Disabled capability blocks observe honestly");
  const blocked = await executeTool(
    "computer_observe",
    {},
    { channelSessionId: "computer-use-webchat-regression" },
  );
  const parsed = JSON.parse(blocked);
  check("observe returns blocked when disabled", parsed.success === false && parsed.status === "blocked", blocked);
  check("blocked response reports implemented/configured/ready", parsed.capability?.implemented === true && parsed.capability?.ready === false, blocked);

  getSqlite().close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log(`\ncomputer-use-webchat-tools: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.error(error);
  process.exit(1);
});
