import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

function isConfigured(): boolean {
  return Boolean(String(process.env.MATRIX_HOMESERVER_URL || process.env.MATRIX_ACCESS_TOKEN || "").trim());
}

const matrixRuntime: ExtensionRuntimeModule = {
  getPromptContext() {
    return [
      "Matrix guidance:",
      "- Favor federation-safe plain structure and explicit room handoff context.",
      "- Keep action items easy to forward across rooms and bridges.",
    ].join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+matrix\s+extension\s+status$/i.test(message.trim())) return null;
    return [
      "Matrix",
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

export default matrixRuntime;
