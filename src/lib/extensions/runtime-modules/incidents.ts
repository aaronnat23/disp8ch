import { readTelemetryStats } from "@/lib/telemetry";
import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const incidentsRuntime: ExtensionRuntimeModule = {
  getPromptContext(context) {
    const severity = String(context.config.defaultSeverity || "sev-2").trim() || "sev-2";
    return [
      "Incident guidance:",
      `- Default severity framing: ${severity}.`,
      "- Prefer explicit incident commander, comms lead, and next checkpoint.",
    ].join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+incidents?\s+extension\s+status$/i.test(message.trim())) return null;
    const stats = readTelemetryStats(24);
    return [
      "Incidents",
      `24h events: ${stats.totalEvents}`,
      `workflow.failed: ${Number(stats.byType["workflow.failed"] || 0)}`,
    ].join("\n");
  },
  getStatus() {
    const stats = readTelemetryStats(24);
    return {
      windowHours: stats.windowHours,
      workflowFailed: Number(stats.byType["workflow.failed"] || 0),
      totalEvents: stats.totalEvents,
    };
  },
};

export default incidentsRuntime;
