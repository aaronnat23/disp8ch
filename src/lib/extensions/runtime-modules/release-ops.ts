import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const releaseOpsRuntime: ExtensionRuntimeModule = {
  getPromptContext(context) {
    const channel = String(context.config.defaultReleaseChannel || "stable").trim() || "stable";
    return [
      "Release operations guidance:",
      `- Default release channel: ${channel}.`,
      "- Prefer clear go/no-go criteria, rollback notes, and owner assignments.",
    ].join("\n");
  },
  handleCommand(message, context) {
    if (!/^show\s+release(?:-ops)?\s+extension\s+status$/i.test(message.trim())) return null;
    return [
      "Release Ops",
      `Default channel: ${String(context.config.defaultReleaseChannel || "stable")}`,
      `Checklist bias: ${context.config.requireChecklist === false ? "optional" : "required"}`,
    ].join("\n");
  },
  getStatus() {
    return {
      available: true,
      mode: "guidance",
    };
  },
};

export default releaseOpsRuntime;
