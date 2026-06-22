import { getSlackStatus } from "@/lib/channels/slack";
import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const slackRuntime: ExtensionRuntimeModule = {
  getPromptContext(context) {
    const suggestBlocks = context.config.suggestBlocks === true;
    return [
      "Slack guidance:",
      "- Prefer concise delivery with clear sectioning for Slack channels.",
      suggestBlocks
        ? "- When a message needs structure, prefer block-style sectioning and bullets."
        : "- Use plain text unless the user explicitly needs more structured Slack formatting.",
    ].join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+slack\s+extension\s+status$/i.test(message.trim())) return null;
    const status = getSlackStatus();
    return [
      "Slack",
      `Connected: ${status.connected ? "yes" : "no"}`,
      `Bot: ${status.botName || "n/a"}`,
    ].join("\n");
  },
  getStatus() {
    return getSlackStatus();
  },
};

export default slackRuntime;
