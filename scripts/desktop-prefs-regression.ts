#!/usr/bin/env tsx
/**
 * Phase 5 regression: desktop-only agent/model preferences must layer over
 * runtime records without mutating them (no agent execution-policy changes).
 */
import { mergeAgentView, type AgentDesktopPreference } from "../src/lib/commands/desktop-prefs";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

const agent = Object.freeze({ id: "agent-1", model: "deepseek-v4-flash", tools: ["read"], budget: 100 });
const prefs: Record<string, AgentDesktopPreference> = { "agent-1": { layout: "developer", notify: false } };

const view = mergeAgentView(agent, prefs);
check("merge.attachesDesktopPref", view.desktop.layout === "developer" && view.desktop.notify === false);
check("merge.preservesRuntimeFields", view.model === "deepseek-v4-flash" && view.budget === 100);
check("merge.doesNotMutateRuntime", !("desktop" in agent));
check("merge.runtimeStillFrozenIntact", JSON.stringify(agent) === JSON.stringify({ id: "agent-1", model: "deepseek-v4-flash", tools: ["read"], budget: 100 }));

const noPref = mergeAgentView({ id: "agent-2", model: "x" }, prefs);
check("merge.emptyWhenNoPref", Object.keys(noPref.desktop).length === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\ndesktop-prefs-regression: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error("Failed:", failed.map((r) => r.name).join(", "));
  process.exit(1);
}
