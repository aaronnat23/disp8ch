#!/usr/bin/env tsx
/**
 * Phase 2 regression: command registry filtering + rebindable shortcut helpers.
 */
import {
  filterCommands,
  getStaticCommands,
} from "../src/lib/commands/registry";
import {
  comboFromEvent,
  defaultBindings,
  detectConflicts,
  normalizeKeys,
} from "../src/lib/commands/shortcuts";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

const commands = getStaticCommands();
check("registry.hasCommands", commands.length > 20);
check("registry.uniqueIds", new Set(commands.map((c) => c.id)).size === commands.length);
check("registry.navHaveHref", commands.filter((c) => c.id.startsWith("nav.")).every((c) => !!c.href));

const wf = filterCommands(commands, "workflow");
check("filter.findsWorkflows", wf.some((c) => c.id === "nav.workflows"));
check("filter.empty returns capped", filterCommands(commands, "").length <= 12);
check("filter.keywordMatch", filterCommands(commands, "cron").some((c) => c.id === "nav.scheduler"));
check("filter.startsWithRanksFirst", filterCommands(commands, "settings")[0]?.id === "nav.settings");
check("filter.noMatch", filterCommands(commands, "zzzzznotacommand").length === 0);

check("normalize.cmdToMod", normalizeKeys("Cmd+K") === "mod+k");
check("normalize.ctrlToMod", normalizeKeys("Ctrl+K") === "mod+k");
check("normalize.orderStable", normalizeKeys("shift+mod+p") === "mod+shift+p");
check("normalize.dedupes", normalizeKeys("mod+mod+k") === "mod+k");

check(
  "combo.fromEvent",
  comboFromEvent({ key: "k", metaKey: true } as KeyboardEvent) === "mod+k",
);
check(
  "combo.withShift",
  comboFromEvent({ key: "N", ctrlKey: true, shiftKey: true } as KeyboardEvent) === "mod+shift+n",
);

const defaults = defaultBindings();
check("defaults.noConflicts", detectConflicts(defaults).length === 0);
check(
  "conflicts.detected",
  detectConflicts({ a: "mod+k", b: "Cmd+K" }).some((c) => c.keys === "mod+k" && c.ids.length === 2),
);

const failed = results.filter((r) => !r.ok);
console.log(`\ncommand-palette-shortcuts-regression: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error("Failed:", failed.map((r) => r.name).join(", "));
  process.exit(1);
}
