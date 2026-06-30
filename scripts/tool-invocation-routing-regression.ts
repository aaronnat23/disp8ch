#!/usr/bin/env tsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-tool-routing-"));
process.env.DATABASE_PATH = path.join(tempDir, "routing.db");
process.env.MEMORY_VECTOR_DB_PATH = path.join(tempDir, "vectors.db");
for (const key of [
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
]) {
  process.env[key] = "";
}

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const checks: Check[] = [];

function check(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} :: ${detail}`);
}

async function main() {
  const { initializeDatabase } = await import("../src/lib/db");
  const { routeToWorkflowWithDetails } = await import("../src/lib/channels/router");
  const { resolveExplicitWorkflowNoMatchText } = await import("../src/lib/channels/fallback-assistant");
  initializeDatabase();

  async function route(message: string) {
    return routeToWorkflowWithDetails({
      triggerNodeType: "message-trigger",
      channel: "webchat",
      triggerData: {
        sender: "tool-routing-regression",
        sessionKey: `tool-routing-${checks.length}`,
        message,
        timestamp: new Date().toISOString(),
      },
    });
  }

  const exactTool = await route("use the fetch_url tool to read https://example.com");
  check(
    "exact tool name is not parsed as a workflow",
    exactTool.source === "none" && !exactTool.response,
    `source=${exactTool.source} response=${String(exactTool.response || "").slice(0, 160)}`,
  );

  const naturalToolFamily = await route(
    "Use the browser navigation tools, not search snippets alone, to open https://example.com and report the heading.",
  );
  check(
    "natural browser tool family reaches the agent tool loop",
    naturalToolFamily.source === "none" && !naturalToolFamily.response,
    `source=${naturalToolFamily.source} response=${String(naturalToolFamily.response || "").slice(0, 160)}`,
  );
  check(
    "fallback assistant does not reclassify natural browser tools as a workflow",
    resolveExplicitWorkflowNoMatchText({
      rawMessage:
        "Use the browser navigation tools, not search snippets alone, to open https://example.com and report the heading.",
      routed: naturalToolFamily,
    }) === null,
    "natural browser-tool request remains eligible for the agent tool loop",
  );

  const missingWorkflow = await route("use FakeWorkflowXYZ to do the thing");
  check(
    "real missing workflow reference still reports no match",
    /no active workflow matched/i.test(String(missingWorkflow.response || "")),
    `source=${missingWorkflow.source} response=${String(missingWorkflow.response || "").slice(0, 160)}`,
  );

  const failed = checks.filter((item) => !item.passed);
  console.log(`\ntool-invocation-routing-regression: ${checks.length - failed.length}/${checks.length} checks passed`);
  const { getSqlite } = await import("../src/lib/db");
  getSqlite().close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
