import { getDiscordStatus } from "@/lib/channels/discord";
import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const discordRuntime: ExtensionRuntimeModule = {
  getPromptContext() {
    return [
      "Discord guidance:",
      "- Prefer concise replies and channel-safe formatting for Discord delivery.",
      "- Use Discord for fast operational updates and short approval loops.",
    ].join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+discord\s+extension\s+status$/i.test(message.trim())) return null;
    const status = getDiscordStatus();
    return [
      "Discord",
      `Connected: ${status.connected ? "yes" : "no"}`,
      `Bot: ${status.username || "n/a"}`,
    ].join("\n");
  },
  getStatus() {
    return getDiscordStatus();
  },
};

export default discordRuntime;
