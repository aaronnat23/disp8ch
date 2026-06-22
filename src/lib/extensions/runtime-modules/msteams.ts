import { getTeamsStatus } from "@/lib/channels/teams";
import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const msTeamsRuntime: ExtensionRuntimeModule = {
  getPromptContext() {
    return [
      "Microsoft Teams guidance:",
      "- Keep Teams delivery structured and concise for thread-based operational follow-up.",
      "- Prefer Teams for internal handoff summaries, rollout notices, and approval nudges.",
    ].join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+(?:msteams|teams)\s+extension\s+status$/i.test(message.trim())) return null;
    const status = getTeamsStatus();
    return [
      "Microsoft Teams",
      `Configured: ${status.configured ? "yes" : "no"}`,
      `App ID: ${status.appId || "n/a"}`,
    ].join("\n");
  },
  getStatus() {
    return getTeamsStatus();
  },
};

export default msTeamsRuntime;
