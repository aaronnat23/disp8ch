import { readTelemetryStats } from "@/lib/telemetry";
import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const diagnosticsOtelRuntime: ExtensionRuntimeModule = {
  getPromptContext(context) {
    const hours = Number(context.config.windowHours ?? 24);
    return [
      "Diagnostics guidance:",
      `- Use telemetry and activity signals before making claims about runtime health.`,
      `- Prefer the last ${Number.isFinite(hours) ? hours : 24} hours of events when summarizing operational state.`,
    ].join("\n");
  },
  handleCommand(message, context) {
    if (!/^show\s+diagnostics(?:-otel)?\s+extension\s+status$/i.test(message.trim())) return null;
    const hours = Math.max(1, Math.min(24 * 30, Number(context.config.windowHours ?? 24) || 24));
    const stats = readTelemetryStats(hours);
    const topTypes = Object.entries(stats.byType)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)
      .map(([type, count]) => `${type}=${count}`)
      .join(", ");
    return [
      "Diagnostics OTel",
      `Window: ${stats.windowHours}h`,
      `Events: ${stats.totalEvents}`,
      `Top types: ${topTypes || "none"}`,
    ].join("\n");
  },
  getStatus() {
    const stats = readTelemetryStats(24);
    return {
      windowHours: stats.windowHours,
      totalEvents: stats.totalEvents,
      byType: stats.byType,
    };
  },
};

export default diagnosticsOtelRuntime;
