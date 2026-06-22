import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const googleChatRuntime: ExtensionRuntimeModule = {
  getPromptContext() {
    return [
      "Google Chat guidance:",
      "- Keep messages thread-friendly and compact for room follow-ups.",
      "- Prefer decision summaries, rollout checkpoints, and short action lists.",
    ].join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+google\s*chat\s+extension\s+status$/i.test(message.trim())) return null;
    return [
      "Google Chat",
      "Route: /api/channels/google-chat",
      "Mode: webhook",
    ].join("\n");
  },
  getStatus() {
    return {
      configured: true,
      route: "/api/channels/google-chat",
      mode: "webhook",
    };
  },
};

export default googleChatRuntime;
