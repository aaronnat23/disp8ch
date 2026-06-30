#!/usr/bin/env tsx

import { spawnSync } from "node:child_process";

const scripts = [
  "desktop-hardening-regression.ts",
  "attention-center-regression.ts",
  "command-palette-shortcuts-regression.ts",
  "work-monitor-regression.ts",
  "pty-policy-regression.ts",
  "desktop-prefs-regression.ts",
  "deeplink-regression.ts",
  "release-notes-regression.ts",
  "final-synthesis-contract-regression.ts",
  "tool-markup-guard-regression.ts",
  "tool-invocation-routing-regression.ts",
  "agentic-no-shortcuts-regression.ts",
  "image-edit-provider-regression.ts",
  "image-edit-asset-regression.ts",
  "webchat-completion-notification-smoke.ts",
  "automation-guided-setup-regression.ts",
  "memory-atomic-operations-regression.ts",
  "api-auth-boundary-regression.ts",
  "skills-browser-preview-regression.ts",
  "background-subagents-activity-regression.ts",
  "provider-async-delegation-regression.ts",
  "continuation-fast-path-regression.ts",
  "simple-calculator-and-format-regression.ts",
  "research-department-vault-regression.ts",
  "research-department-output-contract-regression.ts",
  "research-department-template-regression.ts",
  "research-department-integration-regression.ts",
  "organization-capability-preset-regression.ts",
  "mcp-call-approval-regression.ts",
  "mcp-guardian-regression.ts",
  "mcp-posture-regression.ts",
  "model-fit-regression.ts",
  "model-fit-trust-advisory-calibration-regression.ts",
  "model-fit-v2-regression.ts",
  "workflow-node-connectivity-regression.ts",
  "workflow-template-catalog-regression.ts",
  "workflow-secret-redaction-regression.ts",
  "workflow-effect-classification-regression.ts",
  "workflow-effect-enforcement-regression.ts",
  "workflow-memory-scope-regression.ts",
  "memory-candidates-regression.ts",
  "learning-model-priority-regression.ts",
  "board-block-kinds-regression.ts",
  "board-block-recurrence-regression.ts",
  "board-block-human-loop-ui-smoke.ts",
  "source-pack-regression.ts",
  "source-skill-compiler-regression.ts",
  "source-skill-install-regression.ts",
  "learn-source-intent-regression.ts",
  "design-studio-recipe-regression.ts",
  "design-studio-reference-conversion-regression.ts",
  "design-studio-intake-ui-smoke.ts",
  "design-studio-element-editor-regression.ts",
  "design-studio-assistant-regression.ts",
  "computer-use-policy-regression.ts",
  "computer-use-webchat-tools-regression.ts",
  "computer-use-raw-control-regression.ts",
  "computer-use-doctor-regression.ts",
  "computer-use-session-store-regression.ts",
  "computer-use-capability-regression.ts",
  "computer-use-observe-fallback-regression.ts",
  "tool-evidence-verifier-regression.ts",
];

for (const script of scripts) {
  console.log(`\n=== ${script} ===`);
  const result = spawnSync(process.execPath, ["--import", "tsx", `scripts/${script}`], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    console.error(`\nRelease regression failed: ${script}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\nrelease-regression: ${scripts.length}/${scripts.length} suites passed`);
