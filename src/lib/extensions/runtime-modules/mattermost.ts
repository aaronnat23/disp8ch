import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

function isConfigured(): boolean {
  return Boolean(String(process.env.MATTERMOST_WEBHOOK_URL || process.env.MATTERMOST_BOT_TOKEN || "").trim());
}

const mattermostRuntime: ExtensionRuntimeModule = {
  getPromptContext() {
    return [
      "Mattermost guidance:",
      "- Prefer concise operational replies that work in self-hosted team environments.",
      "- Use plain structure and explicit next actions over long narrative updates.",
    ].join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+mattermost\s+extension\s+status$/i.test(message.trim())) return null;
    return [
      "Mattermost",
      `Configured: ${isConfigured() ? "yes" : "no"}`,
      "Mode: prompt/runtime guidance",
    ].join("\n");
  },
  getStatus() {
    return {
      configured: isConfigured(),
      mode: "guidance",
    };
  },
};

export default mattermostRuntime;
