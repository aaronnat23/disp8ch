#!/usr/bin/env tsx
/** MCP security posture regression: open/guarded/strict → effective approval mode. */
import { resolveEffectiveApprovalMode } from "@/lib/mcp/posture";
import type { MCPApprovalMode } from "@/lib/mcp/client";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}
const M = (m: string) => m as MCPApprovalMode;

// open: everything executes directly (no approval), scope still enforced elsewhere.
check("open.humanBecomesOff", resolveEffectiveApprovalMode(M("human"), true, "open") === "off");
check("open.modelBecomesOff", resolveEffectiveApprovalMode(M("model"), false, "open") === "off");
check("open.offStaysOff", resolveEffectiveApprovalMode(M("off"), null, "open") === "off");

// guarded: honor per-tool config exactly.
check("guarded.keepsHuman", resolveEffectiveApprovalMode(M("human"), true, "guarded") === "human");
check("guarded.keepsModel", resolveEffectiveApprovalMode(M("model"), true, "guarded") === "model");
check("guarded.keepsOff", resolveEffectiveApprovalMode(M("off"), true, "guarded") === "off");

// strict: any non-read-only requires human; read-only keeps its mode.
check("strict.writeForcesHuman", resolveEffectiveApprovalMode(M("off"), false, "strict") === "human");
check("strict.unknownForcesHuman", resolveEffectiveApprovalMode(M("off"), null, "strict") === "human");
check("strict.readonlyKeepsOff", resolveEffectiveApprovalMode(M("off"), true, "strict") === "off");
check("strict.readonlyKeepsModel", resolveEffectiveApprovalMode(M("model"), true, "strict") === "model");
check("strict.writeModelForcesHuman", resolveEffectiveApprovalMode(M("model"), false, "strict") === "human");

const failed = results.filter((r) => !r.ok);
console.log(`\nmcp-posture-regression: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error("Failed:", failed.map((r) => r.name).join(", "));
  process.exit(1);
}
