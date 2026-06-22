import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const codingRuntime: ExtensionRuntimeModule = {
  getPromptContext(context) {
    const lang = String(context.config.preferredLanguage || "auto");
    const maxIter = Number(context.config.maxRepairIterations) || 5;
    const requireTests = context.config.requireTests === true;
    const lines = [
      "Coding Agent guidance:",
      `- Preferred language: ${lang === "auto" ? "infer from context" : lang}.`,
      `- Self-healing loop limit: ${maxIter} repair iterations before reporting failure.`,
    ];
    if (requireTests) {
      lines.push("- Always generate unit tests alongside implementation code.");
    }
    lines.push("- State a brief plan comment before each generated code block.");
    lines.push("- On error: read stderr/stdout carefully, diagnose root cause, then patch precisely.");
    return lines.join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+coding\s+extension\s+status$/i.test(message.trim())) return null;
    return [
      "Coding Agent",
      "Status: active",
      "Self-healing: enabled",
      "Supported: TypeScript, Python, JavaScript, Go, Rust",
    ].join("\n");
  },
  getStatus() {
    return {
      active: true,
      supportedLanguages: ["typescript", "python", "javascript", "go", "rust"],
      selfHealing: true,
    };
  },
};

export default codingRuntime;
