/**
 * Guided automation setup regression (no DB, no server).
 *
 * Guards cadence→cron conversion (daily/weekdays/weekly/interval/one-time/
 * advanced + local time + timezone) and that each guided kind builds a valid,
 * connected workflow from generic nodes with a cron-trigger.
 *
 * Run: pnpm exec tsx scripts/automation-guided-setup-regression.ts
 */
import {
  buildGuidedAutomationWorkflow,
  cadenceToCron,
  GuidedAutomationError,
  validateGuidedDefinition,
  type GuidedAutomationDefinition,
} from "../src/lib/automations/guided-setup";

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

const base: GuidedAutomationDefinition = {
  title: "Daily Brief",
  kind: "briefing",
  cadence: "daily",
  time: "08:30",
  timezone: "America/New_York",
  task: "Summarize overnight activity.",
  deliveryChannel: "webchat",
};

console.log("\nCadence → cron");
check("daily", cadenceToCron({ ...base, cadence: "daily" }).expression === "30 8 * * *");
check("daily carries timezone (DST-aware via croner)", cadenceToCron({ ...base, cadence: "daily" }).timezone === "America/New_York");
check("weekdays", cadenceToCron({ ...base, cadence: "weekdays" }).expression === "30 8 * * 1-5");
check("weekly (Friday)", cadenceToCron({ ...base, cadence: "weekly", weekday: 5 }).expression === "30 8 * * 5");
check("interval 30m", cadenceToCron({ ...base, cadence: "interval", intervalMinutes: 30 }).expression === "*/30 * * * *");
check("interval 2h", cadenceToCron({ ...base, cadence: "interval", intervalMinutes: 120 }).expression === "0 */2 * * *");
check("interval 24h collapses to daily", cadenceToCron({ ...base, cadence: "interval", intervalMinutes: 1440 }).expression === "30 8 * * *");
check("one-time uses date", cadenceToCron({ ...base, cadence: "one-time", date: "2026-07-04", time: "09:15" }).expression === "15 9 4 7 *");
check("advanced passes through", cadenceToCron({ ...base, cadence: "advanced", advancedCron: "*/5 * * * *" }).expression === "*/5 * * * *");
check("midnight time", cadenceToCron({ ...base, time: "00:00" }).expression === "0 0 * * *");

console.log("\nValidation");
check("missing title rejected", (() => { try { validateGuidedDefinition({ ...base, title: "" }); return false; } catch (e) { return e instanceof GuidedAutomationError; } })());
check("scheduled-workflow needs target", (() => { try { validateGuidedDefinition({ ...base, kind: "scheduled-workflow", targetWorkflowId: "" }); return false; } catch (e) { return e instanceof GuidedAutomationError; } })());
check("briefing needs task", (() => { try { validateGuidedDefinition({ ...base, kind: "briefing", task: "" }); return false; } catch (e) { return e instanceof GuidedAutomationError; } })());
check("bad time rejected", (() => { try { validateGuidedDefinition({ ...base, time: "8am" }); return false; } catch (e) { return e instanceof GuidedAutomationError; } })());
check("out-of-range time rejected", (() => { try { validateGuidedDefinition({ ...base, time: "99:99" }); return false; } catch (e) { return e instanceof GuidedAutomationError; } })());
check("interval needs minutes", (() => { try { validateGuidedDefinition({ ...base, cadence: "interval", intervalMinutes: 0 }); return false; } catch (e) { return e instanceof GuidedAutomationError; } })());
check("inexact cron interval rejected", (() => { try { validateGuidedDefinition({ ...base, cadence: "interval", intervalMinutes: 90 }); return false; } catch (e) { return e instanceof GuidedAutomationError; } })());
check("invalid timezone rejected", (() => { try { validateGuidedDefinition({ ...base, timezone: "Not/A_Timezone" }); return false; } catch (e) { return e instanceof GuidedAutomationError; } })());
check("invalid advanced cron rejected", (() => { try { validateGuidedDefinition({ ...base, cadence: "advanced", advancedCron: "not cron" }); return false; } catch (e) { return e instanceof GuidedAutomationError; } })());
check("one-time requires a real date", (() => { try { validateGuidedDefinition({ ...base, cadence: "one-time", date: "2026-02-31" }); return false; } catch (e) { return e instanceof GuidedAutomationError; } })());
check("external delivery requires a destination", (() => { try { validateGuidedDefinition({ ...base, deliveryChannel: "telegram" }); return false; } catch (e) { return e instanceof GuidedAutomationError; } })());

function graphValid(def: GuidedAutomationDefinition): boolean {
  const wf = buildGuidedAutomationWorkflow(def);
  const ids = new Set(wf.nodes.map((nn) => nn.id));
  const hasTrigger = wf.nodes.some((nn) => nn.type.includes("trigger"));
  const hasCron = wf.nodes.some((nn) => nn.type === "cron-trigger" && typeof nn.data.expression === "string");
  const edgesOk = wf.edges.every((ed) => ids.has(ed.source) && ids.has(ed.target));
  const inbound = new Set(wf.edges.map((ed) => ed.target));
  const noOrphans = wf.nodes.every((nn) => nn.type.includes("trigger") || inbound.has(nn.id));
  return hasTrigger && hasCron && edgesOk && noOrphans && ids.size > 0;
}

console.log("\nEach kind builds a valid, connected workflow");
check("briefing graph valid + has cron-trigger", graphValid({ ...base, kind: "briefing" }));
check("scheduled-workflow graph valid", graphValid({ ...base, kind: "scheduled-workflow", targetWorkflowId: "wf-target" }));
check("health-check graph valid", graphValid({ ...base, kind: "health-check" }));
check("health-check has an if-else alert gate", buildGuidedAutomationWorkflow({ ...base, kind: "health-check" }).nodes.some((nn) => nn.type === "if-else"));
check("guided workflows use only generic node types", buildGuidedAutomationWorkflow({ ...base, kind: "briefing" }).nodes.every((nn) => nn.type !== "guided-automation"));
{
  const telegram = buildGuidedAutomationWorkflow({ ...base, deliveryChannel: "telegram", deliveryTarget: "123456" });
  const delivery = telegram.nodes.find((nn) => nn.type === "send-telegram");
  check("external destination is wired into the send node", delivery?.data.to === "123456");
}

console.log(`\n${"─".repeat(50)}`);
console.log(`automation-guided-setup-regression: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Failed cases:", failures.join(", "));
  process.exit(1);
}
console.log("All guided automation setup tests passed.");
process.exit(0);
